package httpapi

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// RateLimit is a token bucket: Burst requests at once, refilled at one per Every.
type RateLimit struct {
	Burst int
	Every time.Duration
}

// Defaults (docs/05-network-protocol.md, "API HTTP").
var (
	// DefaultAuthRateLimit: register and login requests per client IP (IPv6: per /64).
	// Every request consumes, so cheap junk requests are throttled too.
	DefaultAuthRateLimit = RateLimit{Burst: 10, Every: 6 * time.Second}
	// DefaultLoginPairRateLimit: failed logins per (email, client IP) pair. Strict, and
	// an attacker on other IPs cannot drain it for the victim.
	DefaultLoginPairRateLimit = RateLimit{Burst: 5, Every: time.Minute}
	// DefaultLoginEmailRateLimit: failed logins per email from any IP. Loose (~30 per
	// hour): it only slows guessing distributed over many IPs.
	DefaultLoginEmailRateLimit = RateLimit{Burst: 30, Every: 2 * time.Minute}
)

// limiterSlots is the fixed size of every limiter table: 2^14 sets of limiterWays slots
// (24 B per slot, ~1.5 MiB per table).
const (
	limiterWays  = 4
	limiterSets  = 1 << 14
	limiterSlots = limiterSets * limiterWays
)

// bucket is one slot. tag identifies the key that owns it (0 = never used).
type bucket struct {
	tag    uint64
	tokens float64
	last   int64 // nanoseconds since the limiter's start; an int keeps the table pointer-free
}

// collisionPolicy says what to do when every slot of a key's set is owned by other keys
// whose buckets are still in use.
type collisionPolicy int

const (
	// failOpen lets the key through untracked. Used for the per-IP limit: filling the
	// table with drained buckets (cheap junk requests from many /64s) must not turn into
	// a denial of service for everyone else.
	failOpen collisionPolicy = iota
	// failClosed makes the key share the fullest slot of its set. Used for the
	// per-account login limits: only real password checks spend them, capped by the
	// argon2 slots, so an attacker can drain only a small fraction f of the slots and a
	// key is affected only if all limiterWays slots of its set are drained (about f^4).
	failClosed
)

// limiter is a token-bucket rate limiter over a fixed-size, set-associative table, so
// memory is bounded whatever the number of distinct keys. A key maps to one set of
// limiterWays slots and carries a 64-bit tag, both derived from HMAC-SHA256(key) under a
// random per-process secret: an attacker cannot pick keys that land on a victim's set.
//
// Two rules keep it safe:
//   - a key whose tag is in any slot of its set always uses that slot, so a drained
//     bucket is found again even when other slots of the set could be reclaimed;
//   - a slot changes owner only when unused or full again. Forgetting a full bucket
//     changes nothing (a new bucket starts full), so spraying keys never resets a limit.
//
// Time is measured as an offset from the limiter's start (monotonic with the real
// clock), and a bucket whose last refill lies in the future is rebased, so wall-clock
// jumps neither freeze buckets nor refill them all at once.
//
// It is shared by HTTP handler goroutines and holds no game state, so a mutex is fine.
type limiter struct {
	cfg    RateLimit
	policy collisionPolicy
	clock  clock.Clock
	start  time.Time
	secret [32]byte

	mu    sync.Mutex
	slots []bucket
}

func newLimiter(cfg RateLimit, policy collisionPolicy, clk clock.Clock) (*limiter, error) {
	l := &limiter{cfg: cfg, policy: policy, clock: clk, start: clk.Now(), slots: make([]bucket, limiterSlots)}
	if _, err := rand.Read(l.secret[:]); err != nil {
		return nil, fmt.Errorf("limiter secret: %w", err)
	}
	return l, nil
}

type slotRef struct {
	set int // index of the set's first slot
	tag uint64
}

// locate hashes key; it runs outside the mutex.
func (l *limiter) locate(key string) slotRef {
	m := hmac.New(sha256.New, l.secret[:])
	m.Write([]byte(key))
	sum := m.Sum(nil)
	return slotRef{
		set: int(binary.LittleEndian.Uint64(sum[0:8])%limiterSets) * limiterWays,
		tag: binary.LittleEndian.Uint64(sum[8:16]) | 1, // never 0
	}
}

// now returns the time elapsed since the limiter started.
func (l *limiter) now() int64 { return int64(l.clock.Now().Sub(l.start)) }

func (l *limiter) refill(b *bucket, now int64) {
	if b.tag == 0 {
		return
	}
	switch elapsed := now - b.last; {
	case elapsed > 0:
		b.tokens = min(float64(l.cfg.Burst), b.tokens+float64(elapsed)/float64(l.cfg.Every))
		b.last = now
	case elapsed < 0:
		b.last = now // the clock went back: refill normally from here instead of freezing
	}
}

// untracked is the slot index of a key let through without a bucket (failOpen).
const untracked = -1

// slotFor returns the index of key's bucket, claiming a free slot if needed, or
// untracked (failOpen collision). Caller holds mu.
func (l *limiter) slotFor(ref slotRef) int {
	now := l.now()
	set := l.slots[ref.set : ref.set+limiterWays]
	for i := range set {
		l.refill(&set[i], now)
	}
	for i := range set {
		if set[i].tag == ref.tag {
			return ref.set + i
		}
	}
	full := float64(l.cfg.Burst)
	for i := range set {
		if set[i].tag == 0 || set[i].tokens >= full {
			set[i] = bucket{tag: ref.tag, tokens: full, last: now}
			return ref.set + i
		}
	}
	if l.policy == failOpen {
		return untracked
	}
	best := 0
	for i := range set {
		if set[i].tokens > set[best].tokens {
			best = i
		}
	}
	return ref.set + best
}

// reservation is a token taken by allow; pass it to refund to give it back.
type reservation struct {
	slot int    // untracked if nothing was taken
	tag  uint64 // owner of the slot when charged
}

// allow consumes one token for key and reports whether the request may proceed. The
// reservation identifies the exact slot charged, for refund.
func (l *limiter) allow(key string) (bool, reservation) {
	ref := l.locate(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	i := l.slotFor(ref)
	if i == untracked {
		return true, reservation{slot: untracked}
	}
	b := &l.slots[i]
	if b.tokens < 1 {
		return false, reservation{slot: untracked}
	}
	b.tokens--
	return true, reservation{slot: i, tag: b.tag}
}

// refund gives back the token of r to the slot it was taken from (never above Burst).
// If the slot changed owner in between, the token is dropped rather than given to
// another key.
func (l *limiter) refund(r reservation) {
	if r.slot == untracked {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	b := &l.slots[r.slot]
	if b.tag != r.tag {
		return
	}
	b.tokens = min(float64(l.cfg.Burst), b.tokens+1)
}
