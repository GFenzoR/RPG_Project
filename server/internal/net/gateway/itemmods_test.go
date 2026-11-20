package gateway

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// A login reads each saved instance with its mods (docs/02 "Atributos de items").
func TestItemStatesKeepMods(t *testing.T) {
	in := []store.InventoryItem{
		{ItemID: 60, Count: 1, Slot: 5, Mods: &store.ItemMods{Attribute: "attack", Value: 3}},
		{ItemID: 66, Count: 1, Slot: 3, Items: []store.InventoryItem{{ItemID: 63, Count: 1, Mods: &store.ItemMods{Attribute: "armor", Value: 1, Refine: 1}}}},
	}
	got := itemStates(in)
	if len(got) != 2 || got[0].Mods != (session.Mods{Attr: "attack", Value: 3}) || !got[1].Mods.Zero() ||
		got[1].Items[0].Mods != (session.Mods{Attr: "armor", Value: 1, Refine: 1}) {
		t.Fatalf("itemStates = %+v", got)
	}
}

// A login reads which saved items lie in the pockets (docs/02 "Bolsillos", migration 00020).
func TestItemStatesKeepThePockets(t *testing.T) {
	in := []store.InventoryItem{
		{ItemID: 66, Count: 1, Slot: 3},
		{ItemID: 8, Count: 40, Slot: 3, Pocket: true},
	}
	got := itemStates(in)
	if len(got) != 2 || got[0].Pocket || !got[1].Pocket || got[1].Slot != 3 || got[1].Count != 40 {
		t.Fatalf("itemStates = %+v", got)
	}
}
