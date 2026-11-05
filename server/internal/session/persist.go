package session

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// ErrGone is returned by a SaverConfig.Write when the character no longer exists: the
// snapshot is dropped instead of retried.
var ErrGone = errors.New("session: character no longer exists")

// ErrPermanent wraps a SaverConfig.Write error that retrying cannot fix (the database
// rejected the values): the snapshot is dropped and logged so it does not block the
// queue.
var ErrPermanent = errors.New("session: snapshot rejected")

// SaverConfig configures a Saver.
type SaverConfig struct {
	// Write stores one snapshot. Required.
	Write func(ctx context.Context, s Snapshot) error
	// Saved is called after a snapshot is stored (or dropped with ErrGone). Optional.
	Saved func(s Snapshot)
	Clock clock.Clock
	// Queue is the capacity of the submission queue (default 4096).
	Queue int
	// WriteTimeout bounds one write (default 10 s).
	WriteTimeout time.Duration
	Logger       *slog.Logger
	// Failed is told about every failed write with its outcome (SaveRetry, SaveRejected,
	// SaveAbandoned), for the metrics. Called on the persistence goroutine. Optional.
	Failed func(outcome string)
}

// Outcomes of a failed write, given to SaverConfig.Failed. They are the outcome labels of
// persistence_errors_total (internal/metrics).
const (
	SaveRetry     = "retry"
	SaveRejected  = "rejected"
	SaveAbandoned = "abandoned"
)

// Saver is the persistence goroutine: it writes the snapshots the game loop submits, in
// order, outside the loop. A failed write is retried with backoff, so a database outage
// delays saves instead of losing them.
type Saver struct {
	cfg      SaverConfig
	mu       sync.Mutex
	ch       chan Snapshot
	shut     bool
	done     chan struct{}
	stop     chan struct{} // closed when Stop's deadline passes: abandon retries
	stopOnce sync.Once
}

// NewSaver builds a Saver; call Start to run it.
func NewSaver(cfg SaverConfig) (*Saver, error) {
	if cfg.Write == nil || cfg.Clock == nil {
		return nil, errors.New("session: SaverConfig.Write and Clock are required")
	}
	if cfg.Queue <= 0 {
		cfg.Queue = 4096
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = 10 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	return &Saver{cfg: cfg, ch: make(chan Snapshot, cfg.Queue), done: make(chan struct{}), stop: make(chan struct{})}, nil
}

// Submit queues s without blocking. It returns false if the queue is full or the saver
// was stopped. It matches Config.Save.
func (s *Saver) Submit(snap Snapshot) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shut {
		return false
	}
	select {
	case s.ch <- snap:
		return true
	default:
		return false
	}
}

// Start runs the persistence goroutine.
func (s *Saver) Start() { go s.run() }

// Stop stops accepting snapshots and waits until the queued ones are written or ctx is
// done; in that case pending retries are abandoned (and logged). It returns ctx.Err()
// if the queue was not drained.
func (s *Saver) Stop(ctx context.Context) error {
	s.mu.Lock()
	if !s.shut {
		s.shut = true
		close(s.ch)
	}
	s.mu.Unlock()
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		s.stopOnce.Do(func() { close(s.stop) })
		<-s.done
		return ctx.Err()
	}
}

func (s *Saver) run() {
	defer close(s.done)
	for snap := range s.ch {
		s.write(snap)
	}
}

func (s *Saver) write(snap Snapshot) {
	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), s.cfg.WriteTimeout)
		err := s.cfg.Write(ctx, snap)
		cancel()
		switch {
		case err == nil:
			s.saved(snap)
			return
		case errors.Is(err, ErrGone):
			s.cfg.Logger.Warn("session: save dropped, character gone", "character", snap.CharacterID)
			s.saved(snap)
			return
		case errors.Is(err, ErrPermanent):
			s.cfg.Logger.Error("session: save dropped, rejected by the database", "character", snap.CharacterID,
				"final", snap.Final, "err", err)
			s.failed(SaveRejected)
			return // not acked: the World keeps a final snapshot for the next login
		}
		s.cfg.Logger.Error("session: save failed, retrying", "character", snap.CharacterID,
			"attempt", attempt, "retry_in", backoff.String(), "err", err)
		s.failed(SaveRetry)
		select {
		case <-s.stop:
			s.cfg.Logger.Error("session: save abandoned at shutdown", "character", snap.CharacterID, "final", snap.Final)
			s.failed(SaveAbandoned)
			return
		case <-s.cfg.Clock.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (s *Saver) failed(outcome string) {
	if s.cfg.Failed != nil {
		s.cfg.Failed(outcome)
	}
}

func (s *Saver) saved(snap Snapshot) {
	if s.cfg.Saved != nil {
		s.cfg.Saved(snap)
	}
}
