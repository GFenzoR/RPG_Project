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
	nextID := int64(0)
	id := func() int64 { nextID++; return nextID }
	post := store.Transfer{
		ID:         id(),
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
	// A retry of the same transfer (its COMMIT went through, the answer was lost) is a
	// no-op: nothing is applied twice.
	if err := st.SaveTransfer(ctx, post); err != nil || offerLeft(1) != 3 {
		t.Fatalf("retry of a stored transfer: %v, offer %d", err, offerLeft(1))
	}
	// The same rows under a new id (a bug) break the primary key: permanent, rolled back.
	dup := post
	dup.ID = id()
	if err := st.SaveTransfer(ctx, dup); !store.Permanent(err) {
		t.Fatalf("duplicate offer: %v", err)
	}

	// Two buyers of the last 3 units at once: each transfer saves its buyer with the
	// salves and fills the offer; exactly one commits.
	buy := func(char, tid int64) store.Transfer {
		return store.Transfer{
			ID:         tid,
			Characters: []store.CharacterState{state(char, store.InventoryItem{ItemID: salve, Count: 3})},
			Market: []store.MarketOp{
				{Kind: store.MarketOfferFill, ID: 1, Units: 3},
				{Kind: store.MarketGoldAdd, CharacterID: sela, Gold: 15},
				{Kind: store.MarketHistoryAdd, History: store.MarketHistory{CharacterID: sela, Other: char, Side: store.MarketSell,
					ItemID: salve, Amount: 3, Price: 5, At: now}},
				{Kind: store.MarketHistoryAdd, History: store.MarketHistory{CharacterID: char, Other: sela, Side: store.MarketBuy,
					ItemID: salve, Amount: 3, Price: 5, At: now}},
			},
			OfferHigh: 1,
		}
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	// Two loops cannot write the same market, but the database must hold anyway: distinct
	// transfer ids, the same unit.
	tids := []int64{id(), id()}
	for i, c := range []int64{uno, dos} {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = st.SaveTransfer(ctx, buy(c, tids[i])) }()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil && !errors.Is(err, store.ErrMarketConflict) {
			t.Fatalf("losing buyer: %v", err)
		}
	}
	// Exactly one got the unit (the other either finds it gone or, with the lower id,
	// is taken for a retry of an older transfer and applies nothing).
	if units(uno, salve)+units(dos, salve) != 3 || offerLeft(1) != -1 {
		t.Fatalf("salves %d+%d, offer %d", units(uno, salve), units(dos, salve), offerLeft(1))
	}
	// A later fill of the gone offer fails whole: the buyer's snapshot is not saved.
	late := buy(sela, id())
	if err := st.SaveTransfer(ctx, late); !errors.Is(err, store.ErrMarketConflict) || units(sela, salve) != 7 {
		t.Fatalf("fill of a gone offer: %v, seller salves %d", err, units(sela, salve))
	}

	// Mailbox: an item and gold; a withdrawal of more gold than there is fails whole.
	mail := store.Transfer{ID: id() + 10, Market: []store.MarketOp{{Kind: store.MarketMailAdd, Mail: store.MarketMail{ID: 4, CharacterID: uno,
		Item: store.InventoryItem{ItemID: salve, Count: 2}, Created: now}}}, MailHigh: 4}
	if err := st.SaveTransfer(ctx, mail); err != nil {
		t.Fatal(err)
	}
	over := store.Transfer{ID: 100, Characters: []store.CharacterState{state(sela, store.InventoryItem{ItemID: coin, Count: 99})},
		Market: []store.MarketOp{{Kind: store.MarketGoldAdd, CharacterID: sela, Gold: -99}}}
	if err := st.SaveTransfer(ctx, over); !store.Permanent(err) || units(sela, coin) != 0 {
		t.Fatalf("overdrawn mailbox: %v, coins saved %d", err, units(sela, coin))
	}
	// A withdrawal of what there is works (5 of 15), with the snapshot that receives it.
	take := store.Transfer{ID: 100, Characters: []store.CharacterState{state(sela, store.InventoryItem{ItemID: coin, Count: 5})},
		Market: []store.MarketOp{{Kind: store.MarketGoldAdd, CharacterID: sela, Gold: -5}}}
	if err := st.SaveTransfer(ctx, take); err != nil || units(sela, coin) != 5 {
		t.Fatalf("withdrawal: %v, coins saved %d", err, units(sela, coin))
	}
	// (The overdraw rolled back, its id too: the withdrawal reuses 100.) From a mailbox
	// that never had gold: a conflict, nothing written.
	none := store.Transfer{ID: 101, Market: []store.MarketOp{{Kind: store.MarketGoldAdd, CharacterID: dos, Gold: -1}}}
	if err := st.SaveTransfer(ctx, none); !errors.Is(err, store.ErrMarketConflict) {
		t.Fatalf("withdrawal from an empty mailbox: %v", err)
	}
	// An offer that stays open for the reload.
	open := store.Transfer{ID: 102, Market: []store.MarketOp{{Kind: store.MarketOfferAdd, Offer: store.MarketOffer{ID: 2, CharacterID: dos,
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
	if d.TransferHigh != 102 {
		t.Fatalf("transfer high %d", d.TransferHigh)
	}
	if d.Gold[sela] != 10 || len(d.Mail) != 1 || d.Mail[0].Item.Count != 2 || d.OfferHigh != 2 || d.MailHigh != 4 {
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

	// Closing an offer whose units the loop has wrong (a fill of it was not stored) fails
	// whole: the database keeps the offer and nothing smaller reaches the mailbox.
	sellOffer := store.Transfer{ID: 103, Market: []store.MarketOp{{Kind: store.MarketOfferAdd, Offer: store.MarketOffer{ID: 3,
		CharacterID: sela, Side: store.MarketSell, ItemID: salve, Amount: 10, Price: 4, Created: now, Expires: now.Add(time.Hour)}}},
		OfferHigh: 3, MailHigh: 4}
	if err := st.SaveTransfer(ctx, sellOffer); err != nil {
		t.Fatal(err)
	}
	cancelSell := store.Transfer{ID: 104, Market: []store.MarketOp{
		{Kind: store.MarketOfferRemove, ID: 3, Units: 5},
		{Kind: store.MarketMailAdd, Mail: store.MarketMail{ID: 5, CharacterID: sela, Item: store.InventoryItem{ItemID: salve, Count: 5}, Created: now}},
	}, OfferHigh: 3, MailHigh: 5}
	if err := st.SaveTransfer(ctx, cancelSell); !errors.Is(err, store.ErrMarketConflict) || offerLeft(3) != 10 {
		t.Fatalf("sell offer closed with the wrong units: %v, left %d", err, offerLeft(3))
	}
	cancelBuy := store.Transfer{ID: 104, Market: []store.MarketOp{
		{Kind: store.MarketOfferRemove, ID: 2, Units: 3}, // the database has 4
		{Kind: store.MarketGoldAdd, CharacterID: dos, Gold: 18},
	}}
	if err := st.SaveTransfer(ctx, cancelBuy); !errors.Is(err, store.ErrMarketConflict) || offerLeft(2) != 4 {
		t.Fatalf("buy offer closed with the wrong units: %v, left %d", err, offerLeft(2))
	}
	// With the right units it closes.
	cancelBuy.Market[0].Units, cancelBuy.Market[1].Gold = 4, 24
	if err := st.SaveTransfer(ctx, cancelBuy); err != nil || offerLeft(2) != -1 {
		t.Fatalf("buy offer closed: %v, left %d", err, offerLeft(2))
	}
}
