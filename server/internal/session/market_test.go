package session_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Trade window and global market (T5.3). The board is the 'v' of the drawing.
const boardID = worldtest.Vein

var marketMap = []string{
	"v.....",
	"......",
	"......",
	"......",
}

// marketItems are the inventory test items, tradeable, plus the board.
func marketItems(t *testing.T) content.Items {
	t.Helper()
	items := testItems()
	for _, id := range []string{"backpack", "copper_coin", "test_salve", "test_sword", "test_bag"} {
		items[id].Tradeable = true
	}
	coin := *items["copper_coin"]
	if err := yaml.Unmarshal([]byte("{currency: {worth: 1}}"), &coin); err != nil {
		t.Fatal(err)
	}
	items["copper_coin"] = &coin
	var board content.Item
	if err := yaml.Unmarshal([]byte("{id: market_board, kind: decoration, pickupable: false, blocks_movement: true, market_board: true}"), &board); err != nil {
		t.Fatal(err)
	}
	board.Numeric = boardID
	items[board.ID] = &board
	return items
}

type marketHarness struct {
	*harness
	transfers []session.Transfer
}

func newMarketHarness(t *testing.T, opts ...option) *marketHarness {
	t.Helper()
	mh := &marketHarness{}
	mh.harness = newHarness(t, worldtest.Map(t, 0, 0, 7, marketMap...), func(c *session.Config) {
		for _, o := range opts {
			defer o(c)
		}
		c.Items = marketItems(t)
		c.Balance.Market = content.Market{Enabled: true, FeePermille: 100, FeeMin: 2, FeeMax: 50, MaxOffers: 2,
			MaxAmount: 100, MaxPrice: 1000, DurationsHours: []int{1, 2}, ListSize: 5, HistorySize: 4,
			ReferenceDays: 3, MailboxShown: 10, ActionBurst: 50, ActionRefillMs: 50}
		c.Balance.Trade = content.Trade{Enabled: true, MaxItems: 2, RequestMs: 5000, ActionBurst: 50, ActionRefillMs: 50}
		c.Transfer = func(tr session.Transfer) bool { mh.transfers = append(mh.transfers, tr); return true }
	})
	return mh
}

// trader joins a character at p with a 4-slot backpack holding pack.
func (h *marketHarness) trader(name string, p world.Pos, pack ...session.ItemState) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	c := withPack(nextChar, p, pack...)
	c.Name = name
	cl, pl := h.joinChar(c)
	cl.take()
	return cl, pl
}

func tradeReq(id uint32, item *pb.ItemLocation, itemID uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_TradeRequest{TradeRequest: &pb.TradeRequest{
		CreatureId: id, Item: item, ItemId: itemID}}}
}

func tradeOffer(item *pb.ItemLocation, itemID uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_TradeOffer{TradeOffer: &pb.TradeOffer{Item: item, ItemId: itemID}}}
}

var (
	tradeAccept = &pb.ClientMessage{Message: &pb.ClientMessage_TradeAccept{TradeAccept: &pb.TradeAccept{}}}
	tradeCancel = &pb.ClientMessage{Message: &pb.ClientMessage_TradeCancel{TradeCancel: &pb.TradeCancel{}}}
)

func lastTrade(evs []*pb.ServerMessage) *pb.TradeUpdate {
	us := find(evs, (*pb.ServerMessage).GetTradeUpdate)
	if len(us) == 0 {
		return nil
	}
	return us[len(us)-1]
}

// startTrade: a offers its first backpack item to b, b accepts offering its own first one.
func (h *marketHarness) startTrade(ca, cb *fakeClient, a, b *session.Player, aItem, bItem uint32) {
	_ = a
	h.t.Helper()
	wa, wb := openPack(h.t, h.harness, ca), openPack(h.t, h.harness, cb)
	if u := lastTrade(h.send(ca, tradeReq(b.ID(), inContainer(wa, 0), aItem))); u.GetState() != pb.TradeState_TRADE_STATE_REQUESTED || u.GetInvited() {
		h.t.Fatalf("requester got %v", u)
	}
	if u := lastTrade(cb.take()); !u.GetInvited() || u.GetPartnerName() == "" {
		h.t.Fatalf("invited got %v", u)
	}
	u := lastTrade(h.send(cb, tradeReq(a.ID(), inContainer(wb, 0), bItem)))
	if u.GetState() != pb.TradeState_TRADE_STATE_NEGOTIATING || len(u.GetOwnOffer()) != 1 || len(u.GetPartnerOffer()) != 1 {
		h.t.Fatalf("negotiating got %v", u)
	}
	ca.take()
}

func TestTradeSwapsItemsAtomically(t *testing.T) {
	h := newMarketHarness(t)
	ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 30, 0), stack(coinID, 40, 1))
	cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0))
	h.startTrade(ca, cb, a, b, salveID, swordID)

	if u := lastTrade(h.send(ca, tradeAccept)); !u.GetOwnAccepted() || u.GetPartnerAccepted() {
		t.Fatalf("after A accepts: %v", u)
	}
	evs := h.send(cb, tradeAccept)
	if u := lastTrade(evs); u.GetState() != pb.TradeState_TRADE_STATE_COMPLETED {
		t.Fatalf("after both accept: %v", u)
	}
	if h.w.CountItem(a, "test_sword") != 1 || h.w.CountItem(a, "test_salve") != 0 ||
		h.w.CountItem(b, "test_salve") != 30 || h.w.CountItem(b, "test_sword") != 0 || h.w.Money(a) != 40 {
		t.Fatalf("inventories after the trade are wrong")
	}
	if len(h.transfers) != 1 || len(h.transfers[0].Snapshots) != 2 || len(h.transfers[0].Market) != 0 {
		t.Fatalf("transfers = %+v, want one with both snapshots", h.transfers)
	}
	var trade int
	for _, e := range h.economy {
		if e.Kind == session.EconTrade {
			trade++
		}
	}
	if trade != 4 { // each side: one out, one in
		t.Fatalf("trade economy entries = %d, want 4", trade)
	}
	h.sim.Step() // the ledgers reconcile every tick: a duplication fails the test
}

func TestTradeCancellations(t *testing.T) {
	t.Run("walk away", func(t *testing.T) {
		h := newMarketHarness(t)
		ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 3, 0))
		cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0))
		h.startTrade(ca, cb, a, b, salveID, swordID)
		h.input(cb, walk(E))
		h.sim.RunTicks(30)
		if u := lastTrade(ca.take()); u.GetState() != pb.TradeState_TRADE_STATE_CANCELLED || u.GetReason() != "trade.cancel.too_far" {
			t.Fatalf("got %v", u)
		}
	})
	t.Run("step clears confirmations", func(t *testing.T) {
		h := newMarketHarness(t)
		ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 3, 0))
		cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0))
		h.startTrade(ca, cb, a, b, salveID, swordID)
		h.send(ca, tradeAccept)
		h.input(ca, walk(S)) // still adjacent (diagonal)
		h.sim.RunTicks(30)
		if u := lastTrade(cb.take()); u.GetState() != pb.TradeState_TRADE_STATE_NEGOTIATING || u.GetPartnerAccepted() {
			t.Fatalf("got %v", u)
		}
	})
	t.Run("change after confirming", func(t *testing.T) {
		h := newMarketHarness(t)
		ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 3, 0))
		cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0), stack(bagID, 1, 1))
		h.startTrade(ca, cb, a, b, salveID, swordID)
		h.send(ca, tradeAccept)
		wb := uint32(1) // Beto's backpack window from startTrade
		u := lastTrade(h.send(cb, tradeOffer(inContainer(wb, 1), bagID)))
		if u.GetPartnerAccepted() || u.GetOwnAccepted() || len(u.GetOwnOffer()) != 2 {
			t.Fatalf("got %v", u)
		}
		h.send(ca, tradeAccept)
		h.send(cb, tradeAccept)
		if h.w.CountItem(a, "test_bag") != 1 || h.w.CountItem(a, "test_sword") != 1 {
			t.Fatal("the new offer was not traded")
		}
	})
	t.Run("no room", func(t *testing.T) {
		h := newMarketHarness(t)
		ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 3, 0), stack(bagID, 1, 1))
		cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0), stack(coinID, 5, 1), stack(shieldID, 1, 2), stack(tunicID, 1, 3))
		h.startTrade(ca, cb, a, b, salveID, swordID)
		wa := uint32(1)
		h.send(ca, tradeOffer(inContainer(wa, 1), bagID)) // two in, one out: Beto's full pack overflows
		h.send(ca, tradeAccept)
		evs := h.send(cb, tradeAccept)
		if u := lastTrade(evs); u.GetState() != pb.TradeState_TRADE_STATE_CANCELLED || u.GetReason() != "trade.cancel.no_room" {
			t.Fatalf("got %v", u)
		}
		if h.w.CountItem(a, "test_salve") != 3 || h.w.CountItem(b, "test_sword") != 1 || len(h.transfers) != 0 {
			t.Fatal("a refused trade moved something")
		}
	})
	t.Run("pvp fight", func(t *testing.T) {
		h := newMarketHarness(t)
		ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 3, 0))
		cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0))
		h.startTrade(ca, cb, a, b, salveID, swordID)
		h.sim.Command(gameFunc(func() { h.w.SetPvPLockForTest(a, h.sim.Tick()+100) }))
		h.sim.Step()
		if u := lastTrade(cb.take()); u.GetState() != pb.TradeState_TRADE_STATE_CANCELLED || u.GetReason() != "trade.cancel.combat" {
			t.Fatalf("got %v", u)
		}
	})
	t.Run("decline and staff", func(t *testing.T) {
		h := newMarketHarness(t)
		ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 3, 0))
		cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0))
		h.send(ca, tradeReq(b.ID(), nil, 0))
		if u := lastTrade(h.send(cb, tradeCancel)); u.GetState() != pb.TradeState_TRADE_STATE_CANCELLED {
			t.Fatalf("decline: %v", u)
		}
		h.sim.Command(gameFunc(func() { h.w.SetRoleForTest(a, session.RoleGM) }))
		if !hasKey(h.send(ca, tradeReq(b.ID(), nil, 0)), "trade.staff") {
			t.Fatal("staff could trade")
		}
	})
}

// ---- market ---------------------------------------------------------------------------

func useBoard() *pb.ClientMessage { return useItem(onTile(pos(0, 0)), boardID, 1) }

func marketCmd(c *pb.MarketCommand) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_MarketCommand{MarketCommand: c}}
}

func createOffer(side pb.MarketSide, item, amount uint32, price uint64) *pb.ClientMessage {
	return marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Create{Create: &pb.MarketCreate{
		Side: side, ItemId: item, Amount: amount, Price: price}}})
}

func acceptOffer(id int64, n uint32) *pb.ClientMessage {
	return marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Accept{Accept: &pb.MarketAccept{OfferId: uint64(id), Amount: n}}})
}

func cancelOffer(id int64) *pb.ClientMessage {
	return marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Cancel{Cancel: &pb.MarketCancel{OfferId: uint64(id)}}})
}

var withdraw = marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Withdraw{Withdraw: &pb.MarketWithdraw{}}})

func lastMarket(evs []*pb.ServerMessage) *pb.MarketUpdate {
	us := find(evs, (*pb.ServerMessage).GetMarketUpdate)
	if len(us) == 0 {
		return nil
	}
	return us[len(us)-1]
}

// atBoard joins a trader next to the board and opens the market.
func (h *marketHarness) atBoard(name string, p world.Pos, pack ...session.ItemState) (*fakeClient, *session.Player) {
	h.t.Helper()
	cl, pl := h.trader(name, p, pack...)
	if u := lastMarket(h.send(cl, useBoard())); !u.GetOpen() {
		h.t.Fatalf("%s: the market did not open", name)
	}
	return cl, pl
}

func (h *marketHarness) countKind(kind, ref string) (gold int64, units int32) {
	for _, e := range h.economy {
		if e.Kind == kind && (ref == "" || e.Ref == ref) {
			gold += e.Amount
			units += e.Count
		}
	}
	return gold, units
}

func TestMarketSellOfferFlow(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0))

	// Post 10 salves at 4 each: the fee is 10% of 40 = 4 coins (a sink).
	evs := h.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 10, 4))
	if !hasKey(evs, "market.created") || h.w.CountItem(s, "test_salve") != 20 || h.w.Money(s) != 46 {
		t.Fatalf("after posting: %v salves, %d money", h.w.CountItem(s, "test_salve"), h.w.Money(s))
	}
	if fee, _ := h.countKind(session.EconMarket, "fee"); fee != -4 {
		t.Fatalf("fee entries = %d, want -4", fee)
	}
	ids := h.w.MarketOffers(s.CharacterID())
	if len(ids) != 1 || len(h.transfers) != 1 || h.transfers[0].Market[0].Kind != session.MarketOfferAdd ||
		len(h.transfers[0].Snapshots) != 1 {
		t.Fatalf("offers %v, transfers %+v", ids, h.transfers)
	}

	// Bruno browses and buys 4: pays 16 now, gets the salves now; Sela's gold waits in her mailbox.
	u := lastMarket(h.send(cb, marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Browse{Browse: &pb.MarketBrowse{ItemId: salveID}}})))
	if len(u.GetSells()) != 1 || u.GetSells()[0].GetAmount() != 10 || u.GetSells()[0].GetOwnerName() != "Sela" {
		t.Fatalf("listing %v", u.GetSells())
	}
	evs = h.send(cb, acceptOffer(ids[0], 4))
	if u := lastMarket(evs); u.GetReferencePrice() != 4 || len(u.GetHistory()) != 1 || u.GetSells()[0].GetAmount() != 6 {
		t.Fatalf("reference %d, history %v", u.GetReferencePrice(), u.GetHistory())
	}
	if !hasKey(evs, "market.bought") || h.w.CountItem(b, "test_salve") != 4 || h.w.Money(b) != 84 {
		t.Fatalf("buyer: %d salves, %d money", h.w.CountItem(b, "test_salve"), h.w.Money(b))
	}
	if gold, _ := h.w.Mailbox(s.CharacterID()); gold != 16 || h.w.MarketOfferAmount(ids[0]) != 6 {
		t.Fatalf("mailbox %d, offer left %d", gold, h.w.MarketOfferAmount(ids[0]))
	}
	if !hasKey(cs.take(), "market.offer_filled") {
		t.Fatal("the seller was not told")
	}

	// Sela cancels the rest (6 salves to her mailbox) and withdraws everything.
	if !hasKey(h.send(cs, cancelOffer(ids[0])), "market.cancelled") || h.w.MarketOfferAmount(ids[0]) != -1 {
		t.Fatal("cancel failed")
	}
	if gold, items := h.w.Mailbox(s.CharacterID()); gold != 16 || len(items) != 1 || items[0].Count != 6 {
		t.Fatalf("mailbox %d %v", gold, items)
	}
	evs = h.send(cs, withdraw)
	if !hasKey(evs, "market.withdrawn") || h.w.Money(s) != 62 || h.w.CountItem(s, "test_salve") != 26 {
		t.Fatalf("after withdraw: %d money, %d salves", h.w.Money(s), h.w.CountItem(s, "test_salve"))
	}
	if gold, items := h.w.Mailbox(s.CharacterID()); gold != 0 || len(items) != 0 {
		t.Fatal("the mailbox was not emptied")
	}
	if !hasKey(h.send(cs, withdraw), "market.mailbox_empty") {
		t.Fatal("an empty mailbox gave something")
	}
	h.sim.Step()
}

func TestMarketBuyOfferFlow(t *testing.T) {
	h := newMarketHarness(t)
	cb, b := h.atBoard("Bruno", pos(1, 0), stack(coinID, 100, 0))
	cs, s := h.atBoard("Sela", pos(0, 1), stack(salveID, 5, 0))
	// Buy 5 at 10: 50 deposited + 5 fee.
	h.send(cb, createOffer(pb.MarketSide_MARKET_SIDE_BUY, salveID, 5, 10))
	if h.w.Money(b) != 45 {
		t.Fatalf("buyer money %d, want 45", h.w.Money(b))
	}
	id := h.w.MarketOffers(b.CharacterID())[0]
	// Sela sells 3 into it: gets 30 now; Bruno's salves wait in his mailbox.
	if !hasKey(h.send(cs, acceptOffer(id, 3)), "market.sold") || h.w.Money(s) != 30 || h.w.CountItem(s, "test_salve") != 2 {
		t.Fatalf("seller: %d money, %d salves", h.w.Money(s), h.w.CountItem(s, "test_salve"))
	}
	if _, items := h.w.Mailbox(b.CharacterID()); len(items) != 1 || items[0].Count != 3 {
		t.Fatalf("buyer mailbox %v", items)
	}
	// Expiry: the remaining deposit (2 × 10) goes back to the mailbox by itself.
	h.sim.Clock().Advance(time.Hour)
	h.sim.RunTicks(25)
	if h.w.MarketOfferAmount(id) != -1 {
		t.Fatal("the offer did not expire")
	}
	if gold, _ := h.w.Mailbox(b.CharacterID()); gold != 20 {
		t.Fatalf("mailbox gold %d, want 20", gold)
	}
	if !hasKey(cb.take(), "market.offer_expired") {
		t.Fatal("the owner was not told")
	}
	h.send(cb, withdraw)
	if h.w.Money(b) != 65 || h.w.CountItem(b, "test_salve") != 3 {
		t.Fatalf("after withdraw: %d money, %d salves", h.w.Money(b), h.w.CountItem(b, "test_salve"))
	}
	h.sim.Step()
}

// Two buyers of the last unit in the same tick: the loop runs them in order, the second
// finds the offer gone, and only one fill goes to the database.
func TestMarketLastUnitOnce(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 1, 0), stack(coinID, 10, 1))
	c1, b1 := h.atBoard("Uno", pos(0, 1), stack(coinID, 50, 0))
	c2, b2 := h.atBoard("Dos", pos(1, 1), stack(coinID, 50, 0))
	h.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 1, 7))
	id := h.w.MarketOffers(s.CharacterID())[0]
	h.input(c1, acceptOffer(id, 1))
	h.input(c2, acceptOffer(id, 1))
	h.sim.Step()
	got := h.w.CountItem(b1, "test_salve") + h.w.CountItem(b2, "test_salve")
	if got != 1 || !hasKey(c2.take(), "market.offer_gone") {
		t.Fatalf("units bought = %d", got)
	}
	fills := 0
	for _, tr := range h.transfers {
		for _, op := range tr.Market {
			if op.Kind == session.MarketOfferFill {
				fills++
			}
		}
	}
	if fills != 1 || h.w.Money(b1)+h.w.Money(b2) != 93 {
		t.Fatalf("fills %d, money %d", fills, h.w.Money(b1)+h.w.Money(b2))
	}
}

func TestMarketLimitsAndRules(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 100, 1))
	cases := []struct {
		msg *pb.ClientMessage
		key string
	}{
		{createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 0, 4), "market.bad_amount"},
		{createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 101, 4), "market.bad_amount"},
		{createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 1, 1001), "market.bad_price"},
		{createOffer(pb.MarketSide_MARKET_SIDE_SELL, coinID, 1, 1), "market.bad_item"},   // money is not an item
		{createOffer(pb.MarketSide_MARKET_SIDE_SELL, shieldID, 1, 1), "market.bad_item"}, // not tradeable
		{createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 31, 1), "market.not_enough_items"},
		{createOffer(pb.MarketSide_MARKET_SIDE_BUY, salveID, 100, 1000), "market.not_enough_money"},
	}
	for _, c := range cases {
		if !hasKey(h.send(cs, c.msg), c.key) {
			t.Errorf("want %s", c.key)
		}
	}
	h.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 1, 4))
	h.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 1, 4))
	if !hasKey(h.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 1, 4)), "market.too_many_offers") {
		t.Error("max_offers not enforced")
	}
	if !hasKey(h.send(cs, acceptOffer(h.w.MarketOffers(s.CharacterID())[0], 1)), "market.own_offer") {
		t.Error("own offer accepted")
	}
	if len(h.transfers) != 2 {
		t.Fatalf("transfers = %d, want 2", len(h.transfers))
	}

	// Away from the board the window closes and nothing works.
	h.input(cs, walk(E))
	h.sim.RunTicks(30)
	if u := lastMarket(cs.take()); u == nil || u.GetOpen() {
		t.Fatal("the window did not close")
	}
	if !hasKey(h.send(cs, withdraw), "market.not_at_board") {
		t.Fatal("market used away from the board")
	}
}

func TestMarketStaffAndBanned(t *testing.T) {
	h := newMarketHarness(t)
	cg, g := h.trader("Guia", pos(1, 0), stack(coinID, 50, 0))
	h.sim.Command(gameFunc(func() { h.w.SetRoleForTest(g, session.RoleGM) }))
	if !hasKey(h.send(cg, useBoard()), "market.staff") {
		t.Fatal("staff opened the market")
	}

	// A banned owner's offers are hidden and cannot be accepted (bans come with the
	// loaded market, like at a restart).
	h2 := &marketHarness{}
	h2.harness = newHarness(t, worldtest.Map(t, 0, 0, 7, marketMap...), func(c *session.Config) {
		c.Items = marketItems(t)
		c.Balance.Market = content.Market{Enabled: true, FeePermille: 100, FeeMin: 2, FeeMax: 50, MaxOffers: 2,
			MaxAmount: 100, MaxPrice: 1000, DurationsHours: []int{1}, ListSize: 5, HistorySize: 4,
			ReferenceDays: 3, MailboxShown: 10, ActionBurst: 50, ActionRefillMs: 50}
		c.Transfer = func(tr session.Transfer) bool { h2.transfers = append(h2.transfers, tr); return true }
		c.Market = &session.MarketData{
			Offers: []session.MarketOffer{
				{ID: 7, CharacterID: 900, AccountID: 900, Name: "Vetado", Sell: true, ItemID: salveID, Amount: 3, Price: 2,
					Created: h.sim.Now(), Expires: h.sim.Now().Add(time.Hour)},
				{ID: 8, CharacterID: 901, AccountID: 901, Name: "Limpio", Sell: true, ItemID: salveID, Amount: 3, Price: 3,
					Created: h.sim.Now(), Expires: h.sim.Now().Add(time.Hour)},
			},
			Bans:      map[int64]time.Time{900: {}},
			OfferHigh: 8,
		}
	})
	cb, _ := h2.atBoard("Bruno", pos(1, 0), stack(coinID, 50, 0))
	u := lastMarket(h2.send(cb, marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Browse{Browse: &pb.MarketBrowse{ItemId: salveID}}})))
	if len(u.GetSells()) != 1 || u.GetSells()[0].GetOfferId() != 8 {
		t.Fatalf("listing %v", u.GetSells())
	}
	if !hasKey(h2.send(cb, acceptOffer(7, 1)), "market.offer_gone") {
		t.Fatal("a banned owner's offer was accepted")
	}
	// The next offer id continues after the loaded ones.
	h2.send(cb, createOffer(pb.MarketSide_MARKET_SIDE_BUY, salveID, 1, 5))
	if tr := h2.transfers[len(h2.transfers)-1]; tr.Market[0].Offer.ID != 9 {
		t.Fatalf("new offer id %d, want 9", tr.Market[0].Offer.ID)
	}
}

// /marketoffers lists a character's offers and /marketcancel takes one down (its deposit
// to the owner's mailbox); both are audited.
func TestMarketStaffCommands(t *testing.T) {
	var jobs []session.AdminJob
	h := newMarketHarness(t, func(c *session.Config) {
		c.Admin = func(j session.AdminJob) bool {
			if j.Kind != session.AdminCheckRoles {
				jobs = append(jobs, j)
			}
			return true
		}
	})
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 5, 0), stack(coinID, 20, 1))
	h.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 2, 3))
	id := h.w.MarketOffers(s.CharacterID())[0]
	nextChar++
	cg, _ := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Guia", Vocation: "guardian",
		Level: 1, Health: 145, HasPos: true, Pos: pos(4, 3), Role: session.RoleGM})
	cg.take()
	if !hasKey(h.send(cg, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/marketoffers sela")), "gm.market_offer_sell") {
		t.Fatal("offers not listed")
	}
	if !hasKey(h.send(cg, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/marketcancel 99")), "gm.market_unknown") {
		t.Fatal("unknown offer not reported")
	}
	if !hasKey(h.send(cg, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/marketcancel "+strconv.FormatInt(id, 10))), "gm.market_cancelled") {
		t.Fatal("offer not cancelled")
	}
	if _, items := h.w.Mailbox(s.CharacterID()); h.w.MarketOfferAmount(id) != -1 || len(items) != 1 || items[0].Count != 2 {
		t.Fatalf("mailbox %v", items)
	}
	var actions []string
	for _, j := range jobs {
		actions = append(actions, j.Audit.Action+":"+j.Audit.Result)
	}
	if !slices.Equal(actions, []string{"market_offers:ok", "market_cancel:invalid", "market_cancel:ok"}) {
		t.Fatalf("audit %v", actions)
	}
}

// A transfer the persistence queue refuses waits, and every later snapshot waits behind
// it: an autosave with the post-trade inventory never reaches the database before the
// trade itself (docs/01 "Transacciones").
func TestTransferKeepsPersistenceOrder(t *testing.T) {
	full := true
	var order []string
	h := newMarketHarness(t, func(c *session.Config) {
		c.Transfer = func(tr session.Transfer) bool {
			if full {
				return false
			}
			order = append(order, "transfer")
			return true
		}
		c.Save = func(s session.Snapshot) bool { order = append(order, "snapshot"); return true }
	})
	cs, _ := h.atBoard("Sela", pos(1, 0), stack(salveID, 5, 0), stack(coinID, 20, 1))
	order = nil
	h.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 2, 3))
	h.input(cs, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	h.sim.RunTicks(3)
	if len(order) != 0 {
		t.Fatalf("written before the transfer: %v", order)
	}
	full = false
	h.sim.Step()
	if !slices.Equal(order, []string{"transfer", "snapshot"}) {
		t.Fatalf("order %v", order)
	}
}

func TestSaverWritesTransfers(t *testing.T) {
	var got []session.Transfer
	var saved []uint64
	clk := clock.NewFake(clock.Epoch)
	s, err := session.NewSaver(session.SaverConfig{
		Write:         func(context.Context, session.Snapshot) error { return nil },
		WriteTransfer: func(_ context.Context, tr session.Transfer) error { got = append(got, tr); return nil },
		Saved:         func(sn session.Snapshot) { saved = append(saved, sn.Seq) },
		Clock:         clk,
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Start()
	if !s.SubmitTransfer(session.Transfer{ID: 1, Snapshots: []session.Snapshot{{CharacterID: 1, Seq: 5}, {CharacterID: 2, Seq: 9}}}) {
		t.Fatal("refused")
	}
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !slices.Equal(saved, []uint64{5, 9}) {
		t.Fatalf("got %v, saved %v", got, saved)
	}
}

// A transfer that is not stored taints its characters: their later snapshots are not
// written (only half of the transfer would reach the database), others' still are.
func TestSaverSkipsSavesAfterADroppedTransfer(t *testing.T) {
	var wrote []int64
	s, err := session.NewSaver(session.SaverConfig{
		Write: func(_ context.Context, sn session.Snapshot) error { wrote = append(wrote, sn.CharacterID); return nil },
		WriteTransfer: func(context.Context, session.Transfer) error {
			return fmt.Errorf("%w: conflict", session.ErrPermanent)
		},
		Clock: clock.NewFake(clock.Epoch),
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Start()
	s.SubmitTransfer(session.Transfer{ID: 1, Snapshots: []session.Snapshot{{CharacterID: 1}}})
	s.Submit(session.Snapshot{CharacterID: 1, Final: true})
	s.Submit(session.Snapshot{CharacterID: 2})
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(wrote, []int64{2}) || !s.Tainted(session.Job{Snapshot: session.Snapshot{CharacterID: 1}}) {
		t.Fatalf("wrote %v", wrote)
	}
}

// Mailbox gold that does not fit at once is withdrawn in part, and the items still come.
func TestMarketWithdrawPartialGold(t *testing.T) {
	h := newMarketHarness(t, func(c *session.Config) {
		c.Market = &session.MarketData{
			Gold:     map[int64]int64{nextChar + 1: 1000},
			Mail:     []session.MarketMail{{ID: 1, CharacterID: nextChar + 1, Item: session.ItemState{ItemID: salveID, Count: 2}}},
			MailHigh: 1,
		}
	})
	// Two free slots: the salves take one, then 100 of the 1000 copper (10 stacks) fit.
	cs, s := h.atBoard("Sela", pos(1, 0), stack(swordID, 1, 0), stack(bagID, 1, 1))
	evs := h.send(cs, withdraw)
	if !hasKey(evs, "market.withdrawn") || !hasKey(evs, "market.mailbox_room") {
		t.Fatalf("keys %v", systemKeys(evs))
	}
	gold, items := h.w.Mailbox(s.CharacterID())
	if h.w.Money(s) != 100 || gold != 900 || len(items) != 0 || h.w.CountItem(s, "test_salve") != 2 {
		t.Fatalf("money %d, mailbox %d %v", h.w.Money(s), gold, items)
	}
	h.sim.Step()
}

// fakeDB is a Saver write target that rejects the transfers in reject and records what
// it stores.
type fakeDB struct {
	reject  map[uint64]bool
	stored  []string
	tainted [][]int64
}

func (f *fakeDB) saver(t *testing.T) *session.Saver {
	t.Helper()
	s, err := session.NewSaver(session.SaverConfig{
		Write: func(_ context.Context, sn session.Snapshot) error {
			f.stored = append(f.stored, fmt.Sprintf("snap %d", sn.CharacterID))
			return nil
		},
		WriteTransfer: func(_ context.Context, tr session.Transfer) error {
			if f.reject[tr.ID] {
				return fmt.Errorf("%w: injected", session.ErrPermanent)
			}
			f.stored = append(f.stored, fmt.Sprintf("transfer %d", tr.ID))
			return nil
		},
		Tainted: func(ids []int64) { f.tainted = append(f.tainted, ids) },
		Clock:   clock.NewFake(clock.Epoch),
	})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func tr(id uint64, chars ...int64) session.Transfer {
	t := session.Transfer{ID: id}
	for _, c := range chars {
		t.Snapshots = append(t.Snapshots, session.Snapshot{CharacterID: c})
	}
	return t
}

// The taint is a fixed point: a trade with a tainted character is skipped and taints its
// partner, whose later saves are skipped too; the World hears about each new character.
func TestSaverTaintSpreadsThroughTrades(t *testing.T) {
	f := &fakeDB{reject: map[uint64]bool{1: true}}
	s := f.saver(t)
	s.Start()
	f.reject[9] = true
	s.SubmitTransfer(tr(9))       // an expiry (no character): rejected, the World is told
	s.SubmitTransfer(tr(1, 1))    // Ana's market change: rejected, Ana tainted
	s.SubmitTransfer(tr(2, 1, 2)) // Ana trades with Caio: skipped, Caio tainted
	s.Submit(session.Snapshot{CharacterID: 2, Final: true})
	s.Submit(session.Snapshot{CharacterID: 3})
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.stored, []string{"snap 3"}) {
		t.Fatalf("stored %v", f.stored)
	}
	if len(f.tainted) != 3 || len(f.tainted[0]) != 0 || !slices.Equal(f.tainted[1], []int64{1}) ||
		!slices.Equal(f.tainted[2], []int64{2}) {
		t.Fatalf("tainted %v", f.tainted)
	}
}

// At shutdown the pending jobs follow the same rules: a pending transfer that fails taints
// its characters, and being the shutdown, nothing after it is written (crash semantics).
func TestSaverWritePendingTaints(t *testing.T) {
	f := &fakeDB{reject: map[uint64]bool{7: true}}
	s := f.saver(t)
	s.Start()
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	err := s.WritePending(context.Background(), []session.Job{
		{Transfer: &session.Transfer{ID: 7, Snapshots: []session.Snapshot{{CharacterID: 1}}}},
		{Snapshot: session.Snapshot{CharacterID: 1, Final: true}},
		{Snapshot: session.Snapshot{CharacterID: 2, Final: true}},
	})
	if err == nil || len(f.stored) != 0 || len(f.tainted) != 1 {
		t.Fatalf("err %v, stored %v, tainted %v", err, f.stored, f.tainted)
	}
}

// When the persistence side reports tainted characters, the World takes them out, refuses
// their logins until a restart, cancels open trades and turns the market read-only.
func TestWorldTaintedFailsSafe(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 5, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 50, 0))
	cc, c := h.trader("Caio", pos(1, 1), stack(swordID, 1, 0))
	h.send(cb, tradeReq(c.ID(), nil, 0))
	h.sim.Command(h.w.Tainted([]int64{s.CharacterID()}))
	h.sim.Step()
	if !cs.closed || cs.reason != pb.DisconnectReason_DISCONNECT_REASON_SAVE_FAILED {
		t.Fatalf("Sela closed %v reason %v", cs.closed, cs.reason)
	}
	if u := lastTrade(cc.take()); u.GetState() != pb.TradeState_TRADE_STATE_CANCELLED || u.GetReason() != "trade.cancel.read_only" {
		t.Fatalf("trade %v", u)
	}
	if u := lastMarket(cb.take()); !u.GetReadOnly() {
		t.Fatal("the open market window was not told")
	}
	if !hasKey(h.send(cb, createOffer(pb.MarketSide_MARKET_SIDE_BUY, salveID, 1, 5)), "market.read_only") ||
		len(h.w.MarketOffers(b.CharacterID())) != 0 {
		t.Fatal("an offer was posted while read-only")
	}
	if u := lastMarket(h.send(cb, marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Browse{Browse: &pb.MarketBrowse{ItemId: salveID}}}))); u.GetItemId() != salveID {
		t.Fatal("browsing stopped working")
	}
	if !hasKey(h.send(cb, tradeReq(c.ID(), nil, 0)), "trade.read_only") {
		t.Fatal("a trade opened while read-only")
	}
	again := &fakeClient{}
	h.sim.Command(h.w.Join(withPack(s.CharacterID(), pos(2, 2)), again))
	h.sim.Step()
	if !again.closed || again.reason != pb.DisconnectReason_DISCONNECT_REASON_CHARACTER_LOCKED {
		t.Fatalf("relogin closed %v reason %v", again.closed, again.reason)
	}
	if !h.w.ReadOnly() {
		t.Fatal("not read-only")
	}
}

// A partner without a backpack can still complete a trade it only gives in; nothing is
// confirmed while both offers are empty.
func TestTradeWithoutBackpackAndEmpty(t *testing.T) {
	h := newMarketHarness(t)
	ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 3, 0))
	nextChar++
	cn, n := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Nopack", Vocation: "guardian",
		Level: 1, Health: 145, HasPos: true, Pos: pos(3, 2), InventoryLoaded: true})
	cn.take()
	h.send(ca, tradeReq(n.ID(), nil, 0))
	h.send(cn, tradeReq(a.ID(), nil, 0))
	if !hasKey(h.send(ca, tradeAccept), "trade.empty") {
		t.Fatal("an empty trade was confirmed")
	}
	// Nopack offers nothing and gets nothing: Ana offers her salves, which Nopack cannot
	// take (no backpack), so the trade is refused cleanly instead of panicking.
	wa := openPack(t, h.harness, ca)
	h.send(ca, tradeOffer(inContainer(wa, 0), salveID))
	h.send(ca, tradeAccept)
	evs := h.send(cn, tradeAccept)
	if u := lastTrade(evs); u.GetState() != pb.TradeState_TRADE_STATE_CANCELLED || u.GetReason() != "trade.cancel.no_room" {
		t.Fatalf("got %v", u)
	}
	if h.sim.LastStats().Panics != 0 {
		t.Fatal("panicked")
	}
}

// Offers of an item retired from data/ are closed at load: a buy offer's gold goes back to
// the mailbox, in one transfer.
func TestMarketRetiredItemOffers(t *testing.T) {
	h := newMarketHarness(t, func(c *session.Config) {
		c.Market = &session.MarketData{OfferHigh: 2, TransferHigh: 40, Offers: []session.MarketOffer{
			{ID: 1, CharacterID: 77, AccountID: 77, Sell: false, ItemID: 4000, Amount: 10, Price: 50},
			{ID: 2, CharacterID: 77, AccountID: 77, Sell: true, ItemID: 4001, Amount: 3, Price: 9},
		}}
	})
	if gold, _ := h.w.Mailbox(77); gold != 500 || h.w.MarketOfferAmount(1) != -1 {
		t.Fatalf("mailbox gold %d", gold)
	}
	if len(h.transfers) != 1 || h.transfers[0].ID != 41 || len(h.transfers[0].Market) != 3 {
		t.Fatalf("transfers %+v", h.transfers)
	}
}

// At shutdown a transfer that is abandoned (or fails) is a crash at that point: no later
// job is written, of any character, and they count as abandoned.
func TestSaverShutdownCrashSemantics(t *testing.T) {
	var stored []int64
	var outcomes []string
	s, err := session.NewSaver(session.SaverConfig{
		Write: func(_ context.Context, sn session.Snapshot) error {
			stored = append(stored, sn.CharacterID)
			return nil
		},
		WriteTransfer: func(context.Context, session.Transfer) error {
			return errors.New("database down") // transient: retried until the deadline
		},
		Failed: func(o string) { outcomes = append(outcomes, o) },
		Clock:  clock.NewFake(clock.Epoch), // backoff never ends: only Stop's deadline does
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Start()
	s.SubmitTransfer(tr(1, 1))
	s.Submit(session.Snapshot{CharacterID: 2, Final: true})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_ = s.Stop(ctx)
	if len(stored) != 0 {
		t.Fatalf("written after the abandoned transfer: %v", stored)
	}
	if err := s.WritePending(context.Background(), []session.Job{{Snapshot: session.Snapshot{CharacterID: 3, Final: true}}}); err == nil || len(stored) != 0 {
		t.Fatalf("pending written after the crash: %v %v", err, stored)
	}
	if n := slices.Index(outcomes, session.SaveAbandoned); n < 0 || slices.Contains(outcomes[n:], session.SaveSkipped) {
		t.Fatalf("outcomes %v", outcomes)
	}

	// A pending transfer that fails in WritePending crashes the rest too.
	f := &fakeDB{reject: map[uint64]bool{5: true}}
	s2 := f.saver(t)
	s2.Start()
	_ = s2.Stop(context.Background())
	_ = s2.WritePending(context.Background(), []session.Job{
		{Transfer: &session.Transfer{ID: 5, Snapshots: []session.Snapshot{{CharacterID: 1}}}},
		{Snapshot: session.Snapshot{CharacterID: 9, Final: true}},
	})
	if len(f.stored) != 0 {
		t.Fatalf("stored %v", f.stored)
	}
}
