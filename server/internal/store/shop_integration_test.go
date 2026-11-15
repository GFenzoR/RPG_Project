//go:build integration

package store_test

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// The cosmetic shop (T5.7): a payment credits once however many times its webhook comes,
// concurrent purchases never spend more than the balance, a reversal debits what is
// left and flags the account, and the ledger is append-only.
func TestShopPaymentsAndPurchases(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_shop"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

	if err := st.SyncCosmetics(ctx, []store.CosmeticRow{
		{ID: "outfit_sailor", Kind: "outfit", Price: 300}, {ID: "color_tide", Kind: "outfit_color", Price: 120},
		{ID: "name_gilded", Kind: "name_effect", Price: 200}, {ID: "old_hat", Kind: "outfit", Price: 50},
	}); err != nil {
		t.Fatal(err)
	}
	// A cosmetic leaving the catalog stays in the table but is no longer sold.
	if err := st.SyncCosmetics(ctx, []store.CosmeticRow{
		{ID: "outfit_sailor", Kind: "outfit", Price: 300}, {ID: "color_tide", Kind: "outfit_color", Price: 120},
		{ID: "name_gilded", Kind: "name_effect", Price: 200},
	}); err != nil {
		t.Fatal(err)
	}
	acc, err := st.CreateAccount(ctx, "shop@example.org", "h")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: "Shopper", Vocation: "guardian", Health: 1}, 20); err != nil {
		t.Fatal(err)
	}
	pay := func(event, typ, payment string) store.PaymentResult {
		t.Helper()
		r, err := st.ApplyPayment(ctx, store.PaymentEvent{Provider: "fake", EventID: event, Type: typ, PaymentID: payment,
			AccountID: acc, PackID: "pack_small", AmountMinor: 1990, Currency: "CLP", Premium: 500, At: now})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	// Paid: credited once, even with duplicate (and concurrent duplicate) webhooks.
	var wg sync.WaitGroup
	results := make([]store.PaymentResult, 8)
	for i := range results {
		wg.Add(1)
		go func() { defer wg.Done(); results[i] = pay("p1:paid", "paid", "p1") }()
	}
	wg.Wait()
	credited := 0
	for _, r := range results {
		switch r.Result {
		case store.PaymentCredited:
			credited++
		case store.PaymentDuplicate:
		default:
			t.Errorf("result %q", r.Result)
		}
	}
	if credited != 1 {
		t.Fatalf("credited %d times", credited)
	}
	// Another event id for the same paid payment (a provider retry with a new id) does
	// not credit again either.
	if r := pay("p1:paid:again", "paid", "p1"); r.Result != store.PaymentIgnored {
		t.Fatalf("second paid event %+v", r)
	}
	s, err := st.ShopState(ctx, acc, now)
	if err != nil || s.Balance != 500 || s.Blocked {
		t.Fatalf("state %+v %v", s, err)
	}
	if n, err := st.PremiumBoughtSince(ctx, acc, now.Add(-24*time.Hour)); err != nil || n != 500 {
		t.Fatalf("bought %d %v", n, err)
	}
	if n, _ := st.PremiumBoughtSince(ctx, acc, now.Add(time.Second)); n != 0 {
		t.Fatalf("bought after now %d", n)
	}

	// Concurrent purchases: 500 covers 300 + 120 but never two outfits.
	type out struct {
		p   store.Purchase
		err error
	}
	buys := make([]out, 6)
	for i := range buys {
		wg.Add(1)
		id := "outfit_sailor"
		if i%2 == 1 {
			id = "color_tide"
		}
		go func() { defer wg.Done(); p, err := st.BuyCosmetic(ctx, acc, id, now); buys[i] = out{p, err} }()
	}
	wg.Wait()
	ok := 0
	for _, b := range buys {
		switch {
		case b.err == nil:
			ok++
		case errors.Is(b.err, store.ErrOwned), errors.Is(b.err, store.ErrInsufficient):
		default:
			t.Errorf("buy: %v", b.err)
		}
	}
	s, _ = st.ShopState(ctx, acc, now)
	if ok != 2 || s.Balance != 80 || len(s.Owned) != 2 {
		t.Fatalf("after concurrent buys: %d ok, %+v", ok, s)
	}
	if _, err := st.BuyCosmetic(ctx, acc, "name_gilded", now); !errors.Is(err, store.ErrInsufficient) {
		t.Fatalf("insufficient: %v", err)
	}
	if _, err := st.BuyCosmetic(ctx, acc, "old_hat", now); !errors.Is(err, store.ErrNotForSale) {
		t.Fatalf("retired: %v", err)
	}
	var ledgerSum, bal int64
	if err := conn.QueryRow(ctx, `SELECT COALESCE(sum(delta), 0) FROM premium_ledger WHERE account_id = $1`, acc).Scan(&ledgerSum); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `SELECT premium_balance FROM accounts WHERE id = $1`, acc).Scan(&bal); err != nil {
		t.Fatal(err)
	}
	if ledgerSum != bal {
		t.Fatalf("ledger sum %d, balance %d", ledgerSum, bal)
	}

	// Refund of p1: only 80 is left. Debit it, record the shortfall, flag the account.
	r := pay("p1:refunded", "refunded", "p1")
	if r.Result != store.PaymentDebited || r.Balance != 0 || r.Shortfall != 420 {
		t.Fatalf("refund %+v", r)
	}
	if r := pay("p1:refunded", "refunded", "p1"); r.Result != store.PaymentDuplicate {
		t.Fatalf("duplicate refund %+v", r)
	}
	if r := pay("p1:chargeback", "chargeback", "p1"); r.Result != store.PaymentIgnored {
		t.Fatalf("second reversal of one payment %+v", r)
	}
	if r := pay("p9:refunded", "refunded", "p9"); r.Result != store.PaymentPendingReversal {
		t.Fatalf("reversal of a payment never credited %+v", r)
	}
	s, _ = st.ShopState(ctx, acc, now)
	if !s.Flagged || !s.Blocked || s.Balance != 0 || s.History[0].Reason != store.LedgerRefund || s.History[0].Shortfall != 420 {
		t.Fatalf("after refund %+v", s)
	}
	// A flagged account cannot buy, even with balance.
	pay("p2:paid", "paid", "p2")
	if _, err := st.BuyCosmetic(ctx, acc, "name_gilded", now); !errors.Is(err, store.ErrShopBlocked) {
		t.Fatalf("flagged buy: %v", err)
	}
	// A chargeback that is covered does not flag (the flag stays from before).
	if r := pay("p2:chargeback", "chargeback", "p2"); r.Result != store.PaymentDebited || r.Shortfall != 0 || r.Balance != 0 {
		t.Fatalf("chargeback %+v", r)
	}

	// Staff: grant, a removal larger than the balance, clearing the flag; audited.
	audit := store.AuditEntry{At: now, Source: store.AuditGame, ActorAccountID: acc, ActorName: "Boss", Action: "premium_grant",
		Args: map[string]string{"delta": "+250"}}
	g, err := st.GrantPremium(ctx, store.PremiumGrant{Audit: audit, TargetName: "shopper", Delta: 250, Note: "clear support", ClearFlag: true})
	if err != nil || g.Result != store.ResultOK || g.Balance != 250 || g.Name != "Shopper" {
		t.Fatalf("grant %+v %v", g, err)
	}
	g, err = st.GrantPremium(ctx, store.PremiumGrant{Audit: audit, TargetName: "Shopper", Delta: -1000, Note: "x"})
	if err != nil || g.Result != store.ResultInsufficient || g.Balance != 250 {
		t.Fatalf("removal %+v %v", g, err)
	}
	g, _ = st.GrantPremium(ctx, store.PremiumGrant{Audit: audit, TargetName: "Nobody", Delta: 5, Note: "x"})
	if g.Result != store.ResultNotFound {
		t.Fatalf("unknown %+v", g)
	}
	s, _ = st.ShopState(ctx, acc, now)
	if s.Flagged || s.Blocked || s.Balance != 250 {
		t.Fatalf("after grant %+v", s)
	}
	if _, err := st.BuyCosmetic(ctx, acc, "name_gilded", now); err != nil {
		t.Fatalf("buy after clear: %v", err)
	}
	var audits int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action = 'premium_grant'`).Scan(&audits); err != nil || audits != 3 {
		t.Fatalf("audit rows %d %v", audits, err)
	}
	res, rows, err := st.PremiumHistory(ctx, "Shopper", 3, store.AuditEntry{At: now, Source: store.AuditGame, ActorName: "Helper",
		Action: "premium_history", Result: store.ResultOK})
	if err != nil || res.Balance != 50 || len(rows) != 3 || rows[0].Reason != store.LedgerPurchase || rows[0].CosmeticID != "name_gilded" {
		t.Fatalf("history %+v %+v %v", res, rows, err)
	}

	// The ledger is append-only.
	if _, err := conn.Exec(ctx, `UPDATE premium_ledger SET delta = 0`); err == nil {
		t.Fatal("ledger update allowed")
	}
	if _, err := conn.Exec(ctx, `DELETE FROM premium_ledger`); err == nil {
		t.Fatal("ledger delete allowed")
	}

	// Equipped cosmetics are saved and loaded with the character.
	var charID int64
	if err := conn.QueryRow(ctx, `SELECT id FROM characters WHERE account_id = $1`, acc).Scan(&charID); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveCharacterState(ctx, store.CharacterState{ID: charID, Level: 1, Health: 1, X: 5, Y: 5, Z: 7, SavedAt: now,
		Cosmetics: store.Cosmetics{Outfit: "outfit_sailor", Color: "color_tide"}}); err != nil {
		t.Fatal(err)
	}
	pc, err := st.PlayCharacter(ctx, acc, charID, now)
	if err != nil {
		t.Fatal(err)
	}
	if pc.Cosmetics != (store.Cosmetics{Outfit: "outfit_sailor", Color: "color_tide"}) || pc.Premium != 50 ||
		len(pc.Owned) != 3 || pc.PremiumSeq != rows[0].ID {
		t.Fatalf("play character %+v (seq %d)", pc, rows[0].ID)
	}
}

// TestShopPaymentReversalsRace: a refund concurrent with its paid event, or arriving
// before it, never leaves the player with the currency; partial refunds debit their
// share once per new refunded amount; a dispute flags without a debit; an approved
// payment that cannot be credited is stored as unmatched.
func TestShopPaymentReversalsRace(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_shop_race"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	newAccount := func(email string) int64 {
		t.Helper()
		id, err := st.CreateAccount(ctx, email, "h")
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	ev := func(acc int64, typ, payment string, refunded int64) store.PaymentEvent {
		id := payment + ":" + typ
		if refunded > 0 {
			id += ":" + strconv.FormatInt(refunded, 10)
		}
		return store.PaymentEvent{Provider: "mercadopago", EventID: id, Type: typ, PaymentID: payment, AccountID: acc,
			PackID: "pack_medium", AmountMinor: 9990, Currency: "CLP", RefundedMinor: refunded, Premium: 550, At: now}
	}
	apply := func(e store.PaymentEvent) store.PaymentResult {
		t.Helper()
		r, err := st.ApplyPayment(ctx, e)
		if err != nil {
			t.Error(err)
		}
		return r
	}
	balance := func(acc int64) int64 {
		t.Helper()
		s, err := st.ShopState(ctx, acc, now)
		if err != nil {
			t.Fatal(err)
		}
		return s.Balance
	}
	eventResult := func(eventID string) string {
		t.Helper()
		var r string
		if err := conn.QueryRow(ctx, `SELECT result FROM payment_events WHERE event_id = $1`, eventID).Scan(&r); err != nil {
			t.Fatal(err)
		}
		return r
	}

	// Paid and refund concurrently, many rounds: whatever the order, the balance ends at 0
	// and the refund is never burnt as ignored.
	for i := range 20 {
		acc := newAccount("race" + strconv.Itoa(i) + "@example.org")
		pay := "race" + strconv.Itoa(i)
		var wg sync.WaitGroup
		var rp, rr store.PaymentResult
		wg.Add(2)
		go func() { defer wg.Done(); rp = apply(ev(acc, store.PaymentPaid, pay, 0)) }()
		go func() { defer wg.Done(); rr = apply(ev(acc, store.PaymentRefunded, pay, 0)) }()
		wg.Wait()
		if b := balance(acc); b != 0 {
			t.Fatalf("round %d: balance %d after paid %+v and refund %+v", i, b, rp, rr)
		}
		if rp.Result != store.PaymentCredited {
			t.Fatalf("round %d: paid %+v", i, rp)
		}
		switch rr.Result {
		case store.PaymentDebited: // the refund ran second
		case store.PaymentPendingReversal: // it ran first: the credit reversed it at once
			if rp.Reversed != 550 {
				t.Fatalf("round %d: pending refund not reversed by the credit %+v", i, rp)
			}
		default:
			t.Fatalf("round %d: refund %+v", i, rr)
		}
		if r := eventResult(pay + ":refunded"); r != store.PaymentDebited {
			t.Fatalf("round %d: stored refund result %q", i, r)
		}
	}

	// Refund before paid, explicitly: pending, then the credit is reversed at once.
	acc := newAccount("early@example.org")
	if r := apply(ev(acc, store.PaymentRefunded, "early", 0)); r.Result != store.PaymentPendingReversal {
		t.Fatalf("early refund %+v", r)
	}
	if eventResult("early:refunded") != store.PaymentPendingReversal {
		t.Fatal("early refund not stored as pending")
	}
	r := apply(ev(acc, store.PaymentPaid, "early", 0))
	if r.Result != store.PaymentCredited || r.Reversed != 550 || r.Balance != 0 {
		t.Fatalf("paid after refund %+v", r)
	}
	if eventResult("early:refunded") != store.PaymentDebited || balance(acc) != 0 {
		t.Fatal("pending refund not applied")
	}
	// A duplicate of the refund changes nothing.
	if r := apply(ev(acc, store.PaymentRefunded, "early", 0)); r.Result != store.PaymentDuplicate {
		t.Fatalf("duplicate refund %+v", r)
	}
	s, _ := st.ShopState(ctx, acc, now)
	if s.Flagged || len(s.History) != 2 || s.History[0].Reason != store.LedgerRefund || s.History[1].Reason != store.LedgerPack {
		t.Fatalf("early ledger %+v", s)
	}
	// A chargeback before paid: the credit just made covers it, no shortfall.
	acc2 := newAccount("cb@example.org")
	apply(ev(acc2, store.PaymentChargeback, "cb", 0))
	if r := apply(ev(acc2, store.PaymentPaid, "cb", 0)); r.Reversed != 550 || r.Balance != 0 || r.Shortfall != 0 {
		t.Fatalf("paid after chargeback %+v", r)
	}

	// Partial refunds: 550 for 9990; 2500 refunded takes floor(550*2500/9990) = 137,
	// then 5000 in total takes floor(550*5000/9990) = 275, so 138 more; a repeat is a
	// duplicate, and the full refund takes the remaining 275.
	acc3 := newAccount("partial@example.org")
	apply(ev(acc3, store.PaymentPaid, "part", 0))
	if r := apply(ev(acc3, store.PaymentRefunded, "part", 2500)); r.Result != store.PaymentDebited || r.Reversed != 137 || r.Balance != 413 {
		t.Fatalf("partial 1 %+v", r)
	}
	if r := apply(ev(acc3, store.PaymentRefunded, "part", 2500)); r.Result != store.PaymentDuplicate {
		t.Fatalf("partial repeat %+v", r)
	}
	if r := apply(ev(acc3, store.PaymentRefunded, "part", 5000)); r.Reversed != 138 || r.Balance != 275 {
		t.Fatalf("partial 2 %+v", r)
	}
	if r := apply(ev(acc3, store.PaymentRefunded, "part", 0)); r.Reversed != 275 || r.Balance != 0 {
		t.Fatalf("full after partial %+v", r)
	}
	if r := apply(ev(acc3, store.PaymentChargeback, "part", 0)); r.Result != store.PaymentIgnored {
		t.Fatalf("chargeback after full refund %+v", r)
	}
	// A partial refund of a payment never credited: the rest of the payment stands, so it
	// credits and takes the share at once (550 - 137).
	acc4 := newAccount("partial2@example.org")
	if r := apply(ev(acc4, store.PaymentRefunded, "part2", 2500)); r.Result != store.PaymentDebited || r.Balance != 413 {
		t.Fatalf("partial without credit %+v", r)
	}
	if r := apply(ev(acc4, store.PaymentPaid, "part2", 0)); r.Result != store.PaymentIgnored || balance(acc4) != 413 {
		t.Fatalf("paid after partial %+v", r)
	}

	// A dispute flags the account and debits nothing.
	acc5 := newAccount("dispute@example.org")
	apply(ev(acc5, store.PaymentPaid, "disp", 0))
	if r := apply(ev(acc5, store.PaymentDispute, "disp", 0)); r.Result != store.PaymentFlagged || r.Balance != 550 {
		t.Fatalf("dispute %+v", r)
	}
	if s, _ := st.ShopState(ctx, acc5, now); !s.Flagged || !s.Blocked || s.Balance != 550 {
		t.Fatalf("after dispute %+v", s)
	}

	// Unmatched: stored once, with its reason, and no balance changes.
	um := store.PaymentEvent{Provider: "mercadopago", EventID: "um1:unmatched", Type: store.PaymentPaid, PaymentID: "um1",
		AmountMinor: 9990, Currency: "CLP", At: now}
	if res, err := st.RecordUnmatchedPayment(ctx, um, store.UnmatchedReference); err != nil || res != store.PaymentUnmatched {
		t.Fatalf("unmatched %q %v", res, err)
	}
	if res, err := st.RecordUnmatchedPayment(ctx, um, store.UnmatchedReference); err != nil || res != store.PaymentDuplicate {
		t.Fatalf("unmatched duplicate %q %v", res, err)
	}
	var note, result string
	if err := conn.QueryRow(ctx, `SELECT note, result FROM payment_events WHERE event_id = 'um1:unmatched'`).Scan(&note, &result); err != nil ||
		note != store.UnmatchedReference || result != store.PaymentUnmatched {
		t.Fatalf("unmatched row %q %q %v", note, result, err)
	}

	// A full refund waiting, then a partial refund arrives (another webhook read the
	// payment earlier): the partial credits, the waiting full refund takes it all back.
	acc6 := newAccount("pend-partial@example.org")
	if r := apply(ev(acc6, store.PaymentRefunded, "pp", 0)); r.Result != store.PaymentPendingReversal {
		t.Fatalf("full refund first %+v", r)
	}
	if r := apply(ev(acc6, store.PaymentRefunded, "pp", 2500)); r.Result != store.PaymentDebited || r.Balance != 0 {
		t.Fatalf("partial after a pending full refund %+v", r)
	}
	if eventResult("pp:refunded") != store.PaymentDebited || balance(acc6) != 0 {
		t.Fatal("pending full refund not applied by the partial's credit")
	}
	// A full refund and a chargeback both waiting: the credit reverses it once.
	acc7 := newAccount("two-pending@example.org")
	apply(ev(acc7, store.PaymentRefunded, "tp", 0))
	apply(ev(acc7, store.PaymentChargeback, "tp", 0))
	if r := apply(ev(acc7, store.PaymentPaid, "tp", 0)); r.Reversed != 550 || r.Balance != 0 || r.Shortfall != 0 {
		t.Fatalf("paid after two reversals %+v", r)
	}
	if eventResult("tp:refunded") != store.PaymentDebited || eventResult("tp:chargeback") != store.PaymentIgnored {
		t.Fatal("two pending reversals")
	}
	// A reversal never needs the pack: a refund of a pack no longer sold (Premium 0,
	// flagged unmatched for crediting) still takes back what the ledger credited.
	acc8 := newAccount("gone-pack@example.org")
	apply(ev(acc8, store.PaymentPaid, "gp", 0))
	gone := ev(acc8, store.PaymentRefunded, "gp", 0)
	gone.Premium, gone.Unmatched = 0, store.UnmatchedPack
	if r := apply(gone); r.Result != store.PaymentDebited || r.Balance != 0 {
		t.Fatalf("refund of a removed pack %+v", r)
	}
	// What would credit but cannot (amount mismatch) is stored as unmatched, with its note.
	bad := ev(acc8, store.PaymentPaid, "mis", 0)
	bad.Premium, bad.Unmatched = 0, store.UnmatchedAmount
	if r := apply(bad); r.Result != store.PaymentUnmatched || balance(acc8) != 0 {
		t.Fatalf("mismatch %+v", r)
	}
	var misNote string
	if err := conn.QueryRow(ctx, `SELECT note FROM payment_events WHERE event_id = 'mis:paid'`).Scan(&misNote); err != nil ||
		misNote != store.UnmatchedAmount {
		t.Fatalf("mismatch note %q %v", misNote, err)
	}
	// A paid payment of a deleted account: unmatched (account_gone), never silent.
	if r := apply(ev(999999, store.PaymentPaid, "ghost", 0)); r.Result != store.PaymentUnmatched {
		t.Fatalf("paid for a deleted account %+v", r)
	}
	if r := apply(ev(999999, store.PaymentRefunded, "ghost", 0)); r.Result != store.PaymentIgnored {
		t.Fatalf("refund for a deleted account %+v", r)
	}

	// The ledger and the balances always agree.
	var mismatched int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM accounts a WHERE a.premium_balance <>
		(SELECT COALESCE(sum(delta), 0) FROM premium_ledger l WHERE l.account_id = a.id)`).Scan(&mismatched); err != nil || mismatched != 0 {
		t.Fatalf("ledger mismatch on %d accounts (%v)", mismatched, err)
	}
}
