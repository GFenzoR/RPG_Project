//go:build integration

package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// Market transfers (T5.3): a snapshot and its market changes are written together or not
// at all, two fills of the last unit never both commit, and LoadMarket reads back what
// was written (a restart).
func TestMarketTransfers(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_market"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

	acc, err := st.CreateAccount(ctx, "market@example.org", "h")
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
	sela, uno, dos := char("Sela"), char("Uno"), char("Dos")
	const salve, coin = 68, 1
	state := func(id int64, items ...store.InventoryItem) store.CharacterState {
		return store.CharacterState{ID: id, Level: 1, Health: 1, X: 5, Y: 5, Z: 7, SavedAt: now,
			Inventory: []store.InventoryItem{{ItemID: 66, Count: 1, Slot: 3, Items: items}}}
	}
	units := func(id int64, item int) int {
		t.Helper()
		var n int
		if err := conn.QueryRow(ctx, `SELECT COALESCE(sum(count), 0) FROM inventory_items WHERE character_id = $1 AND item_id = $2`,
			id, item).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	offerLeft := func(id int64) int {
		t.Helper()
		var n int
		err := conn.QueryRow(ctx, `SELECT amount FROM market_offers WHERE id = $1`, id).Scan(&n)
		if err != nil {
			return -1
		}
		return n
	}
	// Sela starts with 10 salves saved.
	if err := st.SaveCharacterState(ctx, state(sela, store.InventoryItem{ItemID: salve, Count: 10})); err != nil {
		t.Fatal(err)
	}
	post := store.Transfer{
		Characters: []store.CharacterState{state(sela, store.InventoryItem{ItemID: salve, Count: 7})},
		Market: []store.MarketOp{{Kind: store.MarketOfferAdd, Offer: store.MarketOffer{ID: 1, CharacterID: sela,
			Side: store.MarketSell, ItemID: salve, Amount: 3, Price: 5, Created: now, Expires: now.Add(time.Hour)}}},
		OfferHigh: 1,
	}

	// A failure injected after the snapshot, inside the transaction: nothing is written,
	// so the salves are neither lost (out of the inventory, not in the offer) nor doubled.
	store.SetTransferHook(func(step int) error {
		if step == 1 {
			return errors.New("injected crash")
		}
		return nil
	})
	if err := st.SaveTransfer(ctx, post); err == nil {
		t.Fatal("the injected failure was ignored")
	}
	store.SetTransferHook(nil)
	if units(sela, salve) != 10 || offerLeft(1) != -1 {
		t.Fatalf("after the failed transfer: %d salves saved, offer %d", units(sela, salve), offerLeft(1))
	}
	// The retry writes both.
	if err := st.SaveTransfer(ctx, post); err != nil {
		t.Fatal(err)
	}
	if units(sela, salve) != 7 || offerLeft(1) != 3 {
		t.Fatalf("after the transfer: %d salves saved, offer %d", units(sela, salve), offerLeft(1))
	}
	// Writing it again (a duplicate) breaks the primary key: permanent, all rolled back.
	if err := st.SaveTransfer(ctx, post); !store.Permanent(err) {
		t.Fatalf("duplicate offer: %v", err)
	}

	// Two buyers of the last 3 units at once: each transfer saves its buyer with the
	// salves and fills the offer; exactly one commits.
	buy := func(id int64) store.Transfer {
		return store.Transfer{
			Characters: []store.CharacterState{state(id, store.InventoryItem{ItemID: salve, Count: 3})},
			Market: []store.MarketOp{
				{Kind: store.MarketOfferFill, ID: 1, Units: 3},
				{Kind: store.MarketGoldAdd, CharacterID: sela, Gold: 15},
				{Kind: store.MarketHistoryAdd, History: store.MarketHistory{CharacterID: sela, Other: id, Side: store.MarketSell,
					ItemID: salve, Amount: 3, Price: 5, At: now}},
				{Kind: store.MarketHistoryAdd, History: store.MarketHistory{CharacterID: id, Other: sela, Side: store.MarketBuy,
					ItemID: salve, Amount: 3, Price: 5, At: now}},
			},
			OfferHigh: 1,
		}
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, id := range []int64{uno, dos} {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = st.SaveTransfer(ctx, buy(id)) }()
	}
	wg.Wait()
	ok := 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case !errors.Is(err, store.ErrMarketConflict):
			t.Fatalf("losing buyer: %v", err)
		}
	}
	if ok != 1 || units(uno, salve)+units(dos, salve) != 3 || offerLeft(1) != -1 {
		t.Fatalf("winners %d, salves %d+%d, offer %d", ok, units(uno, salve), units(dos, salve), offerLeft(1))
	}

	// Mailbox: an item and gold; a withdrawal of more gold than there is fails whole.
	mail := store.Transfer{Market: []store.MarketOp{{Kind: store.MarketMailAdd, Mail: store.MarketMail{ID: 4, CharacterID: uno,
		Item: store.InventoryItem{ItemID: salve, Count: 2}, Created: now}}}, MailHigh: 4}
	if err := st.SaveTransfer(ctx, mail); err != nil {
		t.Fatal(err)
	}
	over := store.Transfer{Characters: []store.CharacterState{state(sela, store.InventoryItem{ItemID: coin, Count: 99})},
		Market: []store.MarketOp{{Kind: store.MarketGoldAdd, CharacterID: sela, Gold: -99}}}
	if err := st.SaveTransfer(ctx, over); !store.Permanent(err) || units(sela, coin) != 0 {
		t.Fatalf("overdrawn mailbox: %v, coins saved %d", err, units(sela, coin))
	}
	// An offer that stays open for the reload.
	open := store.Transfer{Market: []store.MarketOp{{Kind: store.MarketOfferAdd, Offer: store.MarketOffer{ID: 2, CharacterID: dos,
		Side: store.MarketBuy, ItemID: salve, Amount: 4, Price: 6, Created: now, Expires: now.Add(2 * time.Hour)}}},
		OfferHigh: 2, MailHigh: 4}
	if err := st.SaveTransfer(ctx, open); err != nil {
		t.Fatal(err)
	}

	// Restart: everything comes back.
	d, err := st.LoadMarket(ctx, now, 30, 10, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Offers) != 1 || d.Offers[0].ID != 2 || d.Offers[0].Name != "Dos" || d.Offers[0].AccountID != acc {
		t.Fatalf("offers %+v", d.Offers)
	}
	if d.Gold[sela] != 15 || len(d.Mail) != 1 || d.Mail[0].Item.Count != 2 || d.OfferHigh != 2 || d.MailHigh != 4 {
		t.Fatalf("gold %v, mail %+v, high %d/%d", d.Gold, d.Mail, d.OfferHigh, d.MailHigh)
	}
	if len(d.History) != 2 || len(d.Sales) != 1 || d.Sales[0].Units != 3 || d.Sales[0].Total != 15 {
		t.Fatalf("history %+v, sales %+v", d.History, d.Sales)
	}
	if len(d.Bans) != 0 {
		t.Fatalf("bans %v", d.Bans)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO account_bans (account_id, reason, created_at) VALUES ($1, 'x', $2)`, acc, now); err != nil {
		t.Fatal(err)
	}
	if d, err = st.LoadMarket(ctx, now, 30, 10, 5); err != nil || len(d.Bans) != 1 || !d.Bans[acc].IsZero() {
		t.Fatalf("bans %v, %v", d.Bans, err)
	}
}
