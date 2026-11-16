package session_test

import (
	"testing"
	"time"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// Live market windows (docs/02 "Mercado global"): what another player does shows up in
// the open windows it concerns.

func browse(item uint32) *pb.ClientMessage {
	return marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Browse{Browse: &pb.MarketBrowse{ItemId: item}}})
}

var closeMarketCmd = marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Close{Close: &pb.MarketClose{}}})

func markets(evs []*pb.ServerMessage) []*pb.MarketUpdate {
	return find(evs, (*pb.ServerMessage).GetMarketUpdate)
}

// onlyMarket returns the one MarketUpdate of evs, failing if there is not exactly one.
func onlyMarket(t *testing.T, evs []*pb.ServerMessage) *pb.MarketUpdate {
	t.Helper()
	us := markets(evs)
	if len(us) != 1 {
		t.Fatalf("got %d MarketUpdate, want 1: %v", len(us), us)
	}
	return us[0]
}

const sell = pb.MarketSide_MARKET_SIDE_SELL

// Two players at the board, one deterministic run: what one does shows up in the other's
// window at the end of the same tick, flagged as a refresh; the actor gets only its own
// answer. A busy book refreshes a window at most every 500 ms, and a change inside that
// time is not lost: it goes out when the time is up, with the book as it is then.
func TestMarketWindowRefreshesForViewers(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, _ := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0))
	h.send(cb, browse(salveID))
	h.send(cs, browse(salveID))
	if n := h.w.MarketViewers(salveID); n != 2 {
		t.Fatalf("viewers %d, want 2", n)
	}

	// Sela posts 10 salves: her answer; Bruno's window shows the offer in the same tick.
	if u := onlyMarket(t, h.send(cs, createOffer(sell, salveID, 10, 4))); u.GetRefresh() || len(u.GetSells()) != 1 {
		t.Fatalf("Sela's answer %v", u)
	}
	u := onlyMarket(t, cb.take())
	if !u.GetRefresh() || u.GetItemId() != salveID || len(u.GetSells()) != 1 || u.GetSells()[0].GetAmount() != 10 ||
		u.GetSells()[0].GetOwnerName() != "Sela" || u.GetSells()[0].GetOwn() {
		t.Fatalf("Bruno's refresh %v", u)
	}
	id := int64(u.GetSells()[0].GetOfferId())

	// Bruno buys 4: one answer for him; Sela (viewer and owner) sees the 6 left in the
	// book and in her own offers, and the gold in her mailbox.
	if u := onlyMarket(t, h.send(cb, acceptOffer(id, 4))); u.GetRefresh() || u.GetSells()[0].GetAmount() != 6 {
		t.Fatalf("Bruno's answer %v", u)
	}
	evs := cs.take()
	u = onlyMarket(t, evs)
	if !hasKey(evs, "market.offer_filled") || !u.GetRefresh() || u.GetSells()[0].GetAmount() != 6 ||
		len(u.GetOwn()) != 1 || u.GetOwn()[0].GetAmount() != 6 || u.GetMailboxGold() != 16 || len(u.GetHistory()) != 1 {
		t.Fatalf("Sela's refresh %v", u)
	}

	// Sela takes the rest down two ticks after Bruno's last refresh: his waits.
	h.send(cs, cancelOffer(id))
	if us := markets(cb.take()); len(us) != 0 {
		t.Fatalf("refreshed again too soon: %v", us)
	}
	h.sim.RunTicks(10)
	if u := onlyMarket(t, cb.take()); !u.GetRefresh() || len(u.GetSells()) != 0 {
		t.Fatalf("Bruno's late refresh %v", u)
	}
	// A quiet book sends nothing.
	h.sim.RunTicks(30)
	if us := markets(append(cb.take(), cs.take()...)); len(us) != 0 {
		t.Fatalf("refresh without a change: %v", us)
	}
	if gold, items := h.w.Mailbox(s.CharacterID()); gold != 16 || len(items) != 1 {
		t.Fatalf("mailbox %d %v", gold, items)
	}
}

// Only open windows of the changed book get it: not one browsing another item, not one
// closed with the button, not one whose player walked away from the board.
func TestMarketRefreshReachesOnlyItsBook(t *testing.T) {
	h := newMarketHarness(t)
	cs, _ := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, _ := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0))
	cc, _ := h.atBoard("Caio", pos(1, 1), stack(coinID, 100, 0))
	h.send(cb, browse(salveID))
	h.send(cc, browse(swordID))

	h.send(cs, createOffer(sell, salveID, 5, 4))
	if u := onlyMarket(t, cb.take()); !u.GetRefresh() || len(u.GetSells()) != 1 {
		t.Fatalf("Bruno %v", u)
	}
	if us := markets(cc.take()); len(us) != 0 {
		t.Fatalf("a window on another item was refreshed: %v", us)
	}

	// Bruno closes his window (no answer), Caio walks away from the board.
	h.send(cb, closeMarketCmd)
	h.input(cc, walk(S))
	h.sim.RunTicks(30)
	if u := onlyMarket(t, cc.take()); u.GetOpen() {
		t.Fatalf("Caio's window stayed open: %v", u)
	}
	// Sela watches the book she posted to; nobody else is left.
	if h.w.MarketViewers(salveID) != 1 || h.w.MarketViewers(swordID) != 0 {
		t.Fatalf("viewers left: salve %d, sword %d", h.w.MarketViewers(salveID), h.w.MarketViewers(swordID))
	}
	h.send(cs, createOffer(sell, salveID, 5, 3))
	h.sim.RunTicks(15)
	if us := markets(append(cb.take(), cc.take()...)); len(us) != 0 {
		t.Fatalf("a closed window was refreshed: %v", us)
	}
}

// The owner of an offer sees its own offers and its mailbox change while it browses
// nothing: a fill by another player and the expiry both refresh its window, and the
// expiry refreshes the windows on that book too.
func TestMarketRefreshOwnerAndExpiry(t *testing.T) {
	h := newMarketHarness(t)
	cb, b := h.atBoard("Bruno", pos(1, 0), stack(coinID, 100, 0))
	cs, _ := h.atBoard("Sela", pos(0, 1), stack(salveID, 5, 0))
	h.send(cb, createOffer(pb.MarketSide_MARKET_SIDE_BUY, salveID, 5, 10))
	h.send(cb, browse(0))
	h.send(cs, browse(salveID))
	id := h.w.MarketOffers(b.CharacterID())[0]

	h.send(cs, acceptOffer(id, 3))
	evs := cb.take()
	u := onlyMarket(t, evs)
	if !hasKey(evs, "market.offer_filled") || !u.GetRefresh() || u.GetItemId() != 0 || len(u.GetOwn()) != 1 ||
		u.GetOwn()[0].GetAmount() != 2 || len(u.GetMailboxItems()) != 1 || u.GetMailboxItems()[0].GetItem().GetCount() != 3 {
		t.Fatalf("owner's refresh %v", u)
	}

	h.sim.Clock().Advance(time.Hour)
	h.sim.RunTicks(25)
	if h.w.MarketOfferAmount(id) != -1 {
		t.Fatal("the offer did not expire")
	}
	if u := lastMarket(cb.take()); !u.GetRefresh() || len(u.GetOwn()) != 0 || u.GetMailboxGold() != 20 {
		t.Fatalf("owner's refresh after expiry %v", u)
	}
	if u := lastMarket(cs.take()); !u.GetRefresh() || len(u.GetBuys()) != 0 {
		t.Fatalf("viewer's refresh after expiry %v", u)
	}
}

// A ban hides the account's offers at once in the windows that list them.
func TestMarketRefreshOnBan(t *testing.T) {
	var jobs []session.AdminJob
	h := newMarketHarness(t, func(c *session.Config) {
		c.Admin = func(j session.AdminJob) bool {
			if j.Kind == session.AdminBan {
				jobs = append(jobs, j)
			}
			return true
		}
	})
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 5, 0), stack(coinID, 20, 1))
	cb, _ := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0))
	h.send(cs, createOffer(sell, salveID, 2, 3))
	h.send(cb, browse(salveID))
	nextChar++
	cg, _ := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Guia", Vocation: "guardian",
		Level: 1, Health: 145, HasPos: true, Pos: pos(4, 3), Role: session.RoleGM})
	h.send(cg, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/ban Sela 1d spam"))
	if len(jobs) != 1 {
		t.Fatalf("ban jobs %v", jobs)
	}
	h.sim.RunTicks(15) // Bruno's last refresh is old enough
	cb.take()
	h.sim.Command(h.w.AdminDone(session.AdminResult{ID: jobs[0].ID, Result: session.AdminOK,
		AccountID: s.CharacterID(), Name: "Sela"}))
	h.sim.Step()
	if u := onlyMarket(t, cb.take()); !u.GetRefresh() || len(u.GetSells()) != 0 {
		t.Fatalf("Bruno still sees the banned offer: %v", u)
	}
}

// A trade changes the money and the items both sides carry: their open market windows
// show it at once.
func TestMarketRefreshAfterTrade(t *testing.T) {
	h := newMarketHarness(t)
	ca, a := h.atBoard("Ana", pos(1, 0), stack(coinID, 40, 0))
	cb, b := h.atBoard("Beto", pos(0, 1), stack(salveID, 5, 0))
	h.send(ca, browse(salveID))
	h.send(cb, browse(salveID))
	h.startTrade(ca, cb, a, b, coinID, salveID)
	h.send(ca, tradeAccept)
	evs := h.send(cb, tradeAccept)
	if u := onlyMarket(t, evs); !u.GetRefresh() || u.GetMoney() != 40 || u.GetOwned() != 0 {
		t.Fatalf("Beto's refresh %v", u)
	}
	if u := onlyMarket(t, ca.take()); !u.GetRefresh() || u.GetMoney() != 0 || u.GetOwned() != 5 {
		t.Fatalf("Ana's refresh %v", u)
	}
}
