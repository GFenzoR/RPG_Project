package session_test

import (
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// Several coins (T5.5, docs/02 "Economía"): money is paid smallest coins first, a bigger
// coin is broken and the change given back (only if it fits), and money is given in the
// fewest coins.

const silverID = 92

// withSilver adds a silver coin worth 100 copper to the market test items.
func withSilver(t *testing.T) option {
	return func(c *session.Config) {
		var it content.Item
		if err := yaml.Unmarshal([]byte("{id: silver_coin, kind: currency, weight: 10, stackable: true, max_stack: 100, tradeable: true, currency: {worth: 100}}"), &it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = silverID
		c.Items[it.ID] = &it
	}
}

func TestPayBreaksACoinOnlyWithRoomForTheChange(t *testing.T) {
	h := newMarketHarness(t, withSilver(t))
	// A full 4-slot backpack: one silver, salves, a sword and a bag.
	cf, full := h.atBoard("Lleno", pos(1, 0), stack(silverID, 1, 0), stack(salveID, 5, 1), stack(swordID, 1, 2), stack(bagID, 1, 3))
	// A buy offer of 48 pays 48 + a fee of 4: the silver must be broken for 48 copper back.
	evs := h.send(cf, createOffer(pb.MarketSide_MARKET_SIDE_BUY, salveID, 1, 48))
	if !hasKey(evs, "dialog.no_change_room") || h.w.CountItem(full, "silver_coin") != 1 || len(h.w.MarketOffers(full.CharacterID())) != 0 {
		t.Fatalf("with no room for the change: %v, silver %d", systemKeys(evs), h.w.CountItem(full, "silver_coin"))
	}
	// With room, the silver is broken and the change comes back in copper.
	cr, room := h.atBoard("Holgado", pos(0, 1), stack(silverID, 1, 0))
	evs = h.send(cr, createOffer(pb.MarketSide_MARKET_SIDE_BUY, salveID, 1, 48))
	if !hasKey(evs, "market.created") || h.w.CountItem(room, "silver_coin") != 0 || h.w.CountItem(room, "copper_coin") != 48 || h.w.Money(room) != 48 {
		t.Fatalf("change: %v, silver %d copper %d", systemKeys(evs), h.w.CountItem(room, "silver_coin"), h.w.CountItem(room, "copper_coin"))
	}
}

func TestMarketWithMixedCoins(t *testing.T) {
	h := newMarketHarness(t, withSilver(t))
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(silverID, 1, 0), stack(coinID, 30, 1))
	h.send(cs, createOffer(pb.MarketSide_MARKET_SIDE_SELL, salveID, 10, 20))
	ids := h.w.MarketOffers(s.CharacterID())
	// 4 salves at 20 = 80: Bruno's 30 copper and his silver, 50 copper back.
	evs := h.send(cb, acceptOffer(ids[0], 4))
	if !hasKey(evs, "market.bought") || h.w.Money(b) != 50 || h.w.CountItem(b, "silver_coin") != 0 || h.w.CountItem(b, "copper_coin") != 50 || h.w.CountItem(b, "test_salve") != 4 {
		t.Fatalf("buyer: %v, money %d", systemKeys(evs), h.w.Money(b))
	}
	// Sela's mailbox gets 80 more and gives it all back in the fewest coins.
	h.sim.Command(gameFunc(func() { h.w.MailGoldForTest(s.CharacterID(), 170) }))
	h.sim.Step()
	cs.take()
	before := h.w.Money(s)
	if evs := h.send(cs, withdraw); !hasKey(evs, "market.withdrawn") || h.w.Money(s)-before != 250 || h.w.CountItem(s, "silver_coin") != 2 {
		t.Fatalf("withdraw: %v, +%d, silver %d", systemKeys(evs), h.w.Money(s)-before, h.w.CountItem(s, "silver_coin"))
	}
}

func TestTradeWithMixedCoins(t *testing.T) {
	h := newMarketHarness(t, withSilver(t))
	ca, a := h.trader("Ana", pos(2, 2), stack(silverID, 3, 0), stack(coinID, 40, 1))
	cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0))
	h.startTrade(ca, cb, a, b, silverID, swordID)
	h.send(ca, tradeAccept)
	if u := lastTrade(h.send(cb, tradeAccept)); u.GetState() != pb.TradeState_TRADE_STATE_COMPLETED {
		t.Fatalf("trade: %v", u)
	}
	if h.w.Money(a) != 40 || h.w.Money(b) != 300 || h.w.CountItem(a, "test_sword") != 1 {
		t.Fatalf("after: Ana %d, Beto %d", h.w.Money(a), h.w.Money(b))
	}
}
