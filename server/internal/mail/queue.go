package mail

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// QueueConfig configures a Queue. Zero values take the defaults below.
type QueueConfig struct {
	Mailer Mailer
	Clock  clock.Clock
	Logger *slog.Logger
	// Size is how many messages may be in the queue at once, waiting retries included;
	// Enqueue fails when it is full. It bounds memory and goroutines.
	Size int // default 256
	// Backoff lists the waits before each retry; its length is the number of retries.
	Backoff []time.Duration // default 30 s, 2 min, 10 min
}

// Default queue settings.
var (
	DefaultQueueSize = 256
	DefaultBackoff   = []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute}
)

// queued is a message and how many deliveries it already failed.
type queued struct {
	m       Message
	attempt int
}

// ErrQueueFull is returned by Enqueue when Size messages are already waiting.
var ErrQueueFull = errors.New("mail: queue full")

// Queue delivers messages from one goroutine (Run), so a slow or failing SMTP server
// never blocks an HTTP handler, let alone the game loop. A message that fails waits for
// its retry outside that goroutine (one address that keeps failing never holds up the
// others) and is retried len(Backoff) times, then dropped (logged without its body).
type Queue struct {
	cfg QueueConfig
	log *slog.Logger
	ch  chan queued
	// pending counts the accepted messages not yet delivered or dropped (in the channel,
	// being sent or waiting for a retry). It never exceeds Size, so a retry always fits
	// back in the channel.
	pending atomic.Int64
	// sent is told about each finished message (tests); nil in production.
	sent func(Message, error)
}

// NewQueue validates cfg.
func NewQueue(cfg QueueConfig) (*Queue, error) {
	if cfg.Mailer == nil || cfg.Clock == nil {
		return nil, errors.New("mail: Mailer and Clock are required")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	if cfg.Size <= 0 {
		cfg.Size = DefaultQueueSize
	}
	if cfg.Backoff == nil {
		cfg.Backoff = DefaultBackoff
	}
	return &Queue{cfg: cfg, log: cfg.Logger, ch: make(chan queued, cfg.Size)}, nil
}

// Enqueue adds m without blocking; ErrQueueFull if the queue is full.
func (q *Queue) Enqueue(m Message) error {
	if m.Date.IsZero() {
		m.Date = q.cfg.Clock.Now()
	}
	if q.pending.Add(1) > int64(q.cfg.Size) {
		q.pending.Add(-1)
		q.log.Warn("mail: queue full, message dropped", "subject", m.Subject)
		return ErrQueueFull
	}
	q.ch <- queued{m: m} // cannot block: pending <= Size = cap(ch)
	return nil
}

// Run delivers queued messages until ctx is done. Messages still waiting then are
// dropped: they are links the player can ask for again.
func (q *Queue) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case it := <-q.ch:
			if done, err := q.deliver(ctx, it); done {
				q.pending.Add(-1)
				if q.sent != nil {
					q.sent(it.m, err)
				}
			}
		}
	}
}

// deliver tries it once. On a temporary failure with retries left it schedules the retry
// and reports done = false.
func (q *Queue) deliver(ctx context.Context, it queued) (done bool, err error) {
	err = q.cfg.Mailer.Send(ctx, it.m)
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, ErrPermanent) && it.attempt < len(q.cfg.Backoff) {
		// The error comes from the SMTP client: no body or link in it.
		q.log.Warn("mail: send failed, will retry", "subject", it.m.Subject, "attempt", it.attempt+1, "err", err)
		wait := q.cfg.Clock.After(q.cfg.Backoff[it.attempt])
		it.attempt++
		go func() {
			select {
			case <-ctx.Done():
				q.pending.Add(-1)
			case <-wait:
				q.ch <- it // cannot block: it still counts in pending
			}
		}()
		return false, err
	}
	q.log.Error("mail: message dropped", "subject", it.m.Subject, "err", err)
	return true, fmt.Errorf("mail: %w", err)
}
