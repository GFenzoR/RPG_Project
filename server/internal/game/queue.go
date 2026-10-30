package game

import "errors"

// ErrQueueFull is returned by Enqueue when the command queue has no room. Callers on the
// network side must not block the connection on it: drop the command or disconnect.
var ErrQueueFull = errors.New("game: command queue full")

// commandQueue is a bounded multi-producer, single-consumer queue of commands.
type commandQueue struct {
	ch chan Command
}

func newCommandQueue(capacity int) *commandQueue {
	return &commandQueue{ch: make(chan Command, capacity)}
}

// enqueue adds cmd without blocking. It is safe for concurrent use.
func (q *commandQueue) enqueue(cmd Command) error {
	select {
	case q.ch <- cmd:
		return nil
	default:
		return ErrQueueFull
	}
}

// drain executes up to limit queued commands in arrival order and returns how many ran.
// Commands beyond the limit stay queued for the next tick.
func (q *commandQueue) drain(ctx *TickContext, limit int) int {
	n := 0
	for n < limit {
		select {
		case cmd := <-q.ch:
			cmd.Execute(ctx)
			n++
		default:
			return n
		}
	}
	return n
}

func (q *commandQueue) len() int { return len(q.ch) }
