//go:build integration

package store_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// T5.2: a condition another player applied keeps its author through a save and a login
// (characters.conditions, no migration: optional JSON keys), with what its holder
// remembered of that author's attack; a row saved before the keys existed loads with no
// author, and a save without one writes the JSON of T3.2.
func TestConditionAuthorPersists(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_conditions"
	st := storetest.Open(t, schema, true)
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	acc, err := st.CreateAccount(ctx, "cond@example.org", "h")
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

	hit := now.Add(-20 * time.Second)
	want := []store.Condition{
		{ID: "poison", LeftMs: 800, Ticks: 12, Damage: 20, Author: ana, AuthorHit: hit, AuthorUnjust: true},
		{ID: "burning", LeftMs: 300, Ticks: 2, Damage: 5, Author: ana}, // an arena duel: nothing remembered
		{ID: "slowed", LeftMs: 4000}, // a monster's
	}
	if err := st.SaveCharacterState(ctx, store.CharacterState{ID: bea, Level: 30, Health: 1, X: 1, Y: 1, Z: 7,
		Conditions: want, SavedAt: now}); err != nil {
		t.Fatal(err)
	}
	pc, err := st.PlayCharacter(ctx, acc, bea, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(pc.Conditions) != len(want) {
		t.Fatalf("loaded %+v", pc.Conditions)
	}
	for i, got := range pc.Conditions {
		w := want[i]
		if got.ID != w.ID || got.LeftMs != w.LeftMs || got.Ticks != w.Ticks || got.Damage != w.Damage ||
			got.Author != w.Author || !got.AuthorHit.Equal(w.AuthorHit) || got.AuthorUnjust != w.AuthorUnjust {
			t.Fatalf("condition %d: loaded %+v, saved %+v", i, got, w)
		}
	}

	conn := storetest.Conn(t, schema)
	var raw string
	if err := conn.QueryRow(ctx, "SELECT conditions::text FROM characters WHERE id = $1", bea).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(raw, `"author"`); n != 2 || strings.Count(raw, `"author_hit"`) != 1 {
		t.Fatalf("saved JSON %s", raw)
	}

	// A row of T3.2 (no author keys): a condition of nobody, as before.
	if _, err := conn.Exec(ctx, `UPDATE characters SET conditions = '[{"id":"poison","left_ms":500,"ticks":3,"damage":4}]'
		WHERE id = $1`, bea); err != nil {
		t.Fatal(err)
	}
	if pc, err = st.PlayCharacter(ctx, acc, bea, now); err != nil || len(pc.Conditions) != 1 {
		t.Fatalf("legacy row: %+v, %v", pc.Conditions, err)
	}
	if c := pc.Conditions[0]; c.Author != 0 || !c.AuthorHit.IsZero() || c.AuthorUnjust || c.Ticks != 3 || c.Damage != 4 {
		t.Fatalf("legacy condition %+v", c)
	}
}
