package session_test

import (
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Item hotkeys (docs/02 "Teclas rapidas de items"): UseItemType uses one unit of a type from
// wherever the character carries it, and ItemCounts keeps the totals of the types the client
// tracks (SetItemHotkeys).

func useType(id uint16) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_UseItemType{UseItemType: &pb.UseItemType{ItemId: uint32(id)}}}
}

func trackTypes(ids ...uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_SetItemHotkeys{SetItemHotkeys: &pb.SetItemHotkeys{ItemIds: ids}}}
}

// lastCounts is the last ItemCounts of evs as {item: count}, nil when there was none.
func lastCounts(evs []*pb.ServerMessage) map[uint32]uint32 {
	all := find(evs, (*pb.ServerMessage).GetItemCounts)
	if len(all) == 0 {
		return nil
	}
	out := map[uint32]uint32{}
	for _, c := range all[len(all)-1].GetCounts() {
		out[c.GetItemId()] = c.GetCount()
	}
	return out
}

// stackOf is the size of the first stack of salves directly in c (0 if none).
func stackOf(c *session.Item, id uint16) int {
	for _, it := range c.Items() {
		if it.Def().Numeric == id {
			return it.Count()
		}
	}
	return 0
}

// salveHarness is a 1 s item cooldown on the test items.
func salveHarness(t *testing.T) *harness {
	return newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) {
		c.Items = testItems()
		c.Balance.Inventory.UseCooldownMs = 1000
	})
}

// salves 5 in the pockets, 2 in the backpack and 3 in a bag inside the backpack.
func carryingSalves() session.Character {
	bag := session.ItemState{ItemID: bagID, Count: 1, Slot: 1, Items: []session.ItemState{{ItemID: salveID, Count: 3}}}
	c := withPack(9701, pos(10, 10), session.ItemState{ItemID: salveID, Count: 2, Slot: 0}, bag,
		session.ItemState{ItemID: salveID, Count: 5, Slot: 0, Pocket: true})
	c.Health = 20
	return c
}

// The first matching stack is the pockets', then the backpack's own cells, then the bag
// inside it; the windows are closed the whole time and the client never says where.
func TestUseItemTypeOrderAndClosedContainers(t *testing.T) {
	h := salveHarness(t)
	cl, p := h.joinChar(carryingSalves())
	bp := p.Equipped(slotBackpack)
	var bag *session.Item
	for _, it := range bp.Items() {
		if it.Def().Numeric == bagID {
			bag = it
		}
	}
	if bag == nil {
		t.Fatal("no bag in the backpack")
	}
	left := func() [3]int {
		return [3]int{stackOf(p.Pockets(), salveID), stackOf(bp, salveID), stackOf(bag, salveID)}
	}
	want := [][3]int{{4, 2, 3}, {3, 2, 3}, {2, 2, 3}, {1, 2, 3}, {0, 2, 3}, {0, 1, 3}, {0, 0, 3}, {0, 0, 2}, {0, 0, 1}, {0, 0, 0}}
	for i, w := range want {
		h.sim.RunTicks(20)
		h.send(cl, useType(salveID))
		if got := left(); got != w {
			t.Fatalf("use %d: pockets, backpack, bag = %v, want %v", i+1, got, w)
		}
	}
	h.sim.RunTicks(20)
	evs := h.send(cl, useType(salveID))
	if !hasKey(evs, "inventory.none_carried") {
		t.Errorf("with none left: %v", systemKeys(evs))
	}
}

// What is not carried, not usable or unknown is refused with a message and costs nothing.
func TestUseItemTypeRefuses(t *testing.T) {
	h := salveHarness(t)
	c := withPack(9702, pos(10, 10), session.ItemState{ItemID: swordID, Count: 1, Slot: 0})
	cl, _ := h.joinChar(c)
	for name, id := range map[string]uint32{"not carried": salveID, "equipment": swordID, "container": bagID, "unknown": 4242, "too big": 1 << 20, "zero": 0} {
		h.sim.RunTicks(20)
		evs := h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_UseItemType{UseItemType: &pb.UseItemType{ItemId: id}}})
		keys := systemKeys(evs)
		switch name {
		case "not carried":
			if keys["inventory.none_carried"] != 1 {
				t.Errorf("%s: %v", name, keys)
			}
		default:
			if keys["inventory.cannot_use"] != 1 {
				t.Errorf("%s: %v", name, keys)
			}
		}
	}
}

// A use by type obeys the same item cooldown as UseItem: a second one in the same second is
// refused (not_ready) and keeps its unit.
func TestUseItemTypeSameCooldown(t *testing.T) {
	h := salveHarness(t)
	cl, p := h.joinChar(carryingSalves())
	h.input(cl, useType(salveID))
	h.input(cl, useType(salveID))
	h.sim.Step()
	evs := cl.take()
	if !hasKey(evs, "inventory.not_ready") || stackOf(p.Pockets(), salveID) != 4 {
		t.Fatalf("pockets %d, messages %v", stackOf(p.Pockets(), salveID), systemKeys(evs))
	}
	// And a normal UseItem right after is refused too: one cooldown for both ways.
	h.input(cl, useItem(inPocket(0), salveID, 0))
	h.sim.Step()
	if !hasKey(cl.take(), "inventory.not_ready") || stackOf(p.Pockets(), salveID) != 4 {
		t.Errorf("UseItem after a typed use was not refused")
	}
	h.sim.RunTicks(20)
	h.input(cl, useType(salveID))
	h.sim.Step()
	if stackOf(p.Pockets(), salveID) != 3 {
		t.Errorf("after the cooldown: %d", stackOf(p.Pockets(), salveID))
	}
}

// A rune is used by type from a closed container: it casts on the current target or self and
// spends a charge; the counts of a rune are its charges.
func TestUseItemTypeRune(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) {
		c.Items = testItems()
		c.Balance.Inventory.UseCooldownMs = 1000
	})
	c := withPack(9703, pos(10, 10), session.ItemState{ItemID: runeID, Count: 3, Slot: 0})
	cl, _ := h.joinChar(c)
	evs := h.send(cl, trackTypes(runeID))
	if got := lastCounts(evs); got[runeID] != 3 {
		t.Fatalf("rune charges counted: %v", got)
	}
}

// The counts: sent after SetItemHotkeys for every usable known type (the rest dropped), again
// whenever a total changes (use, drop, pick up, move into a closed bag), and not at all on a
// tick that changed nothing.
func TestItemCounts(t *testing.T) {
	h := salveHarness(t)
	cl, p := h.joinChar(carryingSalves())
	evs := h.send(cl, trackTypes(salveID, salveID, swordID, 4242, runeID, 1<<20))
	got := lastCounts(evs)
	if len(got) != 2 || got[salveID] != 10 || got[runeID] != 0 {
		t.Fatalf("first counts: %v", got)
	}
	if evs := h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{}}}); lastCounts(evs) != nil {
		t.Errorf("counts sent on a tick that changed nothing")
	}
	// Use one: 9.
	h.sim.RunTicks(20)
	if got := lastCounts(h.send(cl, useType(salveID))); got[salveID] != 9 {
		t.Errorf("after a use: %v", got)
	}
	// Drop the pocket stack (4) on the ground: 5; the totals follow the ground.
	h.sim.RunTicks(20)
	if got := lastCounts(h.send(cl, moveItem(inPocket(0), salveID, 0, onTile(pos(10, 11)), 4))); got[salveID] != 5 {
		t.Errorf("after a drop: %v", got)
	}
	// Pick it up again into the backpack: 9.
	if got := lastCounts(h.send(cl, moveItem(onTile(pos(10, 11)), salveID, 1, inPocket(0), 4))); got[salveID] != 9 {
		t.Errorf("after a pick up: %v", got)
	}
	// Empty list: the next change tells nothing.
	h.send(cl, trackTypes())
	h.sim.RunTicks(20)
	if got := lastCounts(h.send(cl, useType(salveID))); len(got) != 0 {
		t.Errorf("counts after stopping: %v", got)
	}
	_ = p
}
