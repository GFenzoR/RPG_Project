package store

import (
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// The attributes column: '{}' for a plain item, the object otherwise; both ways.
func TestItemModsColumn(t *testing.T) {
	if got := string(modsJSON(nil)); got != "{}" {
		t.Fatalf("nil = %s", got)
	}
	if got := string(modsJSON(&ItemMods{})); got != "{}" {
		t.Fatalf("zero = %s", got)
	}
	m := &ItemMods{Attribute: "fire_protection", Value: 4, Refine: 1}
	raw := modsJSON(m)
	if string(raw) != `{"attribute":"fire_protection","value":4,"refine":1}` {
		t.Fatalf("json = %s", raw)
	}
	if back, err := modsOf(raw); err != nil || !reflect.DeepEqual(back, m) {
		t.Fatalf("back = %+v, %v", back, err)
	}
	for _, s := range []string{"", "{}"} {
		if back, err := modsOf([]byte(s)); err != nil || back != nil {
			t.Fatalf("%q = %+v, %v", s, back, err)
		}
	}
	if _, err := modsOf([]byte("[")); err == nil {
		t.Fatal("bad json accepted")
	}
}

// inventoryTree puts each row's attributes on its item, nested ones too.
func TestInventoryTreeKeepsMods(t *testing.T) {
	rows := []db.GetCharacterInventoryRow{
		{ID: 1, Slot: 5, ItemID: 60, Count: 1, Attributes: []byte(`{"attribute":"attack","value":2}`)},
		{ID: 2, Slot: 3, ItemID: 66, Count: 1, Attributes: []byte(`{}`)},
		{ID: 3, ContainerID: pgtype.Int8{Int64: 2, Valid: true}, Slot: 0, ItemID: 63, Count: 1,
			Attributes: []byte(`{"attribute":"armor","value":1}`)},
	}
	got := inventoryTree(rows)
	want := []InventoryItem{
		{ItemID: 60, Count: 1, Slot: 5, Mods: &ItemMods{Attribute: "attack", Value: 2}},
		{ItemID: 66, Count: 1, Slot: 3, Items: []InventoryItem{{ItemID: 63, Count: 1, Mods: &ItemMods{Attribute: "armor", Value: 1}}}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	// A row whose attributes do not decode is read as a plain item: the character still
	// plays (its equipable rolls a new attribute when it loads), the rest is intact.
	rows[0].Attributes = []byte(`{"value":"x"}`)
	want[0].Mods = nil
	if got := inventoryTree(rows); !reflect.DeepEqual(got, want) {
		t.Fatalf("with a broken row %+v", got)
	}
}

// A market offer whose attributes do not decode loads as an offer without them: the
// server still starts.
func TestMarketOfferReadsBrokenModsAsNone(t *testing.T) {
	row := db.LoadMarketOffersRow{ID: 7, CharacterID: 3, ItemID: 60, Amount: 1, Price: 50,
		Attributes: []byte(`{"attribute":"attack","value":3}`)}
	if o := marketOffer(row); o.ID != 7 || o.ItemID != 60 || !reflect.DeepEqual(o.Mods, &ItemMods{Attribute: "attack", Value: 3}) {
		t.Fatalf("offer %+v", o)
	}
	row.Attributes = []byte(`[1]`)
	if o := marketOffer(row); o.ID != 7 || o.Price != 50 || o.Mods != nil {
		t.Fatalf("offer with broken mods %+v", o)
	}
}
