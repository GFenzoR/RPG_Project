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

// Item attributes (docs/02 "Atributos de items", migration 00019): an instance's mods
// come back exactly from every table that stores items: the inventory (nested too), a
// sell offer, a mailbox entry, a house floor and the economy log.
func TestItemModsRoundTrip(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_item_mods"
	st := storetest.Open(t, schema, true)
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	acc, err := st.CreateAccount(ctx, "mods@example.org", "h")
	if err != nil {
		t.Fatal(err)
	}
	c, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: "Forja", Vocation: "guardian", Health: 1}, 20)
	if err != nil {
		t.Fatal(err)
	}
	attack := &store.ItemMods{Attribute: "attack", Value: 3}
	armor := &store.ItemMods{Attribute: "armor", Value: 1, Refine: 2}

	// The inventory: an equipped sword and, inside a bag in the backpack, a tunic; the
	// plain items stay without mods.
	state := store.CharacterState{ID: c.ID, Level: 5, Health: 1, X: 5, Y: 5, Z: 7, SavedAt: now,
		Inventory: []store.InventoryItem{
			{ItemID: 60, Count: 1, Slot: 5, Mods: attack},
			{ItemID: 66, Count: 1, Slot: 3, Items: []store.InventoryItem{
				{ItemID: 68, Count: 12, Slot: 0},
				{ItemID: 67, Count: 1, Slot: 1, Items: []store.InventoryItem{{ItemID: 63, Count: 1, Slot: 0, Mods: armor}}},
			}},
		}}
	if err := st.SaveCharacterState(ctx, state); err != nil {
		t.Fatal(err)
	}
	pc, err := st.PlayCharacter(ctx, acc, c.ID, now)
	if err != nil || !reflect.DeepEqual(pc.Inventory, state.Inventory) {
		t.Fatalf("inventory:\n got %+v\nwant %+v (%v)", pc.Inventory, state.Inventory, err)
	}

	// A sell offer of one instance and a mailbox entry, in one transfer.
	state.Inventory = state.Inventory[1:]
	tr := store.Transfer{ID: 1, OfferHigh: 1, MailHigh: 1, Characters: []store.CharacterState{state},
		Market: []store.MarketOp{
			{Kind: store.MarketOfferAdd, Offer: store.MarketOffer{ID: 1, CharacterID: c.ID, Side: store.MarketSell,
				ItemID: 60, Amount: 1, Price: 50, Created: now, Expires: now.Add(time.Hour), Mods: attack}},
			{Kind: store.MarketOfferAdd, Offer: store.MarketOffer{ID: 2, CharacterID: c.ID, Side: store.MarketBuy,
				ItemID: 60, Amount: 2, Price: 10, Created: now, Expires: now.Add(time.Hour)}},
			{Kind: store.MarketMailAdd, Mail: store.MarketMail{ID: 1, CharacterID: c.ID, Created: now,
				Item: store.InventoryItem{ItemID: 63, Count: 1, Mods: armor}}},
		}}
	tr.OfferHigh = 2
	if err := st.SaveTransfer(ctx, tr); err != nil {
		t.Fatal(err)
	}
	md, err := st.LoadMarket(ctx, now, 30, 10, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(md.Offers) != 2 || !reflect.DeepEqual(md.Offers[0].Mods, attack) || md.Offers[1].Mods != nil {
		t.Fatalf("offers %+v", md.Offers)
	}
	if len(md.Mail) != 1 || !reflect.DeepEqual(md.Mail[0].Item.Mods, armor) {
		t.Fatalf("mail %+v", md.Mail)
	}

	// A house floor.
	tr = store.Transfer{ID: 2, OfferHigh: 2, MailHigh: 1, Houses: []store.HouseOp{
		{Kind: store.HouseOwnerAdd, House: "cottage", Owner: store.HouseOwner{HouseID: "cottage", CharacterID: c.ID,
			AccountID: acc, PaidUntil: now.Add(time.Hour), Since: now}},
		{Kind: store.HouseItems, House: "cottage", Items: []store.HouseItem{
			{HouseID: "cottage", X: 2, Y: 2, Z: 7, Seq: 0, Item: store.InventoryItem{ItemID: 60, Count: 1, Mods: attack}}}},
	}}
	if err := st.SaveTransfer(ctx, tr); err != nil {
		t.Fatal(err)
	}
	hd, err := st.LoadHouses(ctx)
	if err != nil || len(hd.Items) != 1 || !reflect.DeepEqual(hd.Items[0].Item.Mods, attack) {
		t.Fatalf("house items %+v (%v)", hd.Items, err)
	}

	// The economy log names the instance.
	es := []store.EconomyEntry{{At: now, Kind: "npc_buy", CharacterID: c.ID, ItemID: 60, Count: 1, Ref: "armorer", Mods: attack},
		{At: now, Kind: "loot", CharacterID: c.ID, ItemID: 68, Count: 3, Ref: "wolf"}}
	if err := st.AppendEconomy(ctx, "mods", es); err != nil {
		t.Fatal(err)
	}
	got, err := st.ListEconomy(ctx, c.ID, 10)
	if err != nil || len(got) != 2 || !reflect.DeepEqual(got[1].Mods, attack) || got[1].Ref != "armorer" ||
		got[0].Mods != nil {
		t.Fatalf("economy %+v (%v)", got, err)
	}
}
