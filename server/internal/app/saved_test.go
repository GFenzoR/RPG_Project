package app

import (
	"math/rand/v2"
	"path/filepath"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Every stored snapshot is acked to the loop, not only a final one: the ack of a
// transfer's snapshot is what ends the character's transfer hold (T5.3, World.Saved).
// With the loop's queue full the ack is retried, not dropped: a lost one would keep the
// character from dropping anything on the public ground until its next save.
func TestSnapshotSavedAcksEverySnapshot(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC))
	bal, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	w, err := session.New(session.Config{
		Map: worldtest.Map(t, 0, 0, 7, "....", ".T.."), Balance: bal, Items: items,
		Vocations: content.Vocations{"guardian": {ID: "guardian", Start: content.VocationStats{Health: 100, Speed: 200}}},
		Save:      func(session.Snapshot) bool { return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _, flush := w.Systems()
	loop, err := game.New(game.Config{Clock: clk, Rand: rand.New(rand.NewPCG(1, 1)), Systems: []game.System{flush}, QueueCapacity: 2})
	if err != nil {
		t.Fatal(err)
	}
	a := &App{cfg: Config{Clock: clk}, Loop: loop, World: w, loopDone: make(chan struct{})}
	defer close(a.loopDone)

	// A snapshot of a transfer (not final) reaches the loop.
	a.snapshotSaved(session.Snapshot{CharacterID: 7, Seq: 3})
	if st := loop.Step(); st.Commands != 1 {
		t.Fatalf("the ack of a non-final snapshot ran %d commands, want 1", st.Commands)
	}

	// Queue full: the ack waits for room instead of being lost.
	noop := game.CommandFunc(func(*game.TickContext) {})
	for loop.Enqueue(noop) == nil {
	}
	a.snapshotSaved(session.Snapshot{CharacterID: 7, Seq: 4})
	ran := 0
	for range 200 {
		ran += loop.Step().Commands
		if ran == 3 { // the two no-ops, then the ack
			return
		}
		time.Sleep(time.Millisecond)   //nolint:forbidigo // lets the retry goroutine wait on the fake clock
		clk.Advance(game.TickDuration) // wakes the retry
	}
	t.Fatalf("ran %d commands, want the two no-ops and the retried ack", ran)
}
