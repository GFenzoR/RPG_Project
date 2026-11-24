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
)

type fakeTrailStore struct {
	mu     sync.Mutex
	data   []byte
	at     time.Time
	ok     bool
	err    error
	writes int
}

func (f *fakeTrailStore) LoadTrailWear(context.Context) ([]byte, time.Time, bool, error) {
	return f.data, f.at, f.ok, f.err
}

func (f *fakeTrailStore) SaveTrailWear(_ context.Context, data []byte, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.data, f.at, f.ok = data, at, true
	f.writes++
	return nil
}

// The downtime the grass recovers at start is the time since the last write; a failed
// read starts without wear.
func TestLoadTrail(t *testing.T) {
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(now)
	log := slog.New(slog.DiscardHandler)
	data, down := loadTrail(&fakeTrailStore{data: []byte("TW\x01"), at: now.Add(-90 * time.Minute), ok: true}, clk, log)
	if string(data) != "TW\x01" || down != (90*time.Minute).Milliseconds() {
		t.Fatalf("data %q, downtime %d ms", data, down)
	}
	if data, down := loadTrail(&fakeTrailStore{}, clk, log); data != nil || down != 0 {
		t.Fatalf("nothing saved: %q, %d", data, down)
	}
	if data, _ := loadTrail(&fakeTrailStore{err: errors.New("down")}, clk, log); data != nil {
		t.Fatal("a failed read restored something")
	}
}

// fakeWear is a copy of the wear whose bytes say which one it is.
type fakeWear string

func (f fakeWear) Encode() []byte { return []byte(f) }

// Only the newest copy is written: copies that arrive while one waits replace it, and
// Stop writes what is left.
func TestTrailWriterWritesTheNewestCopy(t *testing.T) {
	st := &fakeTrailStore{}
	w := newTrailWriter(st, clock.NewFake(time.Unix(0, 0)), slog.New(slog.DiscardHandler))
	for _, c := range []fakeWear{"first", "second", "third"} {
		if !w.submit(c, time.Unix(0, 0)) {
			t.Fatal("submit refused")
		}
	}
	w.Start()
	if err := w.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st.writes != 1 || string(st.data) != "third" {
		t.Fatalf("%d writes of %q, want one of the third copy", st.writes, st.data)
	}
}

// The row's saved_at is when the loop took the copy, not when the database wrote it.
func TestTrailWriterSavesTheCopysTime(t *testing.T) {
	st := &fakeTrailStore{}
	taken := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(taken)
	w := newTrailWriter(st, clk, slog.New(slog.DiscardHandler))
	if !w.Submit(session.TrailSnapshot{}) {
		t.Fatal("Submit refused")
	}
	clk.Advance(time.Minute) // a slow database: the write comes a minute later
	w.Start()
	if err := w.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st.writes != 1 || string(st.data) != "TW\x01" || !st.at.Equal(taken) {
		t.Fatalf("%d writes of %q at %v, want one at %v", st.writes, st.data, st.at, taken)
	}
}
