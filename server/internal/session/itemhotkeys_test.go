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

const hardRuneID = 75

func init() {
	testItemDefs[hardRuneID] = "{id: test_hard_rune, kind: rune, weight: 100, rune: {spell: test_bolt, charges: 3, magic_level: 5}}"
}

// useTypeAt is a UseItemType with a target.
func useTypeAt(id uint16, to *pb.ActionTarget) *pb.ClientMessage {
	m := useType(id)
	m.GetUseItemType().To = to
	return m
}

// arcanistWith joins an arcanist at (10,10) carrying items in the backpack, on a world with
// a dummy at (12,10).
func arcanistWith(t *testing.T, items ...session.ItemState) (*harness, *fakeClient, *session.Player) {
	t.Helper()
	h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 12, 10, 0, 60))
	nextChar++
	c := withPack(nextChar, pos(10, 10), items...)
	c.Vocation, c.Mana, c.Health = "arcanist", arcanistMax, 140
	cl, p := h.joinChar(c)
	h.sim.Step()
	cl.take()
	return h, cl, p
}

// A rune is used by type from a closed container: it casts its spell at the target and
// spends a charge, the counts follow the charges, and the last one removes the rune.
func TestUseItemTypeRune(t *testing.T) {
	h, cl, p := arcanistWith(t, session.ItemState{ItemID: runeID, Count: 3, Slot: 0})
	d := h.dummy()
	bp := p.Equipped(slotBackpack)
	onD := &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: d.ID()}}
	if got := lastCounts(h.send(cl, trackTypes(runeID))); got[runeID] != 3 {
		t.Fatalf("rune charges counted: %v", got)
	}
	mana := h.w.Mana(p)
	// No target: the rune has nothing to hit, so nothing is spent.
	h.sim.RunTicks(20)
	h.send(cl, useType(runeID))
	if bp.Items()[0].Count() != 3 || h.w.MonsterHealth(d) != 1000 {
		t.Fatalf("a rune used with no target spent a charge or hit: %d charges, dummy %d", bp.Items()[0].Count(), h.w.MonsterHealth(d))
	}
	for i := range 3 {
		h.sim.RunTicks(20) // the attack group's cooldown
		evs := h.send(cl, useTypeAt(runeID, onD))
		if want := 1000 - 5*(i+1); h.w.MonsterHealth(d) != want {
			t.Fatalf("use %d: dummy %d, want %d (%v)", i+1, h.w.MonsterHealth(d), want, systemKeys(evs))
		}
		if got, want := lastCounts(evs)[runeID], uint32(2-i); got != want && want != 0 {
			t.Errorf("use %d: counts %d, want %d", i+1, got, want)
		}
		if i == 0 {
			// The group cooldown: a second cast at once is refused and keeps its charge.
			evs := h.send(cl, useTypeAt(runeID, onD))
			if !hasKey(evs, "magic.not_ready") || bp.Items()[0].Count() != 2 {
				t.Errorf("second cast in the cooldown: %v, %d charges", systemKeys(evs), bp.Items()[0].Count())
			}
		}
	}
	if len(bp.Items()) != 0 {
		t.Errorf("the last charge left the rune: %v", bp.Items())
	}
	if h.w.Mana(p) != mana {
		t.Errorf("runes spent mana: %d -> %d", mana, h.w.Mana(p))
	}
	h.sim.RunTicks(20)
	if evs := h.send(cl, useTypeAt(runeID, onD)); !hasKey(evs, "inventory.none_carried") {
		t.Errorf("with none left: %v", systemKeys(evs))
	}
}

// A rune that needs more magic level than p has is refused and keeps its charges.
func TestUseItemTypeRuneMagicLevel(t *testing.T) {
	h, cl, p := arcanistWith(t, session.ItemState{ItemID: hardRuneID, Count: 3, Slot: 0})
	d := h.dummy()
	evs := h.send(cl, useTypeAt(hardRuneID, &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: d.ID()}}))
	if !hasKey(evs, "magic.magic_level_required") || p.Equipped(slotBackpack).Items()[0].Count() != 3 || h.w.MonsterHealth(d) != 1000 {
		t.Errorf("a rune above the magic level: %v", systemKeys(evs))
	}
}

// A rune at a tile: the target the client sends reaches the spell.
func TestUseItemTypeRuneAtATile(t *testing.T) {
	h, cl, _ := arcanistWith(t, session.ItemState{ItemID: runeID, Count: 3, Slot: 0})
	d := h.dummy()
	h.send(cl, useTypeAt(runeID, &pb.ActionTarget{Target: &pb.ActionTarget_Pos{Pos: posMsgT(pos(12, 10))}}))
	if h.w.MonsterHealth(d) == 1000 {
		t.Errorf("the rune thrown at the dummy's tile did not hit")
	}
}

// The none_carried answer names the type (the client shows the item's name).
func TestUseItemTypeNoneCarriedNamesTheItem(t *testing.T) {
	h := salveHarness(t)
	cl, _ := h.joinChar(withPack(9710, pos(10, 10)))
	evs := h.send(cl, useType(salveID))
	var named bool
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		if m.GetLocalized().GetKey() != "inventory.none_carried" {
			continue
		}
		for _, prm := range m.GetLocalized().GetParams() {
			if prm.GetName() == "item" && prm.GetItem().GetItemId() == salveID {
				named = true
			}
		}
	}
	if !named {
		t.Errorf("none_carried without its item parameter: %v", evs)
	}
}

// A consumable in an equipment slot (the ammo hand) is found before the containers.
func TestUseItemTypeFromAnEquipmentSlot(t *testing.T) {
	h := salveHarness(t)
	c := withPack(9711, pos(10, 10), session.ItemState{ItemID: salveID, Count: 4, Slot: 0})
	c.Inventory = append(c.Inventory, session.ItemState{ItemID: salveID, Count: 3, Slot: int(slotAmmo)})
	c.Health = 20
	cl, p := h.joinChar(c)
	if p.Equipped(slotAmmo) == nil {
		t.Skip("the test world does not equip a salve in the ammo slot")
	}
	h.send(cl, useType(salveID))
	if ammo := p.Equipped(slotAmmo); ammo == nil || ammo.Count() != 2 || stackOf(p.Equipped(slotBackpack), salveID) != 4 {
		t.Errorf("the equipment slot was not used first")
	}
}

// Breadth-first: the backpack's own cells, then the bag in a pocket, then the bag inside the
// backpack (one level deeper).
func TestUseItemTypeBagInAPocketAfterTheBackpack(t *testing.T) {
	h := salveHarness(t)
	pocketBag := session.ItemState{ItemID: bagID, Count: 1, Slot: 0, Pocket: true, Items: []session.ItemState{{ItemID: salveID, Count: 6}}}
	packBag := session.ItemState{ItemID: bagID, Count: 1, Slot: 1, Items: []session.ItemState{{ItemID: salveID, Count: 3}}}
	c := withPack(9712, pos(10, 10), session.ItemState{ItemID: salveID, Count: 1, Slot: 2}, pocketBag, packBag)
	c.Health = 20
	cl, p := h.joinChar(c)
	var inPack, inPocket *session.Item
	for _, it := range p.Equipped(slotBackpack).Items() {
		if it.Def().Numeric == bagID {
			inPack = it
		}
	}
	for _, it := range p.Pockets().Items() {
		if it.Def().Numeric == bagID {
			inPocket = it
		}
	}
	if inPack == nil || inPocket == nil {
		t.Fatal("bags missing")
	}
	left := func() [3]int {
		return [3]int{stackOf(p.Equipped(slotBackpack), salveID), stackOf(inPocket, salveID), stackOf(inPack, salveID)}
	}
	for i, want := range [][3]int{{0, 6, 3}, {0, 5, 3}} {
		h.sim.RunTicks(20)
		h.send(cl, useType(salveID))
		if got := left(); got != want {
			t.Fatalf("use %d: backpack cell, pocket bag, pack bag = %v, want %v", i+1, got, want)
		}
	}
}

// Salves offered in a trade and then used by type leave the offer and reset the accepts, as a
// UseItem on them does: no one gets a different stack than the one they agreed to.
func TestUseItemTypeOfAnOfferedStack(t *testing.T) {
	h := newMarketHarness(t)
	ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 30, 0))
	cb, b := h.trader("Beto", pos(3, 2), stack(swordID, 1, 0))
	h.startTrade(ca, cb, a, b, salveID, swordID)
	h.send(cb, tradeAccept)
	cb.take()
	evs := h.send(ca, useType(salveID))
	if h.w.CountItem(a, "test_salve") != 29 {
		t.Fatalf("the salve was not used: %d", h.w.CountItem(a, "test_salve"))
	}
	u := lastTrade(evs)
	if u == nil || len(u.GetOwnOffer()) != 0 || u.GetOwnAccepted() || u.GetPartnerAccepted() {
		t.Errorf("the offer after using it: %v", u)
	}
	if u := lastTrade(cb.take()); u == nil || len(u.GetPartnerOffer()) != 0 || u.GetOwnAccepted() {
		t.Errorf("the partner's view: %v", u)
	}
}

// A link-dead character's queued use does nothing: its connection is gone.
func TestUseItemTypeLinkDead(t *testing.T) {
	h := salveHarness(t)
	cl, p := h.joinChar(carryingSalves())
	h.cutSlow(cl)
	h.sim.RunTicks(20)
	h.input(cl, useType(salveID))
	h.sim.Step()
	if stackOf(p.Pockets(), salveID) != 5 {
		t.Errorf("a link-dead character used a salve")
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
	// Empty list: it tells nothing itself, nor on a quiet tick, nor on the next change.
	if evs := h.send(cl, trackTypes()); lastCounts(evs) != nil {
		t.Errorf("an empty list sent counts: %v", lastCounts(evs))
	}
	if evs := h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{}}}); lastCounts(evs) != nil {
		t.Errorf("counts sent on a quiet tick after an empty list")
	}
	h.sim.RunTicks(20)
	if got := lastCounts(h.send(cl, useType(salveID))); len(got) != 0 {
		t.Errorf("counts after stopping: %v", got)
	}
	_ = p
}
