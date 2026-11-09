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

// Houses (T5.4): the items of a house and the inventory of the mover are written
// together or not at all, a restart reads back what was written, one house has one
// owner and one account one house, and releasing a house sends its items to the mailbox
// in the same transaction.
func TestHouseTransfers(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_houses"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

	account := func(email string) int64 {
		t.Helper()
		acc, err := st.CreateAccount(ctx, email, "h")
		if err != nil {
			t.Fatal(err)
		}
		return acc
	}
	accA, accB := account("casa-a@example.org"), account("casa-b@example.org")
	char := func(acc int64, name string) int64 {
		t.Helper()
		c, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: name, Vocation: "guardian", Health: 1}, 20)
		if err != nil {
			t.Fatal(err)
		}
		return c.ID
	}
	ana, alba, beto := char(accA, "Ana"), char(accA, "Alba"), char(accB, "Beto")
	const sword, salve = 60, 68
	state := func(id int64, items ...store.InventoryItem) store.CharacterState {
		return store.CharacterState{ID: id, Level: 10, Health: 1, X: 3, Y: 3, Z: 7, SavedAt: now,
			Inventory: []store.InventoryItem{{ItemID: 66, Count: 1, Slot: 3, Items: items}}}
	}
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := conn.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	inInventory := func(id int64, item int) int {
		return count(`SELECT COALESCE(sum(count), 0) FROM inventory_items WHERE character_id = $1 AND item_id = $2`, id, item)
	}
	inHouse := func(house string) int {
		return count(`SELECT count(*) FROM house_items WHERE house_id = $1`, house)
	}
	nextID := int64(0)
	id := func() int64 { nextID++; return nextID }
	owner := store.HouseOwner{HouseID: "cottage", CharacterID: ana, AccountID: accA, PaidUntil: now.Add(7 * 24 * time.Hour), Since: now}

	// Ana rents and has a sword and 5 salves saved.
	if err := st.SaveTransfer(ctx, store.Transfer{ID: id(),
		Characters: []store.CharacterState{state(ana, store.InventoryItem{ItemID: sword, Count: 1}, store.InventoryItem{ItemID: salve, Count: 5, Slot: 1})},
		Houses:     []store.HouseOp{{Kind: store.HouseOwnerAdd, House: "cottage", Owner: owner}}}); err != nil {
		t.Fatal(err)
	}
	// One house, one owner; one account, one house.
	taken := store.Transfer{ID: id(), Houses: []store.HouseOp{{Kind: store.HouseOwnerAdd, House: "cottage",
		Owner: store.HouseOwner{HouseID: "cottage", CharacterID: beto, AccountID: accB, PaidUntil: now, Since: now}}}}
	if err := st.SaveTransfer(ctx, taken); err == nil || !store.Permanent(err) {
		t.Fatalf("second owner of a house: %v", err)
	}
	second := store.Transfer{ID: id(), Houses: []store.HouseOp{{Kind: store.HouseOwnerAdd, House: "shed",
		Owner: store.HouseOwner{HouseID: "shed", CharacterID: alba, AccountID: accA, PaidUntil: now, Since: now}}}}
	if err := st.SaveTransfer(ctx, second); err == nil || !store.Permanent(err) {
		t.Fatalf("second house of an account: %v", err)
	}

	// Drop the sword (in a container with the salves) on the floor: a crash injected after
	// the snapshot and the house items, inside the transaction, writes nothing — the sword
	// is neither lost nor in both places.
	bag := store.InventoryItem{ItemID: 67, Count: 1, Items: []store.InventoryItem{{ItemID: salve, Count: 5}}}
	drop := store.Transfer{ID: id(),
		Characters: []store.CharacterState{state(ana)},
		Houses: []store.HouseOp{{Kind: store.HouseItems, House: "cottage", Items: []store.HouseItem{
			{HouseID: "cottage", X: 3, Y: 3, Z: 7, Seq: 0, Item: store.InventoryItem{ItemID: sword, Count: 1}},
			{HouseID: "cottage", X: 3, Y: 3, Z: 7, Seq: 1, Item: bag},
		}}}}
	store.SetTransferHook(func(step int) error {
		if step == 0 {
			return errors.New("injected crash")
		}
		return nil
	})
	if err := st.SaveTransfer(ctx, drop); err == nil {
		t.Fatal("the injected crash did not fail the transfer")
	}
	store.SetTransferHook(nil)
	if inInventory(ana, sword) != 1 || inHouse("cottage") != 0 {
		t.Fatalf("after the crash: sword in the inventory %d, items in the house %d", inInventory(ana, sword), inHouse("cottage"))
	}
	if err := st.SaveTransfer(ctx, drop); err != nil {
		t.Fatal(err)
	}
	if inInventory(ana, sword) != 0 || inHouse("cottage") != 2 {
		t.Fatalf("after the drop: sword in the inventory %d, items in the house %d", inInventory(ana, sword), inHouse("cottage"))
	}
	// A retry of a committed transfer applies nothing again.
	if err := st.SaveTransfer(ctx, drop); err != nil || inHouse("cottage") != 2 {
		t.Fatalf("retry: %v, %d items", err, inHouse("cottage"))
	}

	// Guests and the guild switch.
	if err := st.SaveTransfer(ctx, store.Transfer{ID: id(), Houses: []store.HouseOp{{Kind: store.HouseAccess,
		House: "cottage", CharacterID: ana, GuildAccess: true, Guests: []string{"Beto", "Cid"}}}}); err != nil {
		t.Fatal(err)
	}

	// Restart: everything comes back.
	d, err := st.LoadHouses(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Owners) != 1 || d.Owners[0].Name != "Ana" || d.Owners[0].AccountID != accA || !d.Owners[0].GuildAccess ||
		!d.Owners[0].PaidUntil.Equal(owner.PaidUntil) {
		t.Fatalf("owners %+v", d.Owners)
	}
	if len(d.Guests["cottage"]) != 2 || len(d.Items) != 2 || d.Items[1].Item.ItemID != 67 || len(d.Items[1].Item.Items) != 1 {
		t.Fatalf("guests %v, items %+v", d.Guests, d.Items)
	}
	pub, err := st.PublicHouses(ctx, now)
	if err != nil || len(pub) != 1 || pub[0].Name != "Ana" {
		t.Fatalf("public %+v, %v", pub, err)
	}

	// A change of an owner the database does not have fails whole (and is permanent).
	wrong := store.Transfer{ID: id(), Houses: []store.HouseOp{{Kind: store.HousePaid, House: "cottage", CharacterID: beto,
		PaidUntil: now}}}
	if err := st.SaveTransfer(ctx, wrong); !errors.Is(err, store.ErrHouseConflict) || !store.Permanent(err) {
		t.Fatalf("paid by a stranger: %v", err)
	}

	// Transfer to Beto: the items go to Ana's mailbox, the price too, the guests go.
	give := store.Transfer{ID: id(), Characters: []store.CharacterState{state(beto)},
		Houses: []store.HouseOp{
			{Kind: store.HouseItems, House: "cottage"},
			{Kind: store.HouseOwnerChange, House: "cottage", CharacterID: ana,
				Owner: store.HouseOwner{HouseID: "cottage", CharacterID: beto, AccountID: accB, PaidUntil: owner.PaidUntil, Since: now}},
		},
		Market: []store.MarketOp{
			{Kind: store.MarketGoldAdd, CharacterID: ana, Gold: 80},
			{Kind: store.MarketMailAdd, Mail: store.MarketMail{ID: 1, CharacterID: ana, Item: store.InventoryItem{ItemID: sword, Count: 1}, Created: now}},
			{Kind: store.MarketMailAdd, Mail: store.MarketMail{ID: 2, CharacterID: ana, Item: bag, Created: now}},
		}, MailHigh: 2}
	if err := st.SaveTransfer(ctx, give); err != nil {
		t.Fatal(err)
	}
	if d, err = st.LoadHouses(ctx); err != nil || len(d.Owners) != 1 || d.Owners[0].CharacterID != beto ||
		len(d.Guests["cottage"]) != 0 || len(d.Items) != 0 || d.Owners[0].GuildAccess {
		t.Fatalf("after the transfer %+v, %v", d, err)
	}
	m, err := st.LoadMarket(ctx, now, 30, 10, 5)
	if err != nil || m.Gold[ana] != 80 || len(m.Mail) != 2 || len(m.Mail[1].Item.Items) != 1 {
		t.Fatalf("Ana's mailbox %v %+v, %v", m.Gold, m.Mail, err)
	}

	// Release: the owner row and its guests go; Ana may rent again.
	if err := st.SaveTransfer(ctx, store.Transfer{ID: id(), Houses: []store.HouseOp{
		{Kind: store.HouseOwnerRemove, House: "cottage", CharacterID: beto}}}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveTransfer(ctx, store.Transfer{ID: id(), Houses: []store.HouseOp{{Kind: store.HouseOwnerAdd, House: "shed",
		Owner: store.HouseOwner{HouseID: "shed", CharacterID: alba, AccountID: accA, PaidUntil: now, Since: now}}}}); err != nil {
		t.Fatal(err)
	}
}
