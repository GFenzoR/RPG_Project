package app

import (
	"context"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// The loop's house changes and the store's are the same numbers (T5.4).
func TestHouseOpsMatch(t *testing.T) {
	pairs := map[session.HouseOpKind]store.HouseOpKind{
		session.HouseOwnerAdd: store.HouseOwnerAdd, session.HouseOwnerChange: store.HouseOwnerChange,
		session.HouseOwnerRemove: store.HouseOwnerRemove, session.HousePaid: store.HousePaid,
		session.HouseAccess: store.HouseAccess, session.HouseItems: store.HouseItems,
	}
	for s, st := range pairs {
		if uint8(s) != uint8(st) {
			t.Errorf("session %d != store %d", s, st)
		}
	}
}

type fakeHouses struct{ d store.HouseData }

func (f fakeHouses) LoadHouses(context.Context) (store.HouseData, error) { return f.d, nil }

// What the store loads reaches the loop as written, and what the loop writes reaches the
// store with the instance (containers with their content).
func TestHouseConversions(t *testing.T) {
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	bag := store.InventoryItem{ItemID: 67, Count: 1, Items: []store.InventoryItem{{ItemID: 68, Count: 5}}}
	d, err := loadHouses(fakeHouses{store.HouseData{
		Owners: []store.HouseOwner{{HouseID: "cottage", CharacterID: 4, AccountID: 2, Name: "Ana", PaidUntil: now, Since: now}},
		Guests: map[string][]string{"cottage": {"Beto"}},
		Items:  []store.HouseItem{{HouseID: "cottage", X: 3, Y: 4, Z: 7, Seq: 1, Item: bag}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Owners) != 1 || d.Owners[0].AccountID != 2 || d.Guests["cottage"][0] != "Beto" || len(d.Items) != 1 ||
		d.Items[0].Pos != (world.Pos{X: 3, Y: 4, Z: 7}) || d.Items[0].Seq != 1 || len(d.Items[0].Item.Items) != 1 {
		t.Fatalf("loaded %+v", d)
	}
	op := storeHouseOp(session.HouseOp{Kind: session.HouseItems, House: "cottage", Items: d.Items})
	if op.Kind != store.HouseItems || len(op.Items) != 1 || op.Items[0].X != 3 || op.Items[0].Item.ItemID != 67 ||
		len(op.Items[0].Item.Items) != 1 || op.Items[0].Item.Items[0].Count != 5 {
		t.Fatalf("stored %+v", op)
	}
}
