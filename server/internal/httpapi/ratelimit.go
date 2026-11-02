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

// limiterSlots is the fixed size of every limiter table (24 B per slot, ~1.5 MiB).
const limiterSlots = 1 << 16

// bucket is one slot. tag identifies the key that owns it (0 = never used).
type bucket struct {
	tag    uint64
	tokens float64
	last   int64 // unix nanoseconds; an int keeps the table pointer-free for the GC
}

// collisionPolicy says what to do when both candidate slots of a key are owned by other
// keys whose buckets are still in use.
type collisionPolicy int

const (
	// failOpen lets the key through untracked. Used for the per-IP limit: filling the
	// table with drained buckets (cheap junk requests from many /64s) must not turn into
	// a denial of service for everyone else.
	failOpen collisionPolicy = iota
	// failClosed makes the key share the fuller of its two slots. Used for the per-account
	// login limits, which are only spent by password checks and so cannot be flooded.
	failClosed
)

// limiter is a token-bucket rate limiter over a fixed-size table, so memory is bounded
// whatever the number of distinct keys. Each key has two candidate slots and a 64-bit
// tag, all derived from HMAC-SHA256(key) under a random per-process secret: an attacker
// cannot pick keys that land on a victim's slots.
//
// A slot changes owner only when its bucket is unused or full again: forgetting a full
// bucket changes nothing (a new bucket starts full), so a drained bucket can never be
// reset or evicted by spraying keys.
//
// It is shared by HTTP handler goroutines and holds no game state, so a mutex is fine.
type limiter struct {
	cfg    RateLimit
	policy collisionPolicy
	clock  clock.Clock
	secret [32]byte

	mu    sync.Mutex
	slots []bucket
}

func newLimiter(cfg RateLimit, policy collisionPolicy, clk clock.Clock) (*limiter, error) {
	l := &limiter{cfg: cfg, policy: policy, clock: clk, slots: make([]bucket, limiterSlots)}
	if _, err := rand.Read(l.secret[:]); err != nil {
		return nil, fmt.Errorf("limiter secret: %w", err)
	}
	return l, nil
}

type slotRef struct {
	i1, i2 int
	tag    uint64
}

// locate hashes key; it runs outside the mutex.
func (l *limiter) locate(key string) slotRef {
	m := hmac.New(sha256.New, l.secret[:])
	m.Write([]byte(key))
	sum := m.Sum(nil)
	return slotRef{
		i1:  int(binary.LittleEndian.Uint64(sum[0:8]) % limiterSlots),
		i2:  int(binary.LittleEndian.Uint64(sum[8:16]) % limiterSlots),
		tag: binary.LittleEndian.Uint64(sum[16:24]) | 1, // never 0
	}
}

func (l *limiter) refill(b *bucket, now int64) {
	if b.tag == 0 {
		return
	}
	if elapsed := now - b.last; elapsed > 0 {
		b.tokens = min(float64(l.cfg.Burst), b.tokens+float64(elapsed)/float64(l.cfg.Every))
		b.last = now
	}
}

// bucketFor returns key's bucket, claiming a free slot if needed, or nil if the key is
// untracked (failOpen collision). Caller holds mu.
func (l *limiter) bucketFor(ref slotRef) *bucket {
	now := l.clock.Now().UnixNano()
	b1, b2 := &l.slots[ref.i1], &l.slots[ref.i2]
	l.refill(b1, now)
	l.refill(b2, now)
	for _, b := range []*bucket{b1, b2} {
		if b.tag == ref.tag {
			return b
		}
	}
	full := float64(l.cfg.Burst)
	for _, b := range []*bucket{b1, b2} {
		if b.tag == 0 || b.tokens >= full {
			*b = bucket{tag: ref.tag, tokens: full, last: now}
			return b
		}
	}
	if l.policy == failOpen {
		return nil
	}
	if b2.tokens > b1.tokens {
		return b2
	}
	return b1
}

// allow consumes one token for key and reports whether the request may proceed.
func (l *limiter) allow(key string) bool {
	ref := l.locate(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.bucketFor(ref)
	if b == nil {
		return true
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// refund gives back a token taken by allow (never above Burst).
func (l *limiter) refund(key string) {
	ref := l.locate(key)
	l.mu.Lock()
	defer l.mu.Unlock()
	if b := l.bucketFor(ref); b != nil {
		b.tokens = min(float64(l.cfg.Burst), b.tokens+1)
	}
}
