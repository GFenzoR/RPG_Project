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

// limiterSlots is the fixed size of every limiter table (about 2 MiB each).
const limiterSlots = 1 << 16

type bucket struct {
	tokens float64
	last   time.Time
	used   bool
}

// limiter is a token-bucket rate limiter over a fixed-size table. A key's slot is
// HMAC-SHA256(key) under a random per-process secret, so:
//   - memory is bounded no matter how many distinct keys (IPs, emails) arrive;
//   - no bucket is ever reset or evicted, so spraying keys cannot restore a drained
//     bucket;
//   - an attacker cannot choose keys that land on a victim's slot. Random collisions
//     only make two keys share a budget (fails closed, never open).
//
// It is shared by HTTP handler goroutines and holds no game state, so a mutex is fine.
type limiter struct {
	cfg    RateLimit
	clock  clock.Clock
	secret [32]byte

	mu    sync.Mutex
	slots []bucket
}

func newLimiter(cfg RateLimit, clk clock.Clock) (*limiter, error) {
	l := &limiter{cfg: cfg, clock: clk, slots: make([]bucket, limiterSlots)}
	if _, err := rand.Read(l.secret[:]); err != nil {
		return nil, fmt.Errorf("limiter secret: %w", err)
	}
	return l, nil
}

func (l *limiter) slot(key string) *bucket {
	m := hmac.New(sha256.New, l.secret[:])
	m.Write([]byte(key))
	sum := m.Sum(nil)
	return &l.slots[binary.LittleEndian.Uint64(sum)%limiterSlots]
}

// refilled returns the slot for key with its tokens brought up to now. Caller holds mu.
func (l *limiter) refilled(key string) *bucket {
	now := l.clock.Now()
	b := l.slot(key)
	if !b.used {
		*b = bucket{tokens: float64(l.cfg.Burst), last: now, used: true}
		return b
	}
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = min(float64(l.cfg.Burst), b.tokens+float64(elapsed)/float64(l.cfg.Every))
		b.last = now
	}
	return b
}

// allow consumes one token for key and reports whether the request may proceed.
func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.refilled(key)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// ready reports whether key has a token, without consuming it.
func (l *limiter) ready(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.refilled(key).tokens >= 1
}

// take consumes one token for key if there is one (used after a failed attempt).
func (l *limiter) take(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if b := l.refilled(key); b.tokens >= 1 {
		b.tokens--
	}
}
