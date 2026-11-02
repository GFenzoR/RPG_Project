//go:build integration

package store_test

import (
	"context"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// TestSchemaConstraints covers rules enforced by the schema itself, which later tasks
// (inventory, economy, cosmetics) rely on.
func TestSchemaConstraints(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_schema"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)

	acc, _ := st.CreateAccount(ctx, "ana@example.org", "h")
	ch, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: "Mira", Vocation: "guardian", Health: 150, Mana: 30}, 5)
	if err != nil {
		t.Fatal(err)
	}

	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	mustFail := func(why, sql string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql, args...); err == nil {
			t.Errorf("%s: expected error from %s", why, sql)
		}
	}

	// New characters start without position, with PvP fields prepared and zeroed.
	var posNull bool
	var skull, pvp int
	if err := conn.QueryRow(ctx, "SELECT pos_x IS NULL, skull, pvp_flags FROM characters WHERE id = $1", ch.ID).Scan(&posNull, &skull, &pvp); err != nil {
		t.Fatal(err)
	}
	if !posNull || skull != 0 || pvp != 0 {
		t.Fatalf("defaults: pos null=%v skull=%d pvp=%d", posNull, skull, pvp)
	}
	mustFail("partial position", "UPDATE characters SET pos_x = 10 WHERE id = $1", ch.ID)
	mustExec("UPDATE characters SET pos_x = 10, pos_y = 20, pos_z = 7 WHERE id = $1", ch.ID)
	mustFail("floor out of range", "UPDATE characters SET pos_z = 16 WHERE id = $1", ch.ID)

	// Inventory: one item per equipment slot and per container slot.
	var bag int64
	if err := conn.QueryRow(ctx, "INSERT INTO inventory_items (character_id, slot, item_id) VALUES ($1, 3, 100) RETURNING id", ch.ID).Scan(&bag); err != nil {
		t.Fatal(err)
	}
	mustFail("equipment slot taken", "INSERT INTO inventory_items (character_id, slot, item_id) VALUES ($1, 3, 101)", ch.ID)
	mustExec("INSERT INTO inventory_items (character_id, container_id, slot, item_id, count) VALUES ($1, $2, 0, 200, 50)", ch.ID, bag)
	mustExec("INSERT INTO inventory_items (character_id, container_id, slot, item_id) VALUES ($1, $2, 3, 201)", ch.ID, bag)
	mustFail("container slot taken", "INSERT INTO inventory_items (character_id, container_id, slot, item_id) VALUES ($1, $2, 0, 202)", ch.ID, bag)
	mustFail("zero count", "INSERT INTO inventory_items (character_id, slot, item_id, count) VALUES ($1, 4, 100, 0)", ch.ID)
	mustExec("DELETE FROM inventory_items WHERE id = $1", bag)
	var left int
	_ = conn.QueryRow(ctx, "SELECT count(*) FROM inventory_items WHERE character_id = $1", ch.ID).Scan(&left)
	if left != 0 {
		t.Fatalf("deleting a container must delete its contents, %d left", left)
	}

	mustExec("INSERT INTO character_skills (character_id, skill, level, tries) VALUES ($1, 'sword', 12, 40)", ch.ID)
	mustExec("INSERT INTO quest_state (character_id, key, value) VALUES ($1, 'chapter1.started', 1)", ch.ID)

	// Economy log is append-only.
	mustExec("INSERT INTO economy_log (at, kind, character_id, item_id, count, amount) VALUES (now(), 'npc_sell', $1, 200, 5, 50)", ch.ID)
	mustFail("update economy_log", "UPDATE economy_log SET amount = 0")
	mustFail("delete economy_log", "DELETE FROM economy_log")

	// Cosmetics belong to the account.
	mustExec("INSERT INTO cosmetics (id, kind) VALUES ('outfit.sailor', 'outfit')")
	mustExec("INSERT INTO account_cosmetics (account_id, cosmetic_id, source) VALUES ($1, 'outfit.sailor', 'game')", acc)
	mustFail("unknown cosmetic kind", "INSERT INTO cosmetics (id, kind) VALUES ('x', 'weapon')")

	// Deleting the account cascades to characters and their state; the log survives.
	mustExec("DELETE FROM accounts WHERE id = $1", acc)
	for _, table := range []string{"characters", "character_skills", "quest_state", "account_cosmetics"} {
		var n int
		_ = conn.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n)
		if n != 0 {
			t.Errorf("%s: %d rows left after deleting the account", table, n)
		}
	}
	var logRows int
	_ = conn.QueryRow(ctx, "SELECT count(*) FROM economy_log").Scan(&logRows)
	if logRows != 1 {
		t.Errorf("economy_log rows = %d, want 1", logRows)
	}
}
