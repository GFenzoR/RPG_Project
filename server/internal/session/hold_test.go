package session_test

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
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
// Nobody else puts anything into it meanwhile: it would be stuck there.
func TestHeldCorpseStaysReserved(t *testing.T) {
	h, cb, cc, b, corpse, bought := heldCorpse(t)

	// Bruno woke at the temple (1, 0), next to it: he cannot drop his backpack out of it.
	if b.Pos() != pos(1, 0) {
		t.Fatalf("Bruno woke at %v", b.Pos())
	}
	own := openCorpseAt(t, h.harness, cb, pos(0, 1))
	if !hasKey(h.send(cb, moveItem(inContainer(own, 0), packID, 0, onTile(pos(2, 1)), 1)), "inventory.saving") {
		t.Fatal("the held owner dropped from its corpse")
	}
	// Caio cannot take it while Bruno is held, nor put anything into the corpse.
	other := openCorpseAt(t, h.harness, cc, pos(0, 1))
	if !hasKey(h.send(cc, moveItem(inContainer(other, 0), packID, 0, onTile(pos(1, 2)), 1)), "death.corpse_not_owner") ||
		len(corpse.Item.Items()) != 1 {
		t.Fatal("another player looted a held player's corpse")
	}
	pack := openPack(t, h.harness, cc)
	if !hasKey(h.send(cc, moveItem(inContainer(pack, 0), salveID, 0, inContainer(other, 0), 1)), "death.corpse_not_owner") ||
		len(corpse.Item.Items()) != 1 {
		t.Fatal("another player put something into a held player's corpse")
	}
	// Confirmed: the corpse is open to everyone as usual.
	h.sim.Command(h.w.Saved(b.CharacterID(), bought.Seq))
	h.sim.Step()
	if evs := h.send(cc, moveItem(inContainer(other, 0), packID, 0, onTile(pos(1, 2)), 1)); len(systemKeys(evs)) != 0 ||
		len(corpse.Item.Items()) != 0 {
		t.Fatalf("loot after the ack: %v", systemKeys(evs))
	}
}

// A corpse left before a hold is not reserved by it: its items come from a state the
// database has (the death is saved at once, behind every confirmed transfer). So when a
// later transfer of its owner is not stored, the corpse is anybody's after its owner-only
// time as usual (only a corpse left while held stays reserved, below).
func TestCorpseBeforeTheHoldIsNotReserved(t *testing.T) {
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
	if evs := other.take(); len(systemKeys(evs)) != 0 || len(corpse.Item.Items()) != 3 {
		t.Fatalf("looting a corpse left before the hold: %v", systemKeys(evs))
	}
}

// heldCorpse: Bruno buys salves (held) and dies with them next to the board; Caio stands
// next to the corpse with salves of his own. The owner-only time is 500 ms.
func heldCorpse(t *testing.T) (h *marketHarness, cb, cc *fakeClient, b *session.Player, corpse *session.Corpse, bought session.Snapshot) {
	t.Helper()
	h = newMarketHarness(t, func(c *session.Config) {
		c.Monsters = content.Monsters{} // corpses, no monsters
		c.Balance.Death.CorpseOwnerOnlyMs = 500
	})
	cs, s := h.atBoard("Sela", pos(1, 1), stack(salveID, 30, 0), stack(coinID, 50, 1))
	nextChar++
	bc := withPack(nextChar, pos(0, 1), stack(coinID, 100, 0))
	bc.Name, bc.Level = "Bruno", 20 // not a novice: the backpack falls into the corpse
	cb, b = h.joinChar(bc)
	h.send(cb, useBoard())
	cc, _ = h.trader("Caio", pos(0, 2), stack(salveID, 3, 0))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	h.send(cb, acceptOffer(h.w.MarketOffers(s.CharacterID())[0], 4))
	bought = h.transfers[len(h.transfers)-1].Snapshots[0]
	h.kill(b)
	corpses := h.w.CorpsesAt(pos(0, 1))
	if len(corpses) != 1 || len(corpses[0].Item.Items()) != 1 {
		t.Fatalf("corpse %v", corpses)
	}
	h.sim.RunTicks(20) // past the owner-only time
	return h, cb, cc, b, corpses[0], bought
}

// openCorpseAt opens the corpse at p for cl and returns its container id.
func openCorpseAt(t *testing.T, h *harness, cl *fakeClient, p world.Pos) uint32 {
	t.Helper()
	return openOnTile(t, h, cl, p, corpseID, 1)
}

// openOnTile opens the container item (at stack index i of p) for cl and returns its
// container id.
func openOnTile(t *testing.T, h *harness, cl *fakeClient, p world.Pos, item, i uint32) uint32 {
	t.Helper()
	cl.take()
	h.input(cl, useItem(onTile(p), item, i))
	h.sim.Step()
	opens := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 {
		t.Fatalf("container %d at %v not opened: %v", item, p, opens)
	}
	return opens[0].GetContainerId()
}

// When the transfer of a held player is not stored, the corpse it left while held stays
// reserved to it (it is locked out): its items may come from the state that was dropped,
// so they decay instead of reaching someone else's save. Nobody puts anything into it
// either: it would decay with it.
func TestTaintedHeldCorpseStaysReserved(t *testing.T) {
	h, _, cc, b, corpse, _ := heldCorpse(t)
	h.sim.Command(h.w.Tainted([]int64{b.CharacterID()}))
	h.sim.Step()
	if h.w.PlayerByCharacter(b.CharacterID()) != nil {
		t.Fatal("the tainted character is still in the world")
	}
	h.sim.RunTicks(100)
	other := openCorpseAt(t, h.harness, cc, pos(0, 1))
	if !hasKey(h.send(cc, moveItem(inContainer(other, 0), packID, 0, onTile(pos(1, 2)), 1)), "death.corpse_not_owner") ||
		len(corpse.Item.Items()) != 1 {
		t.Fatal("another player looted the corpse a tainted character left while held")
	}
	pack := openPack(t, h.harness, cc)
	if !hasKey(h.send(cc, moveItem(inContainer(pack, 0), salveID, 0, inContainer(other, 0), 1)), "death.corpse_not_owner") ||
		len(corpse.Item.Items()) != 1 {
		t.Fatal("another player put something into it")
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
	// Ana was not held before the move: a late ack of any snapshot of hers below the write
	// that took the sword out (a retried one) frees nothing.
	h.sim.Command(h.w.Saved(a.CharacterID(), out.Seq-1))
	h.sim.Step()
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("an ack below the owner's house write freed what she took out")
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

// What leaves a house for the street lands as a pile of its own: it never joins a
// stranger's pile there (the reservation would take that pile over: its owner could not
// pick it up until the house write is confirmed, or ever if it is dropped), only a pile
// already reserved to the mover.
func TestHouseItemLeavingJoinsNoStrangersPile(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(salveID, 5, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.rent(cl)
	h.step(cl, N) // the door tile (3,4); the street (2..4, 5) is within reach
	pack := openPack(t, h.harness, cl)
	h.send(cl, moveItem(inContainer(pack, 0), salveID, 0, onTile(pos(3, 3)), 5))
	cc, c := h.tenant("Cid", 0, pos(2, 6), stack(salveID, 3, 0))
	cp := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(inContainer(cp, 0), salveID, 0, onTile(pos(2, 5)), 3)); len(systemKeys(evs)) != 0 {
		t.Fatalf("Cid drops his salves: %v", systemKeys(evs))
	}

	if evs := h.send(cl, moveItem(onTile(pos(3, 3)), salveID, 1, onTile(pos(2, 5)), 2)); len(systemKeys(evs)) != 0 {
		t.Fatalf("throwing two salves out: %v", systemKeys(evs))
	}
	g := h.w.GroundAt(pos(2, 5))
	if len(g) != 2 || g[0].Count() != 3 || g[1].Count() != 2 {
		t.Fatalf("street %v: the salves joined Cid's pile", g)
	}
	// A pile already reserved to Ana takes more of what she throws out, also with Cid's
	// pile first on the tile.
	if evs := h.send(cl, moveItem(onTile(pos(3, 3)), salveID, 1, onTile(pos(2, 5)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("throwing one more out: %v", systemKeys(evs))
	}
	if g := h.w.GroundAt(pos(2, 5)); len(g) != 2 || g[0].Count() != 3 || g[1].Count() != 3 {
		t.Fatalf("street %v, want Cid's pile of 3 and Ana's of 3", g)
	}
	// Cid's pile is still his to take; Ana's is reserved to her.
	if evs := h.send(cc, moveItem(onTile(pos(2, 5)), salveID, 1, inContainer(cp, 0), 3)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(c, "test_salve") != 3 {
		t.Fatalf("Cid takes his salves back: %v", systemKeys(evs))
	}
	if !hasKey(h.send(cc, moveItem(onTile(pos(2, 5)), salveID, 1, inContainer(cp, 0), 3)), "inventory.not_yours") {
		t.Fatal("Cid took what left the house before the ack")
	}
	h.sim.Command(h.w.Saved(a.CharacterID(), lastSnapshot(t, h.transfers, a.CharacterID()).Seq))
	h.sim.Step()
	if evs := h.send(cc, moveItem(onTile(pos(2, 5)), salveID, 1, inContainer(cp, 0), 3)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(c, "test_salve") != 6 {
		t.Fatalf("pick up after the ack: %v", systemKeys(evs))
	}
}

// What leaves a house goes into no container on the street but one already reserved to
// the mover: in a stranger's bag it would make that bag the mover's until the house write
// is confirmed, and for good if that write is dropped. The house item goes to the ground
// first (inventory.floor_first).
func TestHouseItemLeavingGoesIntoNoStrangersContainer(t *testing.T) {
	h := newHouseHarness(t)
	cl, a := h.tenant("Ana", 0, cottageExit, stack(salveID, 5, 0), stack(bagID, 1, 1), stack(coinID, 100, 2),
		stack(coinID, 100, 3))
	h.rent(cl)
	h.step(cl, N)
	pack := openPack(t, h.harness, cl)
	h.send(cl, moveItem(inContainer(pack, 0), salveID, 0, onTile(pos(3, 3)), 5))
	h.send(cl, moveItem(inContainer(pack, 0), bagID, 0, onTile(pos(2, 3)), 1))
	cc, c := h.tenant("Cid", 0, pos(4, 6), stack(bagID, 1, 0))
	cp := openPack(t, h.harness, cc)
	h.send(cc, moveItem(inContainer(cp, 0), bagID, 0, onTile(pos(4, 5)), 1))

	cids := openOnTile(t, h.harness, cl, pos(4, 5), bagID, 1)
	if !hasKey(h.send(cl, moveItem(onTile(pos(3, 3)), salveID, 1, inContainer(cids, 0), 1)), "inventory.floor_first") ||
		len(h.w.GroundAt(pos(4, 5))[0].Items()) != 0 {
		t.Fatal("a house item went into a stranger's bag on the street")
	}
	if evs := h.send(cc, moveItem(onTile(pos(4, 5)), bagID, 1, inContainer(cp, 0), 1)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(c, "test_bag") != 1 {
		t.Fatalf("Cid takes his bag back: %v", systemKeys(evs))
	}

	// Her own bag, thrown out to the street, is reserved to her: it takes house items.
	if evs := h.send(cl, moveItem(onTile(pos(2, 3)), bagID, 1, onTile(cottageExit), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("throwing her bag out: %v", systemKeys(evs))
	}
	own := openOnTile(t, h.harness, cl, cottageExit, bagID, 1)
	if evs := h.send(cl, moveItem(onTile(pos(3, 3)), salveID, 1, inContainer(own, 0), 2)); len(systemKeys(evs)) != 0 ||
		len(h.w.GroundAt(cottageExit)[0].Items()) != 1 {
		t.Fatalf("into her own reserved bag: %v", systemKeys(evs))
	}
	if !hasKey(h.send(cc, moveItem(onTile(cottageExit), bagID, 1, inContainer(cp, 0), 1)), "inventory.not_yours") {
		t.Fatal("Cid took Ana's bag before the ack")
	}
	h.sim.Command(h.w.Saved(a.CharacterID(), lastSnapshot(t, h.transfers, a.CharacterID()).Seq))
	h.sim.Step()
	if evs := h.send(cc, moveItem(onTile(cottageExit), bagID, 1, inContainer(cp, 0), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("pick up after the ack: %v", systemKeys(evs))
	}
}

// The case of the review: a player dies on the street next to a house and its owner moves
// something from the house floor into the corpse. That must not make the corpse the
// owner's: the dead player would get "not yours" for its own equipment while the owner is
// held, and for good if the owner's house write is dropped. A corpse is reserved to its
// owner both ways (corpse_not_owner), and past that it is a container like any other on
// the street (inventory.floor_first); either way it stays the dead player's.
func TestHouseItemLeavingGoesIntoNoCorpse(t *testing.T) {
	h := newHouseHarness(t, func(c *session.Config) {
		c.Monsters = content.Monsters{} // corpses, no monsters
		c.Balance.Death.CorpseOwnerOnlyMs = 500
	})
	cl, _ := h.tenant("Ana", 0, cottageExit, stack(salveID, 5, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.rent(cl)
	h.step(cl, N)
	pack := openPack(t, h.harness, cl)
	h.send(cl, moveItem(inContainer(pack, 0), salveID, 0, onTile(pos(3, 3)), 5))
	nextChar++
	bc := withPack(nextChar, pos(4, 5), stack(coinID, 10, 0))
	bc.Name, bc.Level = "Beto", 20 // not a novice: the backpack falls into the corpse
	_, b := h.joinChar(bc)
	h.kill(b)
	corpse := h.w.CorpsesAt(pos(4, 5))
	if len(corpse) != 1 || len(corpse[0].Item.Items()) != 1 {
		t.Fatalf("corpse %v", corpse)
	}
	into := openCorpseAt(t, h.harness, cl, pos(4, 5))
	put := moveItem(onTile(pos(3, 3)), salveID, 1, inContainer(into, 0), 1)
	if !hasKey(h.send(cl, put), "death.corpse_not_owner") || len(corpse[0].Item.Items()) != 1 {
		t.Fatal("a house item went into a corpse still reserved to its owner")
	}
	h.sim.RunTicks(20) // past the owner-only time
	if !hasKey(h.send(cl, put), "inventory.floor_first") || len(corpse[0].Item.Items()) != 1 {
		t.Fatal("a house item went into another player's corpse on the street")
	}
	// The corpse is nobody's reservation: anyone loots it as usual.
	cc, c := h.tenant("Cid", 0, pos(5, 5))
	loot := openCorpseAt(t, h.harness, cc, pos(4, 5))
	cp := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(inContainer(loot, 0), packID, 0, inContainer(cp, 0), 1)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(c, "copper_coin") != 10 {
		t.Fatalf("looting the corpse: %v", systemKeys(evs))
	}
}

// Each reservation waits for the ack of the transfer it may come from, not for the end of
// the hold: a player that keeps buying stays held (it drops nothing), but what fell at its
// feet for an earlier purchase is anybody's once that purchase is confirmed.
func TestReservationEndsWithItsOwnAck(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0), stack(bagID, 1, 1), stack(swordID, 1, 2))
	cc, c := h.trader("Caio", pos(1, 1), stack(coinID, 5, 0))
	h.send(cs, createOffer(sell, salveID, 10, 4))
	id := h.w.MarketOffers(s.CharacterID())[0]
	h.send(cb, acceptOffer(id, 4))
	first := lastSnapshot(t, h.transfers, b.CharacterID())
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(b, "test_sword", 1) })) // the backpack is full: it falls
	h.sim.Step()
	if len(h.w.GroundAt(pos(0, 1))) != 1 {
		t.Fatalf("the sword did not fall: %v", h.w.GroundAt(pos(0, 1)))
	}
	h.send(cb, acceptOffer(id, 1)) // a newer purchase: Bruno stays held past the first ack
	second := lastSnapshot(t, h.transfers, b.CharacterID())
	if second.Seq <= first.Seq {
		t.Fatalf("second purchase %d after %d", second.Seq, first.Seq)
	}

	h.sim.Command(h.w.Saved(b.CharacterID(), first.Seq))
	h.sim.Step()
	if !h.w.InFlightForTest(b.CharacterID()) {
		t.Fatal("the first ack ended the hold of the second purchase")
	}
	pack := openPack(t, h.harness, cb)
	if !hasKey(h.send(cb, moveItem(inContainer(pack, 3), salveID, 0, onTile(pos(0, 2)), 1)), "inventory.saving") {
		t.Fatal("Bruno dropped before his second purchase was confirmed")
	}
	cp := openPack(t, h.harness, cc)
	if evs := h.send(cc, moveItem(onTile(pos(0, 1)), swordID, 1, inContainer(cp, 0), 1)); len(systemKeys(evs)) != 0 ||
		h.w.CountItem(c, "test_sword") != 1 {
		t.Fatalf("the sword is still reserved after the ack of its purchase: %v", systemKeys(evs))
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

// End to end with a real Saver: a guest's house write is rejected, which taints the house;
// the owner, innocent, then takes the guest's sword out to the street. The Saver skips
// the owner's house write (the house is tainted) and taints the owner too, so no ack of
// the owner ever comes: the sword stays reserved to the owner for good, even after both
// are out of the world. Without that, the sword (only in memory: the database still has
// it nowhere, the guest's write was rejected) would reach a passer-by's save.
func TestTaintedHouseKeepsWhatLeftItReserved(t *testing.T) {
	acks := make(chan session.Snapshot, 64)
	tainted := make(chan []int64, 4)
	var rejectChar atomic.Int64 // transfers carrying this character are rejected
	var mu sync.Mutex
	var written []uint64
	saver, err := session.NewSaver(session.SaverConfig{
		Write: func(context.Context, session.Snapshot) error { return nil },
		WriteTransfer: func(_ context.Context, tr session.Transfer) error {
			for _, s := range tr.Snapshots {
				if s.CharacterID == rejectChar.Load() {
					return fmt.Errorf("%w: injected", session.ErrPermanent)
				}
			}
			mu.Lock()
			written = append(written, tr.ID)
			mu.Unlock()
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
	h := newHouseHarness(t, func(c *session.Config) {
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
	taint := func() []int64 {
		t.Helper()
		select {
		case ids := <-tainted:
			return ids
		case <-time.After(10 * time.Second): //nolint:forbidigo // bounds a wait on the Saver's goroutine
			t.Fatal("the Saver reported no taint")
			return nil
		}
	}

	cl, a := h.tenant("Ana", 0, cottageExit, stack(coinID, 100, 0), stack(coinID, 100, 1))
	h.rent(cl)
	h.step(cl, N)
	h.input(cl, walk(pb.Direction_DIRECTION_NORTH_WEST))
	h.sim.RunTicks(40) // (2,3), inside
	cb, b := h.tenant("Beto", 0, pos(2, 5), stack(swordID, 1, 0))
	h.send(cl, houseCmd(&pb.HouseGuestAdd{Name: "Beto"}))
	h.step(cb, NE) // the door tile

	// Beto's house write is rejected: Beto and the cottage are tainted in the Saver. The
	// loop does not know yet (World.Tainted is still on its way).
	rejectChar.Store(b.CharacterID())
	bp := openPack(t, h.harness, cb)
	if evs := h.send(cb, moveItem(inContainer(bp, 0), swordID, 0, onTile(pos(3, 3)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("the guest brings a sword: %v", systemKeys(evs))
	}
	if ids := taint(); !slices.Equal(ids, []int64{b.CharacterID()}) {
		t.Fatalf("tainted %v, want Beto", ids)
	}
	deliver(a.CharacterID(), lastSnapshot(t, transfers, a.CharacterID()).Seq) // Ana's own writes are in
	if h.w.InFlightForTest(a.CharacterID()) {
		t.Fatal("Ana is still held")
	}

	// Ana takes the sword out to the street: her house write is skipped, she is tainted.
	h.step(cb, S)
	h.input(cl, walk(SE))
	h.sim.RunTicks(40)
	cc, c := h.tenant("Cid", 0, pos(5, 5), stack(coinID, 1, 0))
	if evs := h.send(cl, moveItem(onTile(pos(3, 3)), swordID, 1, onTile(pos(4, 5)), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("the owner takes the sword out: %v", systemKeys(evs))
	}
	out := transfers[len(transfers)-1]
	if ids := taint(); !slices.Equal(ids, []int64{a.CharacterID()}) {
		t.Fatalf("tainted %v, want Ana", ids)
	}
	mu.Lock()
	if slices.Contains(written, out.ID) {
		t.Fatal("the Saver wrote the house write of a tainted house")
	}
	mu.Unlock()

	cp := openPack(t, h.harness, cc)
	take := moveItem(onTile(pos(4, 5)), swordID, 1, inContainer(cp, 0), 1)
	if !hasKey(h.send(cc, take), "inventory.not_yours") {
		t.Fatal("a passer-by took what left a tainted house")
	}
	// Every ack the Saver sent reaches the loop; then the taints. The sword stays reserved.
	for len(acks) > 0 {
		s := <-acks
		if s.CharacterID == a.CharacterID() && s.Seq >= out.Snapshots[0].Seq {
			t.Fatalf("the skipped write was acked: %+v", s)
		}
		h.sim.Command(h.w.Saved(s.CharacterID, s.Seq))
		h.sim.Step()
	}
	h.sim.Command(h.w.Tainted([]int64{b.CharacterID()}))
	h.sim.Command(h.w.Tainted([]int64{a.CharacterID()}))
	h.sim.Step()
	if h.w.PlayerByCharacter(a.CharacterID()) != nil || h.w.PlayerByCharacter(b.CharacterID()) != nil {
		t.Fatal("a tainted character is still in the world")
	}
	h.sim.RunTicks(100)
	if !hasKey(h.send(cc, take), "inventory.not_yours") || h.w.CountItem(c, "test_sword") != 0 ||
		len(h.w.GroundAt(pos(4, 5))) != 1 {
		t.Fatal("a passer-by took what a tainted owner took out of a tainted house")
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
