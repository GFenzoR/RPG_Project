package gateway

import "time"

// RateLimit is the per-connection command limit (docs/05-network-protocol.md, "Límites").
// A token bucket of Burst tokens refills at PerSecond; a message without a token is
// dropped and adds to a debt, and a connection whose debt passes MaxDebt is
// disconnected. The debt is repaid by the same refill, so only sustained excess
// disconnects: at 31 msg/s a client is dropped after about MaxDebt seconds, at 60 msg/s
// after about Burst/30 + MaxDebt/30 seconds.
type RateLimit struct {
	PerSecond float64
	Burst     float64
	MaxDebt   float64
}

// DefaultRateLimit is 30 commands per second with a burst of 60.
var DefaultRateLimit = RateLimit{PerSecond: 30, Burst: 60, MaxDebt: 30}

type verdict uint8

const (
	allow verdict = iota
	drop
	abuse
)

// limiter is not safe for concurrent use: each connection's reader owns one.
type limiter struct {
	rl     RateLimit
	tokens float64 // negative = debt
	last   time.Time
}

func newLimiter(rl RateLimit, now time.Time) *limiter {
	return &limiter{rl: rl, tokens: rl.Burst, last: now}
}

func (l *limiter) take(now time.Time) verdict {
	if dt := now.Sub(l.last); dt > 0 {
		l.tokens = min(l.tokens+dt.Seconds()*l.rl.PerSecond, l.rl.Burst)
		l.last = now
	}
	l.tokens--
	switch {
	case l.tokens >= 0:
		return allow
	case -l.tokens > l.rl.MaxDebt:
		return abuse
	default:
		return drop
	}
}
