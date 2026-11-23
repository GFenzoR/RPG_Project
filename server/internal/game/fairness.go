package game

import (
	"errors"
	"sync/atomic"
)

// Fairness of the command queue (docs/01-architecture.md, "Equidad de la cola").
//
// The loop has one FIFO for every producer, so a single connection that enqueues as fast
// as it can would fill it and every other player's commands would be refused. Two rules
// keep one actor from starving the rest:
//
//   - each connection enqueues through its own Quota: at most Quota.Max of its commands
//     wait in the queue at once (the rest are refused at once, before the queue);
//   - logins, logouts and save acks (LifecycleFunc) go to a separate lane with its own
//     capacity, drained first every tick, so a full queue never refuses a Join or a
//     Leave. Commands that must keep their relative order go through the same lane.

// ErrQuotaExceeded is returned by Quota.Enqueue when the producer already has Max
// commands waiting.
var ErrQuotaExceeded = errors.New("game: producer command quota exceeded")

// DefaultLifecycleCapacity bounds the lifecycle lane (logins, logouts).
const DefaultLifecycleCapacity = 2048

// LifecycleFunc is a Command that starts or ends a player's session (Join, Leave and the
// login and save bookkeeping: LoginStarted, LoginAborted, Saved). Loop.Enqueue puts it in the lifecycle lane instead of the shared
// queue: lifecycle commands run before the other queued commands of the same tick.
type LifecycleFunc func(ctx *TickContext)

// Execute calls f(ctx).
func (f LifecycleFunc) Execute(ctx *TickContext) { f(ctx) }

// Enqueuer is what a Quota enqueues to. *Loop implements it.
type Enqueuer interface {
	Enqueue(cmd Command) error
}

// Quota bounds how many commands of one producer (a connection) wait in the queue. It
// is safe for concurrent use: the producer takes a unit when it enqueues and the loop
// gives it back when the command runs.
type Quota struct {
	max     int32
	pending atomic.Int32
}

// NewQuota returns a Quota of n pending commands (at least 1).
func NewQuota(n int) *Quota {
	return &Quota{max: int32(min(max(n, 1), 1<<30))}
}

// Pending returns how many commands of the producer are waiting.
func (q *Quota) Pending() int { return int(q.pending.Load()) }

// Enqueue enqueues cmd to l unless the producer already has Max commands waiting
// (ErrQuotaExceeded) or l refuses it (its error).
func (q *Quota) Enqueue(l Enqueuer, cmd Command) error {
	if cmd == nil {
		return errors.New("game: nil command")
	}
	if q.pending.Add(1) > q.max {
		q.pending.Add(-1)
		return ErrQuotaExceeded
	}
	if err := l.Enqueue(quotaCommand{q: q, cmd: cmd}); err != nil {
		q.pending.Add(-1)
		return err
	}
	return nil
}

// quotaCommand gives its unit back to the Quota when it runs.
type quotaCommand struct {
	q   *Quota
	cmd Command
}

func (c quotaCommand) Execute(ctx *TickContext) {
	c.q.pending.Add(-1) // first: a panicking command still frees its place
	c.cmd.Execute(ctx)
}

// unwrap returns the wrapped command (for the panic log).
func (c quotaCommand) unwrap() Command { return c.cmd }
