//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// Account stash (docs/02 "Baúl de la cuenta"): a move writes the character and the
// stash together or not at all; every character of the account reads the same stash back,
// with each instance whole (mods, content), cells in order.
func TestStashTransfers(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_stash"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)

	acc, err := st.CreateAccount(ctx, "baul@example.org", "h")
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
	ana, alba := char("Ana"), char("Alba")
	const sword, salve, bag = 60, 68, 67
	state := func(id int64, items ...store.InventoryItem) store.CharacterState {
		return store.CharacterState{ID: id, Level: 10, Health: 1, X: 3, Y: 3, Z: 7, SavedAt: now,
			Inventory: []store.InventoryItem{{ItemID: 66, Count: 1, Slot: 3, Items: items}}}
	}
	inStash := func() int {
		var n int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM account_stash_items WHERE account_id = $1`, acc).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	refined := &store.ItemMods{Attribute: "armor", Value: 3, Refine: 2}
	stash := []store.InventoryItem{
		{ItemID: salve, Count: 20},
		{ItemID: sword, Count: 1, Mods: refined},
		{ItemID: bag, Count: 1, Items: []store.InventoryItem{{ItemID: salve, Count: 3}}},
	}

	// Ana deposits: her inventory and the stash in one transaction.
	if err := st.SaveTransfer(ctx, store.Transfer{ID: 1, Characters: []store.CharacterState{state(ana)},
		Stash: []store.StashOp{{AccountID: acc, Items: stash}}}); err != nil {
		t.Fatal(err)
	}
	// Alba reads the same stash, whole and in order.
	pc, err := st.PlayCharacter(ctx, acc, alba, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(pc.Stash) != 3 || pc.Stash[0].ItemID != salve || pc.Stash[0].Count != 20 || pc.Stash[1].Slot != 1 ||
		pc.Stash[1].Mods == nil || *pc.Stash[1].Mods != *refined || len(pc.Stash[2].Items) != 1 ||
		pc.Stash[2].Items[0].Count != 3 {
		t.Fatalf("Alba read %+v", pc.Stash)
	}

	// A withdrawal that fails inside its transaction leaves both sides as they were.
	boom := errors.New("boom")
	store.SetTransferHook(func(int) error { return boom })
	err = st.SaveTransfer(ctx, store.Transfer{ID: 2, Characters: []store.CharacterState{state(alba, store.InventoryItem{ItemID: sword, Count: 1, Mods: refined})},
		Stash: []store.StashOp{{AccountID: acc, Items: []store.InventoryItem{stash[0], stash[2]}}}})
	store.SetTransferHook(nil)
	if !errors.Is(err, boom) {
		t.Fatalf("hooked transfer: %v", err)
	}
	if inStash() != 3 {
		t.Fatal("a rolled back withdrawal changed the stash")
	}
	var swords int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM inventory_items WHERE character_id = $1 AND item_id = $2`,
		alba, sword).Scan(&swords); err != nil || swords != 0 {
		t.Fatalf("a rolled back withdrawal reached Alba: %d swords (%v)", swords, err)
	}

	// Written, the stash drops to two cells (renumbered 0 and 1) and Alba has the sword.
	if err := st.SaveTransfer(ctx, store.Transfer{ID: 3, Characters: []store.CharacterState{state(alba, store.InventoryItem{ItemID: sword, Count: 1, Mods: refined})},
		Stash: []store.StashOp{{AccountID: acc, Items: []store.InventoryItem{stash[0], stash[2]}}}}); err != nil {
		t.Fatal(err)
	}
	pc, err = st.PlayCharacter(ctx, acc, ana, now)
	if err != nil || len(pc.Stash) != 2 || pc.Stash[1].ItemID != bag || pc.Stash[1].Slot != 1 {
		t.Fatalf("after the withdrawal Ana reads %+v (%v)", pc.Stash, err)
	}
	// An empty stash has no rows.
	if err := st.SaveTransfer(ctx, store.Transfer{ID: 4, Stash: []store.StashOp{{AccountID: acc}}}); err != nil {
		t.Fatal(err)
	}
	if inStash() != 0 {
		t.Fatal("an emptied stash kept rows")
	}
}
