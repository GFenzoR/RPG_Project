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

// Migration 00029 (docs/02 "Opciones guardadas"): a character from before it has the
// defaults (balanced, not chasing, safe mode on); what the game saves comes back; the
// stance column is bounded. The account's interface document is one row per account,
// replaced by each save, never another account's, and capped in size.
func TestSavedOptionsMigration(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_saved_options"
	st := storetest.Open(t, schema, false)
	conn := storetest.Conn(t, schema)
	if err := st.MigrateUpTo(ctx, 28); err != nil {
		t.Fatal(err)
	}
	var acc, other, old int64
	if err := conn.QueryRow(ctx, `INSERT INTO accounts (email) VALUES ('opts@example.org') RETURNING id`).Scan(&acc); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO accounts (email) VALUES ('other@example.org') RETURNING id`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO characters (account_id, name, vocation, health, mana)
		VALUES ($1, 'Antigua', 'guardian', 150, 30) RETURNING id`, acc).Scan(&old); err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)

	pc, err := st.PlayCharacter(ctx, acc, old, now)
	if err != nil {
		t.Fatal(err)
	}
	if want := (store.GameOptions{Stance: 2}); pc.Options != want {
		t.Fatalf("an existing character's options %+v, want %+v", pc.Options, want)
	}
	chosen := store.GameOptions{Stance: 3, Chase: true, Unsafe: true}
	if err := st.SaveCharacterState(ctx, store.CharacterState{ID: old, Level: 1, Health: 1, X: 5, Y: 5, Z: 7,
		Options: chosen, SavedAt: now}); err != nil {
		t.Fatal(err)
	}
	if pc, err = st.PlayCharacter(ctx, acc, old, now); err != nil || pc.Options != chosen {
		t.Fatalf("saved options %+v, want %+v (%v)", pc.Options, chosen, err)
	}
	// A snapshot without options (the zero value) and a junk stance are saved balanced.
	for _, o := range []store.GameOptions{{}, {Stance: 9}} {
		if err := st.SaveCharacterState(ctx, store.CharacterState{ID: old, Level: 1, Health: 1, X: 5, Y: 5, Z: 7,
			Options: o, SavedAt: now}); err != nil {
			t.Fatal(err)
		}
		if pc, err = st.PlayCharacter(ctx, acc, old, now); err != nil || pc.Options != (store.GameOptions{Stance: 2}) {
			t.Fatalf("options %+v saved as %+v (%v), want balanced", o, pc.Options, err)
		}
	}
	if _, err := conn.Exec(ctx, `UPDATE characters SET opt_stance = 4 WHERE id = $1`, old); err == nil {
		t.Fatal("stance 4 accepted by the table")
	}

	// The account document.
	if doc, err := st.AccountOptions(ctx, acc); err != nil || doc != nil {
		t.Fatalf("options of an account that never saved = %q, %v", doc, err)
	}
	if err := st.SaveAccountOptions(ctx, acc, []byte(`{"v":1,"lang":"es"}`), now); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveAccountOptions(ctx, acc, []byte(`{"v":1,"lang":"en"}`), now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	doc, err := st.AccountOptions(ctx, acc)
	if err != nil || !strings.Contains(string(doc), `"en"`) || strings.Contains(string(doc), `"es"`) {
		t.Fatalf("account options = %q, %v; want the last document", doc, err)
	}
	if doc, err := st.AccountOptions(ctx, other); err != nil || doc != nil {
		t.Fatalf("another account reads %q, %v", doc, err)
	}
	huge := `{"v":1,"lang":"` + strings.Repeat("x", 40000) + `"}`
	if err := st.SaveAccountOptions(ctx, acc, []byte(huge), now); err == nil {
		t.Fatal("a 40 kB document accepted by the table")
	}
	if err := st.SaveAccountOptions(ctx, acc, []byte(`[1]`), now); err == nil {
		t.Fatal("a document that is not an object accepted by the table")
	}
	if err := st.MigrateDownAll(ctx); err != nil {
		t.Fatal(err)
	}
}
