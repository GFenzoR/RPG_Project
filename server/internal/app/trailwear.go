package app

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// The living world's trail wear on the database (migration 00027; livingworld/README.md
// "Desgaste de senderos"). The loop owns the wear: it hands a copy to the trailWriter
// every save_every_ms, and the writer encodes and writes it from its own goroutine. Only
// the newest copy matters, so a slow database never makes a queue: a new copy replaces
// the one waiting. At shutdown App.Run writes the last copy after the loop stopped.

// TrailStore is the store side of the trail wear (Postgres; fake stores leave it off and
// the wear lives in memory only).
type TrailStore interface {
	LoadTrailWear(ctx context.Context) (data []byte, savedAt time.Time, ok bool, err error)
	SaveTrailWear(ctx context.Context, data []byte, savedAt time.Time) error
}

// trailWriteTimeout bounds one write of the wear.
const trailWriteTimeout = 30 * time.Second

// loadTrail reads the saved wear and how long ago it was saved (the downtime the grass
// recovers at start). A failed read starts without wear: it costs paths, never the start.
func loadTrail(st TrailStore, clk clock.Clock, log *slog.Logger) (data []byte, downMs int64) {
	ctx, cancel := context.WithTimeout(context.Background(), guildLoadTimeout)
	defer cancel()
	data, at, ok, err := st.LoadTrailWear(ctx)
	if err != nil {
		log.Error("trail wear not loaded, starting without it", "err", err)
		return nil, 0
	}
	if !ok {
		return nil, 0
	}
	return data, max(clk.Now().Sub(at).Milliseconds(), 0)
}

// trailWriter writes the newest copy of the wear.
type trailWriter struct {
	st  TrailStore
	clk clock.Clock
	log *slog.Logger

	mu      sync.Mutex
	pending *trailCopy
	signal  chan struct{}
	stop    chan struct{}
	done    chan struct{}
}

func newTrailWriter(st TrailStore, clk clock.Clock, log *slog.Logger) *trailWriter {
	return &trailWriter{st: st, clk: clk, log: log, signal: make(chan struct{}, 1),
		stop: make(chan struct{}), done: make(chan struct{})}
}

// trailCopy is a copy of the wear waiting to be written and when it was taken (the row's
// saved_at: the downtime the grass recovers at the next start counts from it, not from a
// write the database held up).
type trailCopy struct {
	wear interface{ Encode() []byte }
	at   time.Time
}

// Submit keeps s as the copy to write next (replacing one still waiting). It never
// blocks and always takes it (session.Config.SaveTrail).
func (t *trailWriter) Submit(s session.TrailSnapshot) bool {
	return t.submit(s, t.clk.Now())
}

// submit keeps wear, taken at at, as the copy to write next.
func (t *trailWriter) submit(wear interface{ Encode() []byte }, at time.Time) bool {
	t.mu.Lock()
	t.pending = &trailCopy{wear: wear, at: at}
	t.mu.Unlock()
	select {
	case t.signal <- struct{}{}:
	default:
	}
	return true
}

// Start runs the writer goroutine until Stop.
func (t *trailWriter) Start() {
	go func() {
		defer close(t.done)
		for {
			select {
			case <-t.stop:
				t.flush(context.Background())
				return
			case <-t.signal:
				t.flush(context.Background())
			}
		}
	}()
}

// flush writes the waiting copy, if any.
func (t *trailWriter) flush(parent context.Context) {
	t.mu.Lock()
	s := t.pending
	t.pending = nil
	t.mu.Unlock()
	if s != nil {
		if err := t.write(parent, *s); err != nil {
			t.log.Error("trail wear not saved", "err", err)
		}
	}
}

func (t *trailWriter) write(parent context.Context, c trailCopy) error {
	ctx, cancel := context.WithTimeout(parent, trailWriteTimeout)
	defer cancel()
	return t.st.SaveTrailWear(ctx, c.wear.Encode(), c.at)
}

// Stop writes what is waiting and ends the goroutine (bounded by ctx).
func (t *trailWriter) Stop(ctx context.Context) error {
	close(t.stop)
	select {
	case <-t.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
