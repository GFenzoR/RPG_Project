package app

import (
	"reflect"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
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

// Final review of lote 11: a hand edit of the database can save any number; the loop gets
// a refine level in 0..MaxRefineLevel and a value in 0..MaxAttributeValue (a negative
// level would index the forge's table before its first level).
func TestSavedModsOutOfRangeAreBounded(t *testing.T) {
	for _, c := range []struct {
		in   store.ItemMods
		want session.Mods
	}{
		{store.ItemMods{Attribute: "attack", Value: 2, Refine: -3}, session.Mods{Attr: "attack", Value: 2}},
		{store.ItemMods{Attribute: "attack", Value: -5, Refine: 99}, session.Mods{Attr: "attack", Refine: content.MaxRefineLevel}},
		{store.ItemMods{Attribute: "max_health", Value: 1 << 30, Refine: 4},
			session.Mods{Attr: "max_health", Value: content.MaxAttributeValue, Refine: 4}},
	} {
		if got := sessionMods(&c.in); got != c.want {
			t.Errorf("sessionMods(%+v) = %+v, want %+v", c.in, got, c.want)
		}
	}
}

// A snapshot's pockets are saved as pockets (docs/02 "Bolsillos", migration 00020), apart
// from the equipment slot of the same number.
func TestPocketsConvert(t *testing.T) {
	in := []session.ItemState{
		{ItemID: 66, Count: 1, Slot: 3, Items: []session.ItemState{{ItemID: 68, Count: 9}}},
		{ItemID: 8, Count: 40, Slot: 3, Pocket: true},
	}
	out := storeItems(in)
	if len(out) != 2 || out[0].Pocket || out[0].Items[0].Pocket || !out[1].Pocket || out[1].Slot != 3 {
		t.Fatalf("to the store: %+v", out)
	}
}
