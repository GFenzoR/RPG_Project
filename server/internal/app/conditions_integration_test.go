//go:build integration

package app

import (
	"context"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// T5.2: the saver writes a snapshot's conditions with their authors, the holder's memory
// of each author's attack and when an authored one was saved, and the next login reads them back from Postgres (the
// gateway turns them into session.ConditionState field by field, gateway's unit test).
func TestSnapshotConditionAuthorPersists(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_app_conditions", true)
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	acc, err := st.CreateAccount(ctx, "cond-app@example.org", "h")
	if err != nil {
		t.Fatal(err)
	}
	char := func(name string) int64 {
		t.Helper()
		c, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: name, Vocation: "guardian", Health: 1}, 20)
		if err != nil {
			t.Fatal(err)
		}
		return c.ID
	}
	ana, bea := char("Ana"), char("Bea")
	a := &App{cfg: Config{Store: st, Clock: clock.NewFake(now)}}

	hit, at := now.Add(-15*time.Second), now.Add(-time.Second)
	saved := []session.ConditionState{
		{ID: "poison", LeftMs: 700, Ticks: 9, Damage: 20, Author: ana, AuthorHit: hit, AuthorUnjust: true, SavedAt: at},
		{ID: "slowed", LeftMs: 3000, Author: ana, SavedAt: at},
		{ID: "burning", LeftMs: 200, Ticks: 2, Damage: 6},
	}
	if err := a.writeSnapshot(ctx, session.Snapshot{CharacterID: bea, Seq: 1, Level: 30, Health: 1,
		Pos: world.Pos{X: 1, Y: 1, Z: 7}, Conditions: saved, Final: true}); err != nil {
		t.Fatal(err)
	}
	pc, err := st.PlayCharacter(ctx, acc, bea, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(pc.Conditions) != len(saved) {
		t.Fatalf("loaded %+v", pc.Conditions)
	}
	for i, got := range pc.Conditions {
		w := saved[i]
		if got.ID != w.ID || got.LeftMs != w.LeftMs || got.Ticks != w.Ticks || got.Damage != w.Damage ||
			got.Author != w.Author || !got.AuthorHit.Equal(w.AuthorHit) || got.AuthorUnjust != w.AuthorUnjust ||
			!got.SavedAt.Equal(w.SavedAt) {
			t.Fatalf("condition %d: loaded %+v, saved %+v", i, got, w)
		}
	}
}
