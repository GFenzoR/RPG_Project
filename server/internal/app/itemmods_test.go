package app

import (
	"reflect"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// An instance's mods survive the conversions between the loop and the store both ways
// (snapshots, mailbox and house items, market offers).
func TestItemModsConvert(t *testing.T) {
	in := []session.ItemState{
		{ItemID: 60, Count: 1, Slot: 5, Mods: session.Mods{Attr: "attack", Value: 3}},
		{ItemID: 66, Count: 1, Slot: 3, Items: []session.ItemState{
			{ItemID: 68, Count: 9},
			{ItemID: 63, Count: 1, Slot: 1, Mods: session.Mods{Attr: "armor", Value: 1, Refine: 2}},
		}},
	}
	out := storeItems(in)
	if out[0].Mods == nil || *out[0].Mods != (store.ItemMods{Attribute: "attack", Value: 3}) ||
		out[1].Mods != nil || out[1].Items[0].Mods != nil ||
		*out[1].Items[1].Mods != (store.ItemMods{Attribute: "armor", Value: 1, Refine: 2}) {
		t.Fatalf("to the store: %+v", out)
	}
	var back []session.ItemState
	for _, it := range out {
		back = append(back, sessionItem(it))
	}
	if !reflect.DeepEqual(back, in) {
		t.Fatalf("back:\n got %+v\nwant %+v", back, in)
	}
}

// The economy log never merges two instances with mods into one row.
func TestCoalesceKeepsInstances(t *testing.T) {
	a, b := session.Mods{Attr: "attack", Value: 1}, session.Mods{Attr: "attack", Value: 2}
	in := []session.EconomyEntry{
		{Kind: "npc_buy", CharacterID: 1, ItemID: 60, Count: 1, Mods: a},
		{Kind: "npc_buy", CharacterID: 1, ItemID: 60, Count: 1, Mods: b},
		{Kind: "npc_buy", CharacterID: 1, ItemID: 68, Count: 1},
		{Kind: "npc_buy", CharacterID: 1, ItemID: 68, Count: 1},
	}
	out := coalesce(in)
	if len(out) != 3 || *out[0].Mods != (store.ItemMods{Attribute: "attack", Value: 1}) ||
		*out[1].Mods != (store.ItemMods{Attribute: "attack", Value: 2}) || out[2].Count != 2 || out[2].Mods != nil {
		t.Fatalf("coalesce = %+v", out)
	}
}
