package httpapi

import (
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// RateLimit is a token bucket: Burst requests at once, refilled at one per Every.
type RateLimit struct {
	Burst int
	Every time.Duration
}

// DefaultAuthRateLimit allows 10 register/login attempts per IP, then one every 6 s.
var DefaultAuthRateLimit = RateLimit{Burst: 10, Every: 6 * time.Second}

// DefaultLoginEmailRateLimit allows 10 login attempts per email, then one every 30 s,
// whatever the IP: it slows credential stuffing spread over many addresses.
var DefaultLoginEmailRateLimit = RateLimit{Burst: 10, Every: 30 * time.Second}

// maxLimiterKeys bounds memory. At the cap, idle (full) buckets are dropped; if that
// frees less than a tenth of the map (many distinct keys mid-attack), the map is reset.
// A reset only forgives recent attempts, it never blocks anyone.
const maxLimiterKeys = 10000

type bucket struct {
	tokens float64
	last   time.Time
}

// limiter is a per-key token bucket limiter driven by the injected clock. It is shared
// by HTTP handler goroutines; it holds no game state, so the mutex is fine here.
type limiter struct {
	cfg   RateLimit
	clock clock.Clock

	mu      sync.Mutex
	buckets map[string]*bucket
}

func newLimiter(cfg RateLimit, clk clock.Clock) *limiter {
	return &limiter{cfg: cfg, clock: clk, buckets: map[string]*bucket{}}
}

// allow consumes one token for key and reports whether the request may proceed.
func (l *limiter) allow(key string) bool {
	now := l.clock.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= maxLimiterKeys {
			l.pruneLocked(now)
			if len(l.buckets) > maxLimiterKeys*9/10 {
				clear(l.buckets)
			}
		}
		b = &bucket{tokens: float64(l.cfg.Burst), last: now}
		l.buckets[key] = b
	}
	l.refill(b, now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (l *limiter) refill(b *bucket, now time.Time) {
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens = min(float64(l.cfg.Burst), b.tokens+float64(elapsed)/float64(l.cfg.Every))
		b.last = now
	}
}

// pruneLocked drops buckets that have refilled completely: forgetting them changes
// nothing, since a new bucket starts full.
func (l *limiter) pruneLocked(now time.Time) {
	for k, b := range l.buckets {
		l.refill(b, now)
		if b.tokens >= float64(l.cfg.Burst) {
			delete(l.buckets, k)
		}
	}
}
