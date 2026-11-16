package session_test

import (
	"context"
	"slices"
	"testing"

	"go.yaml.in/yaml/v3"

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

// heldOverflow: Sela posts salves, Bruno (backpack full after buying 4) is held by the
// purchase, and the server then gives him a sword that does not fit (a craft, a reward,
// the coins of an NPC sale): it falls at his feet. Caio stands next to it.
func heldOverflow(t *testing.T) (h *marketHarness, cb, cc *fakeClient, b *session.Player, bought session.Snapshot) {
	t.Helper()
	h = newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b = h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(bagID, 1, 1), stack(swordID, 1, 2))
	cc, _ = h.trader("Caio", pos(1, 1), stack(coinID, 5, 0), stack(salveID, 3, 1))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	h.send(cb, acceptOffer(h.w.MarketOffers(s.CharacterID())[0], 4))
	bought = h.transfers[len(h.transfers)-1].Snapshots[0]
	if bought.CharacterID != b.CharacterID() || !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatalf("Bruno is not held: snapshot of %d", bought.CharacterID)
	}
	cb.take()
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(b, "test_sword", 1) }))
	h.sim.Step()
	if !hasKey(cb.take(), "dialog.item_on_floor") || len(h.w.GroundAt(pos(0, 1))) != 1 {
		t.Fatalf("the sword did not fall: ground %v", h.w.GroundAt(pos(0, 1)))
	}
	return h, cb, cc, b, bought
}

// What the server drops at a held player's feet is reserved to it like its corpse: nobody
// else takes or uses it, and the player itself only takes it back (no other public tile)
// until the database confirms the transfer; then it is anybody's.
func TestHeldOverflowIsReserved(t *testing.T) {
	h, cb, cc, b, bought := heldOverflow(t)
	pack := openPack(t, h.harness, cc)
	take := moveItem(onTile(pos(0, 1)), swordID, 1, inContainer(pack, 0), 1)
	if !hasKey(h.send(cc, take), "inventory.not_yours") || h.w.CountItem(b, "test_sword") != 1 {
		t.Fatal("another player picked up what fell at a held player's feet")
	}
	if !hasKey(h.send(cc, moveItem(onTile(pos(0, 1)), swordID, 1, onTile(pos(2, 1)), 1)), "inventory.not_yours") {
		t.Fatal("another player moved it")
	}
	if !hasKey(h.send(cb, moveItem(onTile(pos(0, 1)), swordID, 1, onTile(pos(0, 2)), 1)), "inventory.saving") ||
		len(h.w.GroundAt(pos(0, 1))) != 1 {
		t.Fatal("the held owner moved it to another public tile")
	}

	// Confirmed: the reservation ends with the hold.
	h.sim.Command(h.w.Saved(b.CharacterID(), bought.Seq))
	h.sim.Step()
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 || len(h.w.GroundAt(pos(0, 1))) != 0 {
		t.Fatalf("pick up after the ack: %v", systemKeys(evs))
	}
}

// When the transfer is not stored, what fell at the player's feet stays reserved until a
// restart: it comes from the state that was dropped.
func TestTaintedOverflowStaysReserved(t *testing.T) {
	h, _, cc, b, _ := heldOverflow(t)
	h.sim.Command(h.w.Tainted([]int64{b.CharacterID()}))
	h.sim.Step()
	if h.w.PlayerByCharacter(b.CharacterID()) != nil {
		t.Fatal("the tainted character is still in the world")
	}
	pack := openPack(t, h.harness, cc)
	if !hasKey(h.send(cc, moveItem(onTile(pos(0, 1)), swordID, 1, inContainer(pack, 0), 1)), "inventory.not_yours") ||
		len(h.w.GroundAt(pos(0, 1))) != 1 {
		t.Fatal("another player picked up what a tainted character left")
	}
}

// The equipment a held player's corpse cannot hold falls next to it, reserved the same
// way (death.go): nobody else takes it before the transfer is confirmed.
func TestHeldDeathOverflowIsReserved(t *testing.T) {
	h := newMarketHarness(t, func(c *session.Config) {
		c.Monsters = content.Monsters{} // corpses, no monsters
		var corpse content.Item
		if err := yaml.Unmarshal([]byte("{id: creature_remains, kind: container, pickupable: false, container: {slots: 1}}"),
			&corpse); err != nil {
			t.Fatal(err)
		}
		corpse.Numeric = corpseID
		c.Items[corpse.ID] = &corpse
		c.Balance.Death.EquipmentDropPct, c.Balance.Death.BackpackDropPct = 100, 100
	})
	cs, s := h.atBoard("Sela", pos(1, 1), stack(salveID, 30, 0), stack(coinID, 50, 1))
	nextChar++
	bc := withPack(nextChar, pos(0, 1), stack(coinID, 100, 0))
	bc.Name, bc.Level = "Bruno", 20
	bc.Inventory = append(bc.Inventory, session.ItemState{ItemID: swordID, Count: 1, Slot: int(slotRight)})
	cb, b := h.joinChar(bc)
	h.send(cb, useBoard())
	cc, _ := h.trader("Caio", pos(0, 2))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	h.send(cb, acceptOffer(h.w.MarketOffers(s.CharacterID())[0], 4))
	bought := h.transfers[len(h.transfers)-1].Snapshots[0]
	h.kill(b)

	// The backpack went into the one-slot corpse; the sword lies next to it.
	sword := -1
	for i, it := range h.w.GroundAt(pos(0, 1)) {
		if it.Def().Numeric == swordID {
			sword = i + 1 // the ground tile is index 0
		}
	}
	if sword < 0 {
		t.Fatalf("no sword on the ground: %v", h.w.GroundAt(pos(0, 1)))
	}
	h.sim.RunTicks(20) // past the corpse's owner-only time: the hold is what reserves it
	pack := openPack(t, h.harness, cc)
	take := moveItem(onTile(pos(0, 1)), swordID, uint32(sword), inContainer(pack, 0), 1)
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("another player took the overflow of a held player's corpse")
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), bought.Seq))
	h.sim.Step()
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 {
		t.Fatalf("pick up after the ack: %v", systemKeys(evs))
	}
}

// Nobody's units join a stack reserved to a held player: they would be stuck in it.
func TestHeldStackTakesNoMerge(t *testing.T) {
	h, _, cc, b, _ := heldOverflow(t)
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(b, "test_salve", 100) })) // 96 fit, 4 fall
	h.sim.Step()
	ground := h.w.GroundAt(pos(0, 1))
	if len(ground) != 2 || ground[1].Def().Numeric != salveID || ground[1].Count() != 4 {
		t.Fatalf("ground %v", ground)
	}
	pack := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(inContainer(pack, 1), salveID, 0, onTile(pos(0, 1)), 3)); len(systemKeys(evs)) != 0 {
		t.Fatalf("drop next to it: %v", systemKeys(evs))
	}
	ground = h.w.GroundAt(pos(0, 1))
	if len(ground) != 3 || ground[1].Count() != 4 || ground[2].Count() != 3 {
		t.Fatalf("Caio's salves merged into the reserved stack: %v", ground)
	}
	// And he takes his own back.
	if evs := h.send(cc, moveItem(onTile(pos(0, 1)), salveID, 3, inContainer(pack, 0), 3)); len(systemKeys(evs)) != 0 ||
		len(h.w.GroundAt(pos(0, 1))) != 2 {
		t.Fatalf("taking his salves back: %v", systemKeys(evs))
	}
}
