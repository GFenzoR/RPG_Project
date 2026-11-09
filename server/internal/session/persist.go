package session

import (
	"context"
	"errors"
	"fmt"
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
	// WriteTransfer stores a Transfer (T5.3): its snapshots and market changes in one
	// database transaction. Without it, SubmitTransfer refuses every transfer.
	WriteTransfer func(ctx context.Context, t Transfer) error
	// Saved is called after a snapshot is stored (or dropped with ErrGone), also for each
	// snapshot of a stored transfer. Optional.
	Saved func(s Snapshot)
	Clock clock.Clock
	// Queue is the capacity of the submission queue (default 4096).
	Queue int
	// WriteTimeout bounds one write (default 10 s).
	WriteTimeout time.Duration
	Logger       *slog.Logger
	// Failed is told about every failed write with its outcome (SaveRetry, SaveRejected,
	// SaveAbandoned, SaveSkipped), for the metrics. Called on the persistence goroutine.
	// Optional.
	Failed func(outcome string)
	// Tainted is told about characters that just became tainted (a transfer of theirs was
	// not stored, T5.3), or with none when a market-only transfer was not stored: the World
	// must stop them and turn the market read-only (World.Tainted). Called on the goroutine
	// that writes; it must not block. Optional.
	Tainted func(characters []int64)
}

// Outcomes of a failed write, given to SaverConfig.Failed. They are the outcome labels of
// persistence_errors_total (internal/metrics).
const (
	SaveRetry     = "retry"
	SaveRejected  = "rejected"
	SaveAbandoned = "abandoned"
	// SaveSkipped: not written because a character of it is tainted (T5.3).
	SaveSkipped = "skipped"
)

// Job is one unit of the persistence queue: a snapshot, or (Transfer non-nil) a transfer.
type Job struct {
	Snapshot Snapshot
	Transfer *Transfer
}

// Saver is the persistence goroutine: it writes the snapshots and transfers the game
// loop submits, in order, outside the loop. A failed write is retried with backoff, so a
// database outage delays saves instead of losing them. Being one goroutine with one
// queue, a transfer is always written after the autosaves of its characters that were
// submitted before it and before the later ones (docs/01 "Transacciones").
type Saver struct {
	cfg      SaverConfig
	mu       sync.Mutex
	ch       chan Job
	shut     bool
	done     chan struct{}
	stop     chan struct{} // closed when Stop's deadline passes: abandon retries
	stopOnce sync.Once
	// tainted are the characters of a transfer that was dropped (rejected or abandoned):
	// none of their later snapshots or transfers is written in this process, because it
	// would store one half of that transfer (the inventory without the market rows, or
	// the other way round). Guarded by mu.
	tainted map[int64]bool
	// crashed: a transfer failed while shutting down. Nothing after it is written, of any
	// character, as if the process had crashed right there (the items of that transfer
	// may already have moved on to others in the loop). Guarded by mu.
	crashed bool
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
	return &Saver{cfg: cfg, ch: make(chan Job, cfg.Queue), done: make(chan struct{}), stop: make(chan struct{}),
		tainted: map[int64]bool{}}, nil
}

// Submit queues s without blocking. It returns false if the queue is full or the saver
// was stopped. It matches Config.Save.
func (s *Saver) Submit(snap Snapshot) bool { return s.submit(Job{Snapshot: snap}) }

// SubmitTransfer queues t without blocking, like Submit. It matches Config.Transfer.
func (s *Saver) SubmitTransfer(t Transfer) bool {
	if s.cfg.WriteTransfer == nil {
		return false
	}
	return s.submit(Job{Transfer: &t})
}

func (s *Saver) submit(j Job) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shut {
		return false
	}
	select {
	case s.ch <- j:
		return true
	default:
		return false
	}
}

// Backlog is how many jobs wait in the queue. Safe from any goroutine (metrics).
func (s *Saver) Backlog() int { return len(s.ch) }

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
	for j := range s.ch {
		if s.skipCrashed(j) || s.skipTainted(j) {
			continue
		}
		if j.Transfer != nil {
			s.writeTransfer(*j.Transfer)
		} else {
			s.write(j.Snapshot)
		}
	}
}

// Taint (T5.3, docs/01 "Transacciones"). A transfer that is not stored (rejected, or
// abandoned at shutdown) leaves the database with the state before it, on every side. Its
// characters are tainted: no later job that touches one of them is written in this
// process, and a skipped transfer taints its other characters too (a fixed point: a trade
// with a tainted character must not reach the database through its partner's next save).
// The World is told (SaverConfig.Tainted): it takes those characters out of the world and
// turns the market and the trade window read-only until the server restarts.

// jobCharacters returns the characters whose saved state j writes.
func jobCharacters(j Job) []int64 {
	if j.Transfer == nil {
		return []int64{j.Snapshot.CharacterID}
	}
	out := make([]int64, 0, len(j.Transfer.Snapshots))
	for _, sn := range j.Transfer.Snapshots {
		out = append(out, sn.CharacterID)
	}
	return out
}

// Tainted reports whether j touches a tainted character.
func (s *Saver) Tainted(j Job) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range jobCharacters(j) {
		if s.tainted[id] {
			return true
		}
	}
	return false
}

// taint marks the characters of j and tells the World about the new ones.
func (s *Saver) taint(j Job) {
	var fresh []int64
	s.mu.Lock()
	for _, id := range jobCharacters(j) {
		if !s.tainted[id] {
			s.tainted[id] = true
			fresh = append(fresh, id)
		}
	}
	s.mu.Unlock()
	// A dropped market-only transfer (expiry, cancel) taints nobody, but the market in
	// memory is ahead of the database all the same: the World must go read-only too.
	marketOnly := j.Transfer != nil && len(j.Transfer.Snapshots) == 0
	if len(fresh) > 0 || marketOnly {
		s.cfg.Logger.Error("session: transfer not stored, market read-only and characters tainted until a restart",
			"characters", fresh)
		if s.cfg.Tainted != nil {
			s.cfg.Tainted(fresh)
		}
	}
}

// skipTainted reports whether j touches a tainted character; then it taints all of j's
// characters (the fixed point) and logs and counts the skip.
func (s *Saver) skipTainted(j Job) bool {
	if !s.Tainted(j) {
		return false
	}
	s.taint(j)
	s.cfg.Logger.Error("session: save skipped, a character of it is tainted", "characters", jobCharacters(j),
		"transfer", j.Transfer != nil, "final", j.Transfer == nil && j.Snapshot.Final)
	s.failed(SaveSkipped)
	return true
}

// crash marks the shutdown as a crash at this job: everything after it is abandoned.
func (s *Saver) crash() {
	s.mu.Lock()
	s.crashed = true
	s.mu.Unlock()
}

// skipCrashed reports whether the shutdown crashed before j; then j is abandoned.
func (s *Saver) skipCrashed(j Job) bool {
	s.mu.Lock()
	crashed := s.crashed
	s.mu.Unlock()
	if !crashed {
		return false
	}
	s.cfg.Logger.Error("session: save abandoned, an earlier transfer failed at shutdown", "characters", jobCharacters(j),
		"transfer", j.Transfer != nil)
	s.failed(SaveAbandoned)
	return true
}

func (s *Saver) stopping() bool {
	select {
	case <-s.stop:
		return true
	default:
		return false
	}
}

// WritePending writes, once each and in order, the jobs the queue could not take at
// shutdown (World.SaveAll), with the same rules as the goroutine: a tainted job is
// skipped, and a transfer that fails taints its characters and, being the shutdown,
// abandons every job after it (crash semantics). Call it after Stop.
func (s *Saver) WritePending(ctx context.Context, jobs []Job) error {
	var errs []error
	for _, j := range jobs {
		if s.skipCrashed(j) {
			errs = append(errs, fmt.Errorf("characters %v: %w", jobCharacters(j), errCrashedSkip))
			continue
		}
		if s.skipTainted(j) {
			errs = append(errs, fmt.Errorf("characters %v: %w", jobCharacters(j), errTaintedSkip))
			continue
		}
		var err error
		if j.Transfer != nil {
			if s.cfg.WriteTransfer == nil {
				err = errors.New("no transfer writer")
			} else {
				err = s.cfg.WriteTransfer(ctx, *j.Transfer)
			}
			if err != nil {
				s.failed(SaveAbandoned)
				s.taint(j)
				s.crash()
				err = fmt.Errorf("transfer %d: %w", j.Transfer.ID, err)
			}
		} else if err = s.cfg.Write(ctx, j.Snapshot); err != nil {
			s.failed(SaveAbandoned)
			err = fmt.Errorf("character %d: %w", j.Snapshot.CharacterID, err)
		}
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

var (
	errTaintedSkip = errors.New("save skipped: a transfer of its character was not stored")
	errCrashedSkip = errors.New("save abandoned: an earlier transfer failed at shutdown")
)

// writeTransfer writes t like write writes a snapshot: retried until it is stored, it is
// rejected (ErrPermanent) or the saver stops. A transfer that is not stored taints its
// characters: their later saves are skipped (logged), so the database keeps the state
// before the transfer on both sides instead of half of it.
func (s *Saver) writeTransfer(t Transfer) {
	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), s.cfg.WriteTimeout)
		err := s.cfg.WriteTransfer(ctx, t)
		cancel()
		switch {
		case err == nil:
			for _, snap := range t.Snapshots {
				s.saved(snap)
			}
			return
		case errors.Is(err, ErrPermanent) || errors.Is(err, ErrGone):
			s.cfg.Logger.Error("session: transfer dropped, rejected by the database", "transfer", t.ID, "err", err)
			s.failed(SaveRejected)
			s.taint(Job{Transfer: &t})
			if s.stopping() {
				s.crash()
			}
			return
		}
		s.cfg.Logger.Error("session: transfer failed, retrying", "transfer", t.ID, "attempt", attempt,
			"retry_in", backoff.String(), "err", err)
		s.failed(SaveRetry)
		select {
		case <-s.stop:
			s.cfg.Logger.Error("session: transfer abandoned at shutdown", "transfer", t.ID)
			s.failed(SaveAbandoned)
			s.taint(Job{Transfer: &t})
			s.crash()
			return
		case <-s.cfg.Clock.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
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
