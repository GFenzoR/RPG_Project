//go:build integration

package store_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// Pockets (docs/02 "Bolsillos", migration 00020): a character saved before them keeps
// its rows as equipment and gets empty pockets; the pockets' items are top-level rows
// with pocket set, one per cell, apart from the equipment slot of the same number; they
// come back in their cells; and the rollback takes them away with the column.
func TestPocketsMigrationAndRoundTrip(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_pockets"
	st := storetest.Open(t, schema, false)
	if err := st.MigrateUpTo(ctx, 19); err != nil {
		t.Fatal(err)
	}
	conn := storetest.Conn(t, schema)
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

	// A character of the schema before the pockets: a backpack with coins and a sword.
	var acc, id, bag int64
	if err := conn.QueryRow(ctx, "INSERT INTO accounts (email) VALUES ('old@example.org') RETURNING id").Scan(&acc); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `INSERT INTO characters (account_id, name, vocation, health, mana, pos_x, pos_y, pos_z)
		VALUES ($1, 'Antiguo', 'guardian', 10, 0, 5, 5, 7) RETURNING id`, acc).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, "INSERT INTO inventory_items (character_id, slot, item_id) VALUES ($1, 3, 66) RETURNING id", id).Scan(&bag); err != nil {
		t.Fatal(err)
	}
	mustExec("INSERT INTO inventory_items (character_id, container_id, slot, item_id, count) VALUES ($1, $2, 0, 8, 40)", id, bag)
	mustExec("INSERT INTO inventory_items (character_id, slot, item_id) VALUES ($1, 5, 60)", id)

	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	pc, err := st.PlayCharacter(ctx, acc, id, now)
	if err != nil {
		t.Fatal(err)
	}
	old := []store.InventoryItem{
		{ItemID: 66, Count: 1, Slot: 3, Items: []store.InventoryItem{{ItemID: 8, Count: 40, Slot: 0}}},
		{ItemID: 60, Count: 1, Slot: 5},
	}
	if !reflect.DeepEqual(pc.Inventory, old) {
		t.Fatalf("an old inventory after the migration:\n got %+v\nwant %+v", pc.Inventory, old)
	}
	var pocketed int
	if err := conn.QueryRow(ctx, "SELECT count(*) FROM inventory_items WHERE pocket").Scan(&pocketed); err != nil || pocketed != 0 {
		t.Fatalf("%d rows in the pockets after the migration (%v)", pocketed, err)
	}

	// A pocket cell and the equipment slot of the same number are different places; two
	// items in one cell, or a pocket row inside a container, are not.
	mustExec("INSERT INTO inventory_items (character_id, slot, item_id, pocket) VALUES ($1, 3, 68, true)", id)
	mustFail("pocket cell taken", "INSERT INTO inventory_items (character_id, slot, item_id, pocket) VALUES ($1, 3, 60, true)", id)
	mustFail("equipment slot taken", "INSERT INTO inventory_items (character_id, slot, item_id) VALUES ($1, 3, 66)", id)
	mustFail("pocket row in a container", "INSERT INTO inventory_items (character_id, container_id, slot, item_id, pocket) VALUES ($1, $2, 1, 8, true)", id, bag)
	mustExec("DELETE FROM inventory_items WHERE pocket")

	// Saved and loaded: the equipment first, then the cells.
	state := store.CharacterState{ID: id, Level: 1, Health: 10, X: 5, Y: 5, Z: 7, SavedAt: now,
		Inventory: append(old,
			store.InventoryItem{ItemID: 8, Count: 25, Slot: 0, Pocket: true},
			store.InventoryItem{ItemID: 67, Count: 1, Slot: 3, Pocket: true, Items: []store.InventoryItem{{ItemID: 68, Count: 2, Slot: 0}}},
		)}
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	pc, err = st.PlayCharacter(ctx, acc, id, now)
	if err != nil || !reflect.DeepEqual(pc.Inventory, state.Inventory) {
		t.Fatalf("pockets:\n got %+v\nwant %+v (%v)", pc.Inventory, state.Inventory, err)
	}

	// The rollback takes the pockets' rows (and what lies in them) with the column.
	if err := st.MigrateDownTo(ctx, 19); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := conn.QueryRow(ctx, "SELECT count(*) FROM inventory_items WHERE character_id = $1", id).Scan(&left); err != nil || left != 3 {
		t.Fatalf("%d rows left after the rollback, want the 3 of the equipment (%v)", left, err)
	}
	mustFail("equipment slot taken after the rollback", "INSERT INTO inventory_items (character_id, slot, item_id) VALUES ($1, 3, 66)", id)
}
