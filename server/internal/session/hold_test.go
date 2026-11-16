package session_test

import (
	"context"
	"fmt"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
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

// lastSnapshot is the snapshot of character id in the last transfer that carries one.
func lastSnapshot(t *testing.T, transfers []session.Transfer, id int64) session.Snapshot {
	t.Helper()
	for i := len(transfers) - 1; i >= 0; i-- {
		for _, s := range transfers[i].Snapshots {
			if s.CharacterID == id {
				return s
			}
		}
	}
	t.Fatalf("no transfer carries character %d", id)
	return session.Snapshot{}
}

// What leaves a house floor for the public ground is reserved to whoever moved it until
// the database has the house write that took it out (it carries the mover's snapshot).
// Here the owner is held (her rent and her drop are not confirmed) and throws her sword
// out to the street: if her rent was dropped, that write is skipped and the database
// still has the sword in the house, so nobody else may pick it up before the ack.
func TestHouseItemLeavingIsReserved(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(swordID, 1, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.rent(cl)
	h.step(cl, N) // the door tile (3,4), a house tile; the street (2..4, 5) is within reach
	pack := openPack(t, h.harness, cl)
	h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(3, 3)), 1))
	cc, c := h.tenant("Cid", 0, pos(4, 5), stack(coinID, 1, 0))
	if !h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("Ana is not held")
	}

	if evs := h.send(cl, moveItem(onTile(pos(3, 3)), swordID, 1, onTile(cottageExit), 1)); len(systemKeys(evs)) != 0 ||
		len(h.w.GroundAt(cottageExit)) != 1 {
		t.Fatalf("throwing the sword out: %v", systemKeys(evs))
	}
	out := h.transfers[len(h.transfers)-1]
	if len(out.Houses) != 1 || out.Houses[0].Kind != session.HouseItems || len(out.Houses[0].Items) != 0 ||
		len(out.Snapshots) != 1 || out.Snapshots[0].CharacterID != a.CharacterID() {
		t.Fatalf("the write that took it out = %+v", out)
	}

	cp := openPack(t, h.harness, cc)
	take := moveItem(onTile(cottageExit), swordID, 1, inContainer(cp, 0), 1)
	if !hasKey(h.send(cc, take), "inventory.not_yours") || h.w.CountItem(c, "test_sword") != 0 {
		t.Fatal("another player picked up what left a house before the ack")
	}
	if !hasKey(h.send(cc, useItem(onTile(cottageExit), swordID, 1)), "inventory.not_yours") {
		t.Fatal("another player used it")
	}
	on := &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
		From: onTile(cottageExit), ItemId: swordID, StackIndex: 1,
		To: &pb.ActionTarget{Target: &pb.ActionTarget_Pos{Pos: &pb.Position{X: 4, Y: 6, Z: 7}}}}}}
	if !hasKey(h.send(cc, on), "inventory.not_yours") {
		t.Fatal("another player used it on a tile")
	}
	// Ana takes it nowhere else on the street before the ack.
	if !hasKey(h.send(cl, moveItem(onTile(cottageExit), swordID, 1, onTile(pos(2, 5)), 1)), "inventory.saving") {
		t.Fatal("the held owner moved it along the street")
	}

	// An ack of an older snapshot (the drop's) frees nothing; the write's does.
	h.sim.Command(h.w.Saved(a.CharacterID(), out.Snapshots[0].Seq-1))
	h.sim.Step()
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("an older ack freed it")
	}
	h.sim.Command(h.w.Saved(a.CharacterID(), out.Snapshots[0].Seq))
	h.sim.Step()
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("pick up after the ack: %v", systemKeys(evs))
	}
}

// The other half: a guest that is held brings a sword into the house and the owner, who
// is not held, takes it out to the street. If the guest's transfer is dropped the Saver
// skips every later write of that house, the owner's included: the sword stays reserved
// to the owner until the owner's own write is confirmed (the guest's ack is not enough).
func TestHouseItemLeavingIsReservedToTheMover(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.rent(cl)
	h.step(cl, N)
	h.input(cl, walk(pb.Direction_DIRECTION_NORTH_WEST))
	h.sim.RunTicks(40) // (2,3), inside
	cb, b := h.tenant("Beto", 0, pos(2, 5), stack(swordID, 1, 0))
	h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Beto"}))
	h.step(cb, NE) // the door tile
	bp := openPack(t, h.harness, cb)
	if evs := h.send(cb, moveItem(inContainer(bp, 0), swordID, 0, onTile(pos(3, 3)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("the guest brings a sword: %v", systemKeys(evs))
	}
	brought := lastSnapshot(t, h.transfers, b.CharacterID())
	if !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("the guest is not held")
	}
	// Ana's own writes are confirmed; Beto steps back out and Ana takes his place.
	h.sim.Command(h.w.Saved(a.CharacterID(), lastSnapshot(t, h.transfers, a.CharacterID()).Seq))
	h.sim.Step()
	if h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("Ana is still held")
	}
	h.step(cb, S)
	h.input(cl, walk(SE))
	h.sim.RunTicks(40)
	if a.Pos() != cottageDoor || b.Pos() != cottageExit {
		t.Fatalf("Ana at %v, Beto at %v", a.Pos(), b.Pos())
	}
	cc, c := h.tenant("Cid", 0, pos(5, 5), stack(coinID, 1, 0))

	if evs := h.send(cl, moveItem(onTile(pos(3, 3)), swordID, 1, onTile(pos(4, 5)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("the owner takes it out: %v", systemKeys(evs))
	}
	out := lastSnapshot(t, h.transfers, a.CharacterID())
	if !h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("the write that took it out did not hold Ana")
	}
	cp := openPack(t, h.harness, cc)
	take := moveItem(onTile(pos(4, 5)), swordID, 1, inContainer(cp, 0), 1)
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("another player picked it up before the owner's write was confirmed")
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), brought.Seq))
	h.sim.Step()
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("the guest's ack freed what the owner took out")
	}
	h.sim.Command(h.w.Saved(a.CharacterID(), out.Seq))
	h.sim.Step()
	if evs := h.send(cc, take); len(systemKeys(evs)) != 0 || h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("pick up after the owner's ack: %v", systemKeys(evs))
	}
}

// Nothing goes into a container lying on the ground that is reserved to a held player:
// it would be stuck there with it (and could change hands with the reservation).
func TestHeldContainerTakesNothing(t *testing.T) {
	h, _, cc, b, _ := heldOverflow(t)
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(b, "test_bag", 1) }))
	h.sim.Step()
	ground := h.w.GroundAt(pos(0, 1))
	if len(ground) != 2 || ground[1].Def().Numeric != bagID {
		t.Fatalf("ground %v", ground)
	}
	cc.take()
	h.input(cc, useItem(onTile(pos(0, 1)), bagID, 2))
	h.sim.Step()
	opens := find(cc.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 {
		t.Fatalf("the bag did not open: %v", opens)
	}
	pack := openPack(t, h.harness, cc)
	if !hasKey(h.send(cc, moveItem(inContainer(pack, 1), salveID, 0, inContainer(opens[0].GetContainerId(), 0), 1)),
		"inventory.not_yours") || len(ground[1].Items()) != 0 {
		t.Fatal("another player put something into a reserved bag")
	}
}

// What the server drops at a player's feet on a house floor is written with that
// player's snapshot even when no command of the player put it there (an event: a
// tutorial reward, a craft finishing): if a transfer of the player was dropped, the
// Saver skips the write and taints the house instead of storing the item there.
func TestServerDropOnHouseFloorCarriesTheSnapshot(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1), stack(salveID, 5, 2),
		stack(salveID, 5, 3))
	h.rent(cl)
	h.step(cl, N)
	h.step(cl, N) // (3,3), inside
	before := len(h.transfers)
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(a, "test_sword", 2) })) // one fits, one falls
	h.sim.Step()
	if g := h.w.GroundAt(pos(3, 3)); len(g) != 1 || g[0].Def().Numeric != swordID {
		t.Fatalf("ground %v", g)
	}
	if len(h.transfers) != before+1 {
		t.Fatalf("%d transfers, want the house write", len(h.transfers)-before)
	}
	tr := h.transfers[len(h.transfers)-1]
	if len(tr.Houses) != 1 || tr.Houses[0].Kind != session.HouseItems || len(tr.Houses[0].Items) != 1 ||
		len(tr.Snapshots) != 1 || tr.Snapshots[0].CharacterID != a.CharacterID() {
		t.Fatalf("house write = %+v", tr)
	}
}

// A reservation ends when its item leaves the ground: what the owner picks back up keeps
// no entry (it would stay until a restart after a taint).
func TestHeldGroundForgetsWhatLeavesTheGround(t *testing.T) {
	h, cb, _, _, _ := heldOverflow(t)
	if n := h.w.HeldGroundForTest(); n != 1 {
		t.Fatalf("reserved %d, want 1", n)
	}
	if evs := h.send(cb, moveItem(onTile(pos(0, 1)), swordID, 1, inSlot(slotRight), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("equipping it: %v", systemKeys(evs))
	}
	if n := h.w.HeldGroundForTest(); n != 0 {
		t.Fatalf("reserved %d after it left the ground", n)
	}
}

// The hold ends with the Saver's own ack, not one the test makes up: a real Saver writes
// the purchase and acks the snapshot in it (SaverConfig.Saved, which app wires to
// World.Saved through the loop's queue), and the buyer drops again. A transfer the
// database rejects is never acked: the buyer stays held until World.Tainted takes it out.
func TestHoldEndsWithTheSaversAck(t *testing.T) {
	acks := make(chan session.Snapshot, 64)
	tainted := make(chan []int64, 4)
	var reject atomic.Bool
	saver, err := session.NewSaver(session.SaverConfig{
		Write: func(context.Context, session.Snapshot) error { return nil },
		WriteTransfer: func(context.Context, session.Transfer) error {
			if reject.Load() {
				return fmt.Errorf("%w: injected", session.ErrPermanent)
			}
			return nil
		},
		Saved:   func(s session.Snapshot) { acks <- s },
		Tainted: func(ids []int64) { tainted <- ids },
		Clock:   clock.NewFake(clock.Epoch),
	})
	if err != nil {
		t.Fatal(err)
	}
	saver.Start()
	t.Cleanup(func() { _ = saver.Stop(context.Background()) })
	var transfers []session.Transfer
	h := newMarketHarness(t, func(c *session.Config) {
		c.Transfer = func(tr session.Transfer) bool {
			transfers = append(transfers, tr)
			return saver.SubmitTransfer(tr)
		}
		c.Save = saver.Submit
	})
	// deliver hands the Saver's acks to the loop, as app does, until the one of character
	// id at seq or later.
	deliver := func(id int64, seq uint64) {
		t.Helper()
		timeout := time.After(10 * time.Second) //nolint:forbidigo // bounds a wait on the Saver's goroutine
		for {
			select {
			case s := <-acks:
				h.sim.Command(h.w.Saved(s.CharacterID, s.Seq))
				h.sim.Step()
				if s.CharacterID == id && s.Seq >= seq {
					return
				}
			case <-timeout:
				t.Fatalf("no ack of character %d at seq %d", id, seq)
			}
		}
	}

	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(bagID, 1, 1))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	id := h.w.MarketOffers(s.CharacterID())[0]
	h.send(cb, acceptOffer(id, 4))
	bought := lastSnapshot(t, transfers, b.CharacterID())
	pack := openPack(t, h.harness, cb)
	drop := moveItem(inContainer(pack, 2), salveID, 0, onTile(pos(0, 2)), 1)
	if !hasKey(h.send(cb, drop), "inventory.saving") {
		t.Fatal("Bruno dropped before the database had his purchase")
	}
	deliver(b.CharacterID(), bought.Seq)
	if h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("the Saver's ack did not end the hold")
	}
	if evs := h.send(cb, drop); len(systemKeys(evs)) != 0 || len(h.w.GroundAt(pos(0, 2))) != 1 {
		t.Fatalf("drop after the ack: %v", systemKeys(evs))
	}

	// The next purchase is rejected: no ack ever comes, the hold stays until the taint.
	reject.Store(true)
	h.send(cb, acceptOffer(id, 1))
	rejected := lastSnapshot(t, transfers, b.CharacterID())
	var ids []int64
	select {
	case ids = <-tainted:
	case <-time.After(10 * time.Second): //nolint:forbidigo // bounds a wait on the Saver's goroutine
		t.Fatal("the Saver did not report the rejected transfer")
	}
	for len(acks) > 0 {
		if a := <-acks; a.CharacterID == b.CharacterID() && a.Seq >= rejected.Seq {
			t.Fatalf("a rejected transfer was acked: %+v", a)
		}
	}
	if !h.w.InFlightForTest(b.CharacterID()) || !hasKey(h.send(cb, drop), "inventory.saving") {
		t.Fatal("Bruno dropped after his purchase was rejected")
	}
	h.sim.Command(h.w.Tainted(ids))
	h.sim.Step()
	if !slices.Equal(ids, []int64{b.CharacterID()}) || h.w.PlayerByCharacter(b.CharacterID()) != nil {
		t.Fatalf("tainted %v, Bruno still online: %v", ids, h.w.PlayerByCharacter(b.CharacterID()) != nil)
	}
}

// Snapshot numbers grow across a character's sessions: an ack the app retried late, from
// before a logout and a fresh login, never ends the hold of a newer transfer.
func TestLateAckFromAnEarlierSessionKeepsTheHold(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	id := h.w.MarketOffers(s.CharacterID())[0]
	h.send(cb, acceptOffer(id, 2))
	first := h.transfers[len(h.transfers)-1].Snapshots[0]
	h.sim.Command(h.w.Leave(cb))
	h.sim.Step()
	final := h.saves[len(h.saves)-1]
	h.sim.Command(h.w.Saved(b.CharacterID(), final.Seq)) // the final save is in: all forgotten
	h.sim.Step()

	// A fresh login (from the database) buys again; the earlier session's first ack,
	// retried, arrives only now.
	c := withPack(b.CharacterID(), pos(0, 1), stack(coinID, 92, 0), stack(salveID, 2, 1))
	c.Name = "Bruno"
	again, _ := h.joinChar(c)
	h.send(again, useBoard())
	h.send(again, acceptOffer(id, 1))
	second := h.transfers[len(h.transfers)-1].Snapshots[0]
	if second.CharacterID != b.CharacterID() || second.Seq <= final.Seq {
		t.Fatalf("the new session's snapshot %d does not follow the old final %d", second.Seq, final.Seq)
	}
	h.sim.Command(h.w.Saved(b.CharacterID(), first.Seq))
	h.sim.Step()
	if !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("a late ack of the earlier session ended the new hold")
	}
}
