package app

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

type econStore struct {
	mu      sync.Mutex
	batches [][]store.EconomyEntry
	ids     []string // every attempt's batch id
	fail    int      // the first fail writes fail
}

func (s *econStore) AppendEconomy(_ context.Context, id string, es []store.EconomyEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ids = append(s.ids, id)
	if s.fail > 0 {
		s.fail--
		return errors.New("connection refused")
	}
	s.batches = append(s.batches, es)
	return nil
}

func (s *econStore) rows() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, b := range s.batches {
		n += len(b)
	}
	return n
}

// Entries that only differ in time and size become one row; signs and sources do not mix.
func TestCoalesce(t *testing.T) {
	at := time.Unix(100, 0)
	in := []session.EconomyEntry{
		{At: at, Kind: session.EconConsume, CharacterID: 1, ItemID: 30, Count: -1},
		{At: at.Add(time.Second), Kind: session.EconConsume, CharacterID: 1, ItemID: 30, Count: -1},
		{At: at, Kind: session.EconLoot, CharacterID: 1, Amount: 20, Ref: "wolf"},
		{At: at, Kind: session.EconConsume, CharacterID: 2, ItemID: 30, Count: -1},
		{At: at, Kind: session.EconLoot, CharacterID: 1, Amount: 5, Ref: "wolf"},
		{At: at, Kind: session.EconCraft, CharacterID: 1, ItemID: 30, Count: 2},
		{At: at, Kind: session.EconCraft, CharacterID: 1, ItemID: 30, Count: -2},
	}
	out := coalesce(in) // only consecutive runs merge: the order of the log stays
	if len(out) != 6 || out[0].Count != -2 || !out[0].At.Equal(at) || out[1].Amount != 20 || out[1].Ref != "wolf" ||
		out[2].CharacterID != 2 || out[3].Amount != 5 || out[4].Count != 2 || out[5].Count != -2 {
		t.Fatalf("coalesce = %+v", out)
	}
}

// The writer batches by size and by time, retries a failed write and drains at Stop.
func TestEconomyWriterBatchesAndRetries(t *testing.T) {
	clk := clock.NewFake(time.Unix(0, 0))
	st := &econStore{fail: 1}
	w := newEconomyWriter(st, clk, slog.New(slog.DiscardHandler), 2*time.Second, 3)
	w.Start()
	for i := range 3 { // a full batch: written at once (after one failed attempt)
		if !w.Submit(session.EconomyEntry{Kind: session.EconGather, CharacterID: int64(i + 1), ItemID: 9, Count: 1}) {
			t.Fatal("queue refused an entry")
		}
	}
	waitFor(t, func() bool { clk.Advance(time.Second); return st.rows() == 3 })
	w.Submit(session.EconomyEntry{Kind: session.EconGather, CharacterID: 9, ItemID: 9, Count: 1})
	waitFor(t, func() bool { clk.Advance(time.Second); return st.rows() == 4 }) // flush_ms passed
	w.Submit(session.EconomyEntry{Kind: session.EconGather, CharacterID: 10, ItemID: 9, Count: 1})
	if err := w.Stop(context.Background()); err != nil || st.rows() != 5 {
		t.Fatalf("Stop = %v, rows %d", err, st.rows())
	}
	// The retry of the failed batch kept its id (idempotent in the store); others are new.
	if ids := st.ids; len(ids) != 4 || ids[0] != ids[1] || ids[1] == ids[2] || ids[2] == ids[3] {
		t.Fatalf("batch ids %v", ids)
	}
	if w.Submit(session.EconomyEntry{}) {
		t.Fatal("accepted after Stop")
	}
}

// waitFor polls cond while the writer goroutine works (each poll may advance the fake
// clock), for up to 5 s of real time.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for range 5000 {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond) //nolint:forbidigo // waits for another goroutine, not game time
	}
	t.Fatal("condition not met")
}

type hungStore struct{ calls int }

func (s *hungStore) AppendEconomy(ctx context.Context, _ string, _ []store.EconomyEntry) error {
	s.calls++
	<-ctx.Done() // the database never answers
	return ctx.Err()
}

// With the database hung, Stop's deadline ends the write in flight and abandons the rest
// of the queue without trying it: shutdown stays bounded.
func TestEconomyWriterStopBoundedWhenHung(t *testing.T) {
	st := &hungStore{}
	w := newEconomyWriter(st, clock.Real{}, slog.New(slog.DiscardHandler), time.Hour, 1)
	w.Start()
	for i := range 50 {
		w.Submit(session.EconomyEntry{Kind: session.EconGather, CharacterID: int64(i + 1), ItemID: 9, Count: 1})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := w.Stop(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Stop = %v", err)
	}
	if st.calls > 2 {
		t.Fatalf("%d writes tried after the deadline", st.calls)
	}
}
