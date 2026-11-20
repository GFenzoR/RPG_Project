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

// Migration 00021 (docs/02 "Apariencia"): a character that existed before it has an empty
// look (the game picks one from its id at login, content.DefaultLook, and saves it); a
// look chosen at creation and one saved by the game come back as written; the columns
// are bounded.
func TestCharacterLookMigration(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_character_look"
	st := storetest.Open(t, schema, false)
	conn := storetest.Conn(t, schema)
	// The schema before the look (00020 is feat/pockets'; UpTo stops at the last one ≤ 20).
	if err := st.MigrateUpTo(ctx, 20); err != nil {
		t.Fatal(err)
	}
	var acc, old int64
	if err := conn.QueryRow(ctx, `INSERT INTO accounts (email) VALUES ('look@example.org') RETURNING id`).Scan(&acc); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO characters (account_id, name, vocation, health, mana)
		VALUES ($1, 'Antigua', 'guardian', 150, 30) RETURNING id`, acc).Scan(&old); err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)

	pc, err := st.PlayCharacter(ctx, acc, old, now)
	if err != nil {
		t.Fatal(err)
	}
	if pc.Look != (store.Look{}) {
		t.Fatalf("an existing character's look %+v, want none (picked by the game)", pc.Look)
	}

	// The game saves the look it gave it.
	given := store.Look{Body: "slender", Skin: "olive", Hair: "curly", HairColor: "auburn", Beard: "none"}
	if err := st.SaveCharacterState(ctx, store.CharacterState{ID: old, Level: 1, Health: 1, X: 5, Y: 5, Z: 7,
		Look: given, SavedAt: now}); err != nil {
		t.Fatal(err)
	}
	if pc, err = st.PlayCharacter(ctx, acc, old, now); err != nil || pc.Look != given {
		t.Fatalf("saved look %+v, want %+v (%v)", pc.Look, given, err)
	}

	// A look chosen at creation.
	chosen := store.Look{Body: "sturdy", Skin: "deep", Hair: "topknot", HairColor: "white", Beard: "full"}
	c, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: "Nueva", Vocation: "druid",
		Health: 1, Look: chosen}, 5)
	if err != nil {
		t.Fatal(err)
	}
	if pc, err = st.PlayCharacter(ctx, acc, c.ID, now); err != nil || pc.Look != chosen {
		t.Fatalf("created look %+v, want %+v (%v)", pc.Look, chosen, err)
	}

	// Bounded like the cosmetics' ids.
	if _, err := conn.Exec(ctx, `UPDATE characters SET look_hair = $1 WHERE id = $2`, strings.Repeat("x", 33), c.ID); err == nil {
		t.Fatal("a 33-character hair id accepted")
	}

	// And it rolls back.
	if err := st.MigrateDownAll(ctx); err != nil {
		t.Fatal(err)
	}
}
