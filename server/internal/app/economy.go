package app

import (
	"context"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// EconomyStore writes economy log batches (T4.1). *store.Store implements it.
type EconomyStore interface {
	AppendEconomy(ctx context.Context, es []store.EconomyEntry) error
}

// economyWriter is the persistence goroutine of the economy log: the loop submits
// entries by value without blocking; the writer gathers them into batches of up to
// batch rows, at least every flush, merges the entries of a batch that only differ in
// their time (same character, source, item, reference and sign: ammo shot after ammo
// shot) and writes each batch with COPY. A failed write is retried with backoff, so a
// database outage delays the log instead of losing it.
type economyWriter struct {
	store EconomyStore
	clock clock.Clock
	log   *slog.Logger
	flush time.Duration
	batch int

	mu       sync.Mutex
	ch       chan session.EconomyEntry
	shut     bool
	finished chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
	// base is cancelled when Stop gives up: a write in flight ends at once.
	base   context.Context
	cancel context.CancelFunc
}

const economyQueue = 16384

func newEconomyWriter(st EconomyStore, clk clock.Clock, log *slog.Logger, flush time.Duration, batch int) *economyWriter {
	base, cancel := context.WithCancel(context.Background())
	return &economyWriter{store: st, clock: clk, log: log, flush: max(flush, time.Millisecond), batch: max(batch, 1),
		ch: make(chan session.EconomyEntry, economyQueue), finished: make(chan struct{}), stop: make(chan struct{}),
		base: base, cancel: cancel}
}

// Submit queues e without blocking (session.Config.Economy).
func (w *economyWriter) Submit(e session.EconomyEntry) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.shut {
		return false
	}
	select {
	case w.ch <- e:
		return true
	default:
		return false
	}
}

func (w *economyWriter) Start() {
	go func() {
		defer close(w.finished)
		buf := make([]session.EconomyEntry, 0, w.batch)
		var due <-chan time.Time
		for {
			select {
			case e, ok := <-w.ch:
				if !ok {
					w.write(buf)
					return
				}
				buf = append(buf, e)
				if due == nil {
					due = w.clock.After(w.flush)
				}
				if len(buf) < w.batch {
					continue
				}
			case <-due:
			}
			w.write(buf)
			buf, due = buf[:0], nil
		}
	}()
}

// Stop stops accepting entries and waits until the queued ones are written or ctx is
// done; then the pending retries are abandoned (and logged).
func (w *economyWriter) Stop(ctx context.Context) error {
	w.mu.Lock()
	if !w.shut {
		w.shut = true
		close(w.ch)
	}
	w.mu.Unlock()
	select {
	case <-w.finished:
		return nil
	case <-ctx.Done():
		w.stopOnce.Do(func() { close(w.stop); w.cancel() })
		<-w.finished
		return ctx.Err()
	}
}

// write merges and writes one batch, retrying transient errors until Stop gives up.
func (w *economyWriter) write(batch []session.EconomyEntry) {
	if len(batch) == 0 {
		return
	}
	rows := coalesce(batch)
	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		select {
		case <-w.stop: // Stop gave up: the rest of the queue goes to the log, not the database
			w.log.Error("economy: batch abandoned at shutdown", "rows", len(rows))
			return
		default:
		}
		ctx, cancel := context.WithTimeout(w.base, adminWriteTimeout)
		err := w.store.AppendEconomy(ctx, rows)
		cancel()
		switch {
		case err == nil:
			return
		case store.Permanent(err):
			w.log.Error("economy: batch rejected by the database", "rows", len(rows), "err", err)
			return
		}
		w.log.Error("economy: batch failed, retrying", "rows", len(rows), "attempt", attempt, "retry_in", backoff.String(), "err", err)
		select {
		case <-w.stop:
			w.log.Error("economy: batch abandoned at shutdown", "rows", len(rows))
			return
		case <-w.clock.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// coalesceKey is what two entries of a batch must share to become one row.
type coalesceKey struct {
	kind         string
	char, other  int64
	item         uint16
	ref          string
	money, minus bool
}

// coalesce merges runs of consecutive entries that only differ in time and size (arrow
// after arrow), keeping the first time, so the log keeps the order things happened in.
// Sums never overflow a row's column.
func coalesce(batch []session.EconomyEntry) []store.EconomyEntry {
	out := make([]store.EconomyEntry, 0, len(batch))
	var last coalesceKey
	for _, e := range batch {
		k := coalesceKey{kind: e.Kind, char: e.CharacterID, other: e.OtherCharacterID, item: e.ItemID, ref: e.Ref,
			money: e.ItemID == 0, minus: e.Count < 0 || e.Amount < 0}
		if len(out) > 0 && k == last {
			r := &out[len(out)-1]
			sum := int64(r.Count) + int64(e.Count)
			if sum >= math.MinInt32 && sum <= math.MaxInt32 && (e.Amount >= 0) == (r.Amount+e.Amount >= 0) {
				r.Count, r.Amount = int(sum), r.Amount+e.Amount
				continue
			}
		}
		last = k
		out = append(out, store.EconomyEntry{At: e.At, Kind: e.Kind, CharacterID: e.CharacterID,
			OtherCharacterID: e.OtherCharacterID, ItemID: int(e.ItemID), Count: int(e.Count), Amount: e.Amount, Ref: e.Ref})
	}
	return out
}

// writePending writes the entries the loop could not queue (shutdown).
func (w *economyWriter) writePending(ctx context.Context, es []session.EconomyEntry) error {
	if len(es) == 0 {
		return nil
	}
	return w.store.AppendEconomy(ctx, coalesce(es))
}
