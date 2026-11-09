package mail

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// QueueConfig configures a Queue. Zero values take the defaults below.
type QueueConfig struct {
	Mailer Mailer
	Clock  clock.Clock
	Logger *slog.Logger
	// Size is how many messages may wait; Enqueue fails when it is full.
	Size int // default 256
	// Backoff lists the waits before each retry; its length is the number of retries.
	Backoff []time.Duration // default 30 s, 2 min, 10 min
}

// Default queue settings.
var (
	DefaultQueueSize = 256
	DefaultBackoff   = []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute}
)

// ErrQueueFull is returned by Enqueue when Size messages are already waiting.
var ErrQueueFull = errors.New("mail: queue full")

// Queue delivers messages from one goroutine (Run), so a slow or failing SMTP server
// never blocks an HTTP handler, let alone the game loop. A message that keeps failing
// is retried len(Backoff) times and then dropped (logged without its body).
type Queue struct {
	cfg QueueConfig
	log *slog.Logger
	ch  chan Message
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
	return &Queue{cfg: cfg, log: cfg.Logger, ch: make(chan Message, cfg.Size)}, nil
}

// Enqueue adds m without blocking; ErrQueueFull if the queue is full.
func (q *Queue) Enqueue(m Message) error {
	if m.Date.IsZero() {
		m.Date = q.cfg.Clock.Now()
	}
	select {
	case q.ch <- m:
		return nil
	default:
		q.log.Warn("mail: queue full, message dropped", "subject", m.Subject)
		return ErrQueueFull
	}
}

// Run delivers queued messages until ctx is done. Messages still waiting then are
// dropped: they are links the player can ask for again.
func (q *Queue) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case m := <-q.ch:
			err := q.deliver(ctx, m)
			if q.sent != nil {
				q.sent(m, err)
			}
		}
	}
}

func (q *Queue) deliver(ctx context.Context, m Message) error {
	var err error
	for attempt := 0; ; attempt++ {
		err = q.cfg.Mailer.Send(ctx, m)
		if err == nil {
			return nil
		}
		if errors.Is(err, ErrPermanent) || attempt >= len(q.cfg.Backoff) {
			break
		}
		// The error comes from the SMTP client: no body or link in it.
		q.log.Warn("mail: send failed, will retry", "subject", m.Subject, "attempt", attempt+1, "err", err)
		select {
		case <-ctx.Done():
			return fmt.Errorf("mail: %w", ctx.Err())
		case <-q.cfg.Clock.After(q.cfg.Backoff[attempt]):
		}
	}
	q.log.Error("mail: message dropped", "subject", m.Subject, "err", err)
	return err
}
