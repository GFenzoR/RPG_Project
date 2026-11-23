package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// The refusals of the account stash that guard against duplicating or moving what must
// not move (docs/02 "Baúl de la cuenta"). Every refused move writes nothing.

// bagWith is a saved test_bag in cell slot holding items.
func bagWith(slot int, items ...session.ItemState) session.ItemState {
	return session.ItemState{ItemID: bagID, Count: 1, Slot: slot, Items: items}
}

// bagChain is n test_bags, each inside the one before (height n-1), in cell slot.
func bagChain(n, slot int) session.ItemState {
	s := session.ItemState{ItemID: bagID, Count: 1}
	for i := 1; i < n; i++ {
		s = session.ItemState{ItemID: bagID, Count: 1, Items: []session.ItemState{s}}
	}
	s.Slot = slot
	return s
}

func (h *stashHarness) wantResult(cl *fakeClient, m *pb.ClientMessage, want pb.StashResult, what string) *pb.StashUpdate {
	h.t.Helper()
	u := lastStash(h.send(cl, m))
	if u.GetResult() != want {
		h.t.Fatalf("%s: got %v, want %v", what, u, want)
	}
	return u
}

// What is offered in an open trade never goes in the stash: neither the offered item nor
// a container with an offered item inside (else the trade would hand over a copy).
func TestStashRefusesWhatIsOfferedInATrade(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	ca, a := h.account(1, 100, "Ana", pos(1, 1), nil, stack(swordID, 1, 0), bagWith(1, stack(salveID, 5, 0)))
	_, b := h.account(2, 200, "Beto", pos(2, 1), nil)
	h.open(ca)
	pack := openPack(t, h.harness, ca)
	h.input(ca, useItem(inContainer(pack, 1), bagID, 0))
	h.sim.Step()
	opens := find(ca.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 {
		t.Fatalf("the bag did not open: %v", opens)
	}
	bag := opens[0].GetContainerId()
	// Ana offers the salves inside the bag.
	if u := lastTrade(h.send(ca, tradeReq(b.ID(), inContainer(bag, 0), salveID))); u.GetState() != pb.TradeState_TRADE_STATE_REQUESTED ||
		len(u.GetOwnOffer()) != 1 {
		t.Fatalf("the trade request: %v", u)
	}
	h.wantResult(ca, stashDeposit(inContainer(pack, 1), bagID, 1), pb.StashResult_STASH_RESULT_NOT_ALLOWED,
		"the bag holding the offered salves")
	h.wantResult(ca, stashDeposit(inContainer(bag, 0), salveID, 5), pb.StashResult_STASH_RESULT_NOT_ALLOWED,
		"the offered salves")
	h.wantResult(ca, stashDeposit(inContainer(bag, 0), salveID, 2), pb.StashResult_STASH_RESULT_NOT_ALLOWED,
		"part of the offered salves")
	// What is not offered still goes in.
	h.wantResult(ca, stashDeposit(inContainer(pack, 0), swordID, 1), pb.StashResult_STASH_RESULT_OK, "the sword")
	if h.stashCount(100, salveID) != 0 || h.stashCount(100, bagID) != 0 || h.w.CountItem(a, "test_salve") != 5 {
		t.Fatal("an offered item reached the stash")
	}
	if len(h.transfers) != 1 {
		t.Fatalf("%d transfers, want only the sword's", len(h.transfers))
	}
}

// A tradeable container with something that is not tradeable inside (a quest item) does
// not go in: the stash would carry it to another character of the account.
func TestStashRefusesAContainerWithAQuestItem(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	cl, p := h.account(1, 100, "Ana", pos(1, 1), nil, bagWith(0, stack(salveID, 1, 0), stack(pebbleID, 1, 1)))
	h.open(cl)
	pack := openPack(t, h.harness, cl)
	h.wantResult(cl, stashDeposit(inContainer(pack, 0), bagID, 1), pb.StashResult_STASH_RESULT_NOT_ALLOWED,
		"a bag with a pebble inside")
	if h.w.CountItem(p, "test_pebble") != 1 || h.w.CountItem(p, "test_salve") != 1 || h.stashCount(100, bagID) != 0 ||
		len(h.transfers) != 0 {
		t.Fatal("the bag with the pebble left Ana")
	}
}

// A deposit from an equipment slot takes the item out of the hand: the character no
// longer fights with it.
func TestStashDepositFromAnEquipmentSlot(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	c := withPack(1, pos(1, 1))
	c.AccountID, c.Name = 100, "Ana"
	c.Inventory = append(c.Inventory, session.ItemState{ItemID: swordID, Count: 1, Slot: int(slotRight)})
	cl, p := h.joinChar(c)
	cl.take()
	var weapon *content.Item
	h.do(func(*game.TickContext) { weapon = p.WeaponForTest() })
	if weapon == nil || weapon.Numeric != swordID {
		t.Fatalf("Ana does not wield the sword: %v", weapon)
	}
	h.open(cl)
	h.wantResult(cl, stashDeposit(inSlot(slotRight), swordID, 1), pb.StashResult_STASH_RESULT_OK, "the wielded sword")
	h.do(func(*game.TickContext) { weapon = p.WeaponForTest() })
	if weapon != nil || h.w.CountItem(p, "test_sword") != 0 || h.stashCount(100, swordID) != 1 {
		t.Fatalf("after the deposit Ana fights with %v", weapon)
	}
}

// A withdrawal that does not fit refuses before anything moves: too heavy, no free cell,
// or a container that would nest deeper than the limit.
func TestStashWithdrawMustFit(t *testing.T) {
	stash := []session.ItemState{stack(salveID, 10, 0), stack(swordID, 1, 1), bagChain(8, 2), bagChain(7, 3)}

	t.Run("too heavy", func(t *testing.T) {
		h := newStashHarness(t, 30, nil)
		cl, p := h.account(1, 100, "Ana", pos(1, 1), stash)
		h.do(func(*game.TickContext) { h.w.SetCapacityForTest(p, 0) })
		h.open(cl)
		h.wantResult(cl, stashWithdraw(0, salveID, 1, nil), pb.StashResult_STASH_RESULT_TOO_HEAVY, "a salve")
		h.wantResult(cl, stashWithdraw(1, swordID, 0, nil), pb.StashResult_STASH_RESULT_TOO_HEAVY, "the sword")
		if h.stashCount(100, salveID) != 10 || h.stashCount(100, swordID) != 1 || len(h.transfers) != 0 {
			t.Fatal("a refused withdrawal moved something")
		}
	})

	t.Run("no room", func(t *testing.T) {
		h := newStashHarness(t, 30, nil)
		cl, p := h.account(1, 100, "Ana", pos(1, 1), stash,
			full(stack(pebbleID, 1, 0), stack(pebbleID, 1, 1), stack(pebbleID, 1, 2), stack(pebbleID, 1, 3))...)
		h.open(cl)
		h.wantResult(cl, stashWithdraw(0, salveID, 1, nil), pb.StashResult_STASH_RESULT_NO_ROOM, "a salve")
		h.wantResult(cl, stashWithdraw(1, swordID, 0, nil), pb.StashResult_STASH_RESULT_NO_ROOM, "the sword")
		if h.w.CountItem(p, "test_salve")+h.w.CountItem(p, "test_sword") != 0 || len(h.transfers) != 0 {
			t.Fatal("a refused withdrawal moved something")
		}
	})

	t.Run("too deep", func(t *testing.T) {
		h := newStashHarness(t, 30, nil)
		cl, p := h.account(1, 100, "Ana", pos(1, 1), stash)
		h.do(func(*game.TickContext) { h.w.SetCapacityForTest(p, 1_000_000) })
		h.open(cl)
		// The backpack is level 1: eight bags inside it would end at level 9.
		h.wantResult(cl, stashWithdraw(2, bagID, 0, nil), pb.StashResult_STASH_RESULT_NO_ROOM, "eight nested bags")
		u := h.wantResult(cl, stashWithdraw(3, bagID, 0, nil), pb.StashResult_STASH_RESULT_OK, "seven nested bags")
		// Only the empty innermost bag counts as a unit (a container that holds something is not one).
		if len(u.GetItems()) != 3 || h.w.CountItem(p, "test_bag") != 1 || len(h.transfers) != 1 {
			t.Fatalf("after the seven bags: %v, Ana carries %d bags", u, h.w.CountItem(p, "test_bag"))
		}
	})
}

// Nothing moves during a PvP lock, and the anti-flood refuses a burst of moves.
func TestStashInCombatAndTooFast(t *testing.T) {
	h := newStashHarness(t, 30, nil, func(c *session.Config) {
		c.Balance.Stash.ActionBurst, c.Balance.Stash.ActionRefillMs = 1, 1000
	})
	cl, p := h.account(1, 100, "Ana", pos(1, 1), nil, stack(salveID, 30, 0))
	h.open(cl)
	pack := openPack(t, h.harness, cl)
	h.do(func(ctx *game.TickContext) { h.w.SetPvPLockForTest(p, ctx.Tick+5) })
	h.wantResult(cl, stashDeposit(inContainer(pack, 0), salveID, 1), pb.StashResult_STASH_RESULT_IN_COMBAT, "under a PvP lock")
	h.sim.RunTicks(25) // the lock ends and the anti-flood refills
	h.wantResult(cl, stashDeposit(inContainer(pack, 0), salveID, 1), pb.StashResult_STASH_RESULT_OK, "after the lock")
	h.wantResult(cl, stashDeposit(inContainer(pack, 0), salveID, 1), pb.StashResult_STASH_RESULT_TOO_FAST, "one tick later")
	if h.stashCount(100, salveID) != 1 || len(h.transfers) != 1 {
		t.Fatal("a refused deposit moved salves")
	}
}

// A stash over its capacity (slots lowered) loses nothing and takes nothing, not even
// units into a stack it has, until a withdrawal brings it back to the capacity.
func TestStashOverCapacityTakesNothing(t *testing.T) {
	h := newStashHarness(t, 2, nil)
	read := []session.ItemState{stack(salveID, 5, 0), stack(swordID, 1, 1), stack(coinID, 10, 2)}
	cl, _ := h.account(1, 100, "Ana", pos(1, 1), read, stack(salveID, 30, 0), stack(swordID, 1, 1))
	if u := h.open(cl); len(u.GetItems()) != 3 || u.GetCapacity() != 2 {
		t.Fatalf("the stash over capacity: %v", u)
	}
	pack := openPack(t, h.harness, cl)
	h.wantResult(cl, stashDeposit(inContainer(pack, 0), salveID, 1), pb.StashResult_STASH_RESULT_FULL, "a salve into the stack")
	h.wantResult(cl, stashWithdraw(2, coinID, 10, nil), pb.StashResult_STASH_RESULT_OK, "the coins")
	h.wantResult(cl, stashDeposit(inContainer(pack, 0), salveID, 1), pb.StashResult_STASH_RESULT_OK, "a salve at capacity")
	h.wantResult(cl, stashDeposit(inContainer(pack, 1), swordID, 1), pb.StashResult_STASH_RESULT_FULL, "a new cell at capacity")
	if h.stashCount(100, salveID) != 6 {
		t.Fatalf("the stash holds %d salves, want 6", h.stashCount(100, salveID))
	}
}

// Asking for more units than the stack has means another character of the account took
// some since the window was drawn: CHANGED, like an item that is gone.
func TestStashWithdrawMoreThanLeftIsChanged(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	ca, _ := h.account(1, 100, "Ana", pos(1, 1), []session.ItemState{stack(salveID, 10, 0)})
	cb, _ := h.account(2, 100, "Beto", pos(0, 1), nil)
	h.open(ca)
	h.open(cb)
	h.wantResult(ca, stashWithdraw(0, salveID, 6, nil), pb.StashResult_STASH_RESULT_OK, "Ana takes 6")
	cb.take()
	h.wantResult(cb, stashWithdraw(0, salveID, 8, nil), pb.StashResult_STASH_RESULT_CHANGED, "Beto asks for 8 of 4")
	h.wantResult(cb, stashWithdraw(0, salveID, 0, nil), pb.StashResult_STASH_RESULT_NOT_POSSIBLE, "Beto asks for none")
	if h.stashCount(100, salveID) != 4 {
		t.Fatal("a refused withdrawal moved salves")
	}
}
