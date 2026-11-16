package session_test

import (
	"context"
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// The transfer hold of the fail-safe (docs/01 "Transacciones", hold.go): until the
// database confirms a transfer, nothing of its characters reaches the public ground or
// leaves their corpses; the house floors are guarded by the Saver.

// After a transfer the player drops nothing outside a house until the database confirms
// its snapshot in it (any later ack of the character does too); a relogin keeps the hold.
// Moving things inside its own containers is never held.
func TestTransferHoldsDropsUntilSaved(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(bagID, 1, 1))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	id := h.w.MarketOffers(s.CharacterID())[0]
	h.send(cb, acceptOffer(id, 4))
	bought := h.transfers[len(h.transfers)-1].Snapshots[0]
	if bought.CharacterID != b.CharacterID() || !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatalf("transfer snapshot %d, held %v", bought.CharacterID, h.w.InFlightForTest(b.CharacterID()))
	}

	pack := openPack(t, h.harness, cb)
	// The backpack holds the coins, the bag, then the bought salves.
	drop := moveItem(inContainer(pack, 2), salveID, 0, onTile(pos(0, 2)), 4)
	if !hasKey(h.send(cb, drop), "inventory.saving") || h.w.CountItem(b, "test_salve") != 4 ||
		len(h.w.GroundAt(pos(0, 2))) != 0 {
		t.Fatalf("a held player dropped: %d salves left", h.w.CountItem(b, "test_salve"))
	}
	// Into its own bag: not a drop.
	h.input(cb, useItem(inContainer(pack, 1), bagID, 1))
	h.sim.Step()
	bag := find(cb.take(), (*pb.ServerMessage).GetContainerOpen)[0].GetContainerId()
	if evs := h.send(cb, moveItem(inContainer(pack, 2), salveID, 0, inContainer(bag, 0), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("moving into its own bag: %v", systemKeys(evs))
	}
	drop = moveItem(inContainer(pack, 2), salveID, 0, onTile(pos(0, 2)), 3)

	// An ack of an older snapshot does not end the hold; the transfer's does.
	h.sim.Command(h.w.Saved(b.CharacterID(), bought.Seq-1))
	if !hasKey(h.send(cb, drop), "inventory.saving") {
		t.Fatal("an older ack ended the hold")
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), bought.Seq))
	h.sim.Step()
	if h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("still held after the ack")
	}
	if evs := h.send(cb, drop); hasKey(evs, "inventory.saving") || len(h.w.GroundAt(pos(0, 2))) != 1 {
		t.Fatalf("drop after the ack: %v", systemKeys(evs))
	}

	// Another purchase, then Bruno leaves and comes back before anything is acked: the
	// hold is the character's, not the connection's.
	h.send(cb, acceptOffer(id, 1))
	h.sim.Command(h.w.Leave(cb))
	h.sim.Step()
	final := h.saves[len(h.saves)-1]
	if !final.Final || final.CharacterID != b.CharacterID() {
		t.Fatalf("final save %+v", final)
	}
	again := &fakeClient{}
	c := withPack(b.CharacterID(), pos(0, 1))
	c.Name = "Bruno"
	h.sim.Command(h.w.Join(c, again))
	h.sim.Step()
	if !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("the relogin dropped the hold")
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), final.Seq))
	h.sim.Step()
	if h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("the final save's ack did not end the hold")
	}
}

// A held player that dies: its corpse stays reserved past its owner-only time until the
// transfer is confirmed, and the owner cannot put what lies in it on the ground either.
func TestHeldCorpseStaysReserved(t *testing.T) {
	h := newMarketHarness(t, func(c *session.Config) {
		c.Monsters = content.Monsters{} // corpses, no monsters
		c.Balance.Death.CorpseOwnerOnlyMs = 500
	})
	cs, s := h.atBoard("Sela", pos(1, 1), stack(salveID, 30, 0), stack(coinID, 50, 1))
	nextChar++
	bc := withPack(nextChar, pos(0, 1), stack(coinID, 100, 0))
	bc.Name, bc.Level = "Bruno", 20 // not a novice: the backpack falls into the corpse
	cb, b := h.joinChar(bc)
	h.send(cb, useBoard())
	cc, _ := h.trader("Caio", pos(0, 2))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	h.send(cb, acceptOffer(h.w.MarketOffers(s.CharacterID())[0], 4))
	bought := h.transfers[len(h.transfers)-1].Snapshots[0]
	h.kill(b)
	corpse := h.w.CorpsesAt(pos(0, 1))
	if len(corpse) != 1 || len(corpse[0].Item.Items()) != 1 {
		t.Fatalf("corpse %v", corpse)
	}
	h.sim.RunTicks(20) // past the owner-only time
	openCorpse := func(cl *fakeClient) uint32 {
		t.Helper()
		cl.take()
		h.input(cl, useItem(onTile(pos(0, 1)), corpseID, 1))
		h.sim.Step()
		opens := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
		if len(opens) != 1 {
			t.Fatalf("corpse not opened: %v", opens)
		}
		return opens[0].GetContainerId()
	}

	// Bruno woke at the temple (1, 0), next to it: he cannot drop his backpack out of it.
	if b.Pos() != pos(1, 0) {
		t.Fatalf("Bruno woke at %v", b.Pos())
	}
	own := openCorpse(cb)
	if !hasKey(h.send(cb, moveItem(inContainer(own, 0), packID, 0, onTile(pos(2, 1)), 1)), "inventory.saving") {
		t.Fatal("the held owner dropped from its corpse")
	}
	// Caio cannot take it while Bruno is held.
	other := openCorpse(cc)
	if !hasKey(h.send(cc, moveItem(inContainer(other, 0), packID, 0, onTile(pos(1, 2)), 1)), "death.corpse_not_owner") ||
		len(corpse[0].Item.Items()) != 1 {
		t.Fatal("another player looted a held player's corpse")
	}
	// Confirmed: the corpse is open to everyone as usual.
	h.sim.Command(h.w.Saved(b.CharacterID(), bought.Seq))
	h.sim.Step()
	if evs := h.send(cc, moveItem(inContainer(other, 0), packID, 0, onTile(pos(1, 2)), 1)); len(systemKeys(evs)) != 0 ||
		len(corpse[0].Item.Items()) != 0 {
		t.Fatalf("loot after the ack: %v", systemKeys(evs))
	}
}

// When a transfer of a character is not stored, the corpses it left stay reserved to it
// (it is locked out): their items come from the state that was dropped, so they decay
// instead of reaching someone else's save.
func TestTaintedCorpsesStayReserved(t *testing.T) {
	h := deathHarness(t, func(c *session.Config) { c.Balance.Death.EquipmentDropPct = 100 })
	_, p := h.geared("Owner", 20, 0)
	other, _ := h.join("Other", at(41, 40))
	h.kill(p)
	corpse := h.w.CorpsesAt(pos(40, 40))[0]
	h.sim.Command(h.w.Tainted([]int64{p.CharacterID()}))
	h.sim.Step()
	if h.w.PlayerByCharacter(p.CharacterID()) != nil {
		t.Fatal("the tainted character is still in the world")
	}
	h.sim.RunTicks(testBalance().Death.CorpseOwnerOnlyMs/int(game.TickDuration.Milliseconds()) + 20)

	other.take()
	h.input(other, useItem(onTile(pos(40, 40)), corpseID, 1))
	h.sim.Step()
	opens := find(other.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 {
		t.Fatalf("corpse not opened: %v", opens)
	}
	h.input(other, moveItem(inContainer(opens[0].GetContainerId(), 0), packID, 0, onTile(pos(41, 40)), 1))
	h.sim.Step()
	if !hasKey(other.take(), "death.corpse_not_owner") || len(corpse.Item.Items()) != 4 {
		t.Fatal("another player looted a tainted character's corpse")
	}
}

func houseItems(id uint64, house string, chars ...int64) session.Transfer {
	t := tr(id, chars...)
	t.Houses = []session.HouseOp{{Kind: session.HouseItems, House: house}}
	return t
}

// The house floors are guarded by the Saver: once a transfer that replaced a house's
// items is dropped, no later transfer writes that house's items (the guest who picked up
// what a tainted character left there is tainted too); other houses, and other changes
// of that house, are still written.
func TestSaverTaintsHouseItems(t *testing.T) {
	f := &fakeDB{reject: map[uint64]bool{1: true}}
	s := f.saver(t)
	s.Start()
	s.SubmitTransfer(tr(1, 1))                    // Ana's purchase: rejected, Ana tainted
	s.SubmitTransfer(houseItems(2, "cottage", 1)) // Ana drops it in the cottage: skipped
	s.SubmitTransfer(houseItems(3, "cottage", 2)) // Caio picks it up there: skipped, Caio tainted
	s.SubmitTransfer(houseItems(4, "hut", 3))     // another house: written
	paid := tr(5)                                 // the cottage's rent, not its items: written
	paid.Houses = []session.HouseOp{{Kind: session.HousePaid, House: "cottage"}}
	s.SubmitTransfer(paid)
	s.Submit(session.Snapshot{CharacterID: 2})
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.stored, []string{"transfer 4", "transfer 5"}) {
		t.Fatalf("stored %v", f.stored)
	}
	if len(f.tainted) != 2 || !slices.Equal(f.tainted[0], []int64{1}) || !slices.Equal(f.tainted[1], []int64{2}) {
		t.Fatalf("tainted %v", f.tainted)
	}
	cottage := session.Job{Transfer: &session.Transfer{Houses: []session.HouseOp{{Kind: session.HouseItems, House: "cottage"}}}}
	if !s.Tainted(cottage) {
		t.Fatal("the cottage is not tainted")
	}
}
