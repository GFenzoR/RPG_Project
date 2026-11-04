package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

const (
	slotBackpack = pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK
	slotRight    = pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND
	slotLeft     = pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND
	slotArmor    = pb.EquipmentSlot_EQUIPMENT_SLOT_ARMOR
	slotHead     = pb.EquipmentSlot_EQUIPMENT_SLOT_HEAD
)

func onTile(p world.Pos) *pb.ItemLocation {
	return &pb.ItemLocation{Location: &pb.ItemLocation_Pos{Pos: &pb.Position{X: uint32(p.X), Y: uint32(p.Y), Z: uint32(p.Z)}}}
}

func inSlot(s pb.EquipmentSlot) *pb.ItemLocation {
	return &pb.ItemLocation{Location: &pb.ItemLocation_Slot{Slot: s}}
}

func inContainer(id, index uint32) *pb.ItemLocation {
	return &pb.ItemLocation{Location: &pb.ItemLocation_Container{Container: &pb.ContainerSlot{ContainerId: id, Index: index}}}
}

func moveItem(from *pb.ItemLocation, item, index uint32, to *pb.ItemLocation, count uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_MoveItem{MoveItem: &pb.MoveItem{
		From: from, ItemId: item, StackIndex: index, To: to, Count: count}}}
}

func useItem(from *pb.ItemLocation, item, index uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_UseItem{UseItem: &pb.UseItem{From: from, ItemId: item, StackIndex: index}}}
}

func lookAt(from *pb.ItemLocation, item, index uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_LookAt{LookAt: &pb.LookAt{From: from, ItemId: item, StackIndex: index}}}
}

func hasKey(evs []*pb.ServerMessage, key string) bool { return systemKeys(evs)[key] > 0 }

// withPack is a character at pos with an empty backpack (4 slots) and the given items in it.
func withPack(id int64, p world.Pos, inPack ...session.ItemState) session.Character {
	return session.Character{ID: id, AccountID: id, Name: "Packer", Vocation: "guardian", Level: 1, Health: 145,
		HasPos: true, Pos: p, Inventory: []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack), Items: inPack}}}
}

// openPack opens the backpack and returns its window id.
func openPack(t *testing.T, h *harness, cl *fakeClient) uint32 {
	t.Helper()
	h.input(cl, useItem(inSlot(slotBackpack), packID, 0))
	h.sim.Step()
	opens := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 || opens[0].GetItemId() != packID || opens[0].GetCapacity() != 4 {
		t.Fatalf("ContainerOpen = %v", opens)
	}
	return opens[0].GetContainerId()
}

// Killing a wolf leaves remains with its coins; the killer opens them, drags the coins
// into the backpack, and the remains are empty while the backpack holds the loot (and
// weighs on the free capacity).
func TestLootCorpse(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{wolfDef()}, spawnAt("wolf", 20, 20, 0, 600))
	cl, p := h.joinChar(withPack(8001, pos(24, 20)))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	h.input(cl, setTarget(wolf.ID()))
	h.sim.RunUntil(func() bool { return len(h.w.Monsters()) == 0 }, sim.MaxSeconds(300))
	var died world.Pos
	var corpse *session.Corpse
	for dx := -2; dx <= 2; dx++ {
		for dy := -2; dy <= 2; dy++ {
			q := world.Pos{X: uint16(int(p.Pos().X) + dx), Y: uint16(int(p.Pos().Y) + dy), Z: 7}
			if c := h.w.CorpsesAt(q); len(c) > 0 {
				died, corpse = q, c[0]
			}
		}
	}
	if corpse == nil || len(corpse.Loot()) != 1 {
		t.Fatalf("no remains with loot next to %v", p.Pos())
	}
	coins := corpse.Loot()[0].GetCount()
	cl.take()

	pack := openPack(t, h, cl)
	h.input(cl, useItem(onTile(died), corpseID, 1)) // ground is index 0
	h.sim.Step()
	opens := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 || opens[0].GetItemId() != corpseID || len(opens[0].GetItems()) != 1 {
		t.Fatalf("remains ContainerOpen = %v", opens)
	}
	remains := opens[0].GetContainerId()
	free := p.Carried()

	h.input(cl, moveItem(inContainer(remains, 0), coinID, 0, inContainer(pack, 0), coins))
	h.sim.Step()
	evs := cl.take()
	if len(corpse.Loot()) != 0 {
		t.Errorf("remains still hold %v", corpse.Loot())
	}
	bp := p.Equipped(slotBackpack)
	if len(bp.Items()) != 1 || bp.Items()[0].Count() != int(coins) || bp.Items()[0].Def().ID != "copper_coin" {
		t.Fatalf("backpack holds %v", bp.Items())
	}
	if p.Carried() != free+int(coins)*12 {
		t.Errorf("carried %d, want %d", p.Carried(), free+int(coins)*12)
	}
	ups := find(evs, (*pb.ServerMessage).GetContainerUpdate)
	if len(ups) != 2 {
		t.Fatalf("ContainerUpdate = %v", ups)
	}
	if st := find(evs, (*pb.ServerMessage).GetPlayerStats); len(st) != 1 || st[0].GetCapacity() != st[0].GetMaxCapacity()-uint32(p.Carried()) {
		t.Errorf("PlayerStats = %v", st)
	}

	// The remains cannot be picked up, and they decay with their window open.
	h.input(cl, moveItem(onTile(died), corpseID, 1, inContainer(pack, 0), 1))
	h.sim.RunTicks(60 * 20)
	evs = cl.take()
	if !hasKey(evs, "inventory.cannot_move") {
		t.Errorf("moving the remains: %v", systemKeys(evs))
	}
	closes := find(evs, (*pb.ServerMessage).GetContainerClose)
	if len(closes) != 1 || closes[0].GetContainerId() != remains || len(h.w.CorpsesAt(died)) != 0 || corpse.Item.Viewers() != 0 {
		t.Errorf("after decay: ContainerClose = %v, remains %d", closes, len(h.w.CorpsesAt(died)))
	}
}

// Equipping a sword picked up from the ground changes the melee attack: the same 40
// rounds against the same dummy deal more damage, and train sword instead of fists.
func TestEquipWeaponChangesDamageAndSkill(t *testing.T) {
	fight := func(sword bool) (dealt int, fist, swordTries int64) {
		h := monsterHarness(t, []*content.Monster{dummyDef()}, spawnAt("dummy", 20, 20, 0, 60))
		cl, p := h.joinChar(withPack(8100, pos(21, 20)))
		cl.take()
		if sword {
			h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["test_sword"], 1, pos(21, 21)) }))
			h.input(cl, moveItem(onTile(pos(21, 21)), swordID, 1, inSlot(slotRight), 1))
			h.sim.Step()
			if it := p.Equipped(slotRight); it == nil || it.Def().ID != "test_sword" {
				t.Fatalf("right hand = %v, messages %v", it, systemKeys(cl.batches[0].Events))
			}
			if len(h.w.GroundAt(pos(21, 21))) != 0 {
				t.Fatal("the sword is still on the ground")
			}
			inv := find(cl.take(), (*pb.ServerMessage).GetInventory)
			if len(inv) != 1 || len(inv[0].GetSlots()) != 2 {
				t.Fatalf("Inventory = %v", inv)
			}
		}
		h.sim.Step()
		m := onlyMonster(t, h)
		h.input(cl, setTarget(m.ID()))
		h.sim.RunTicks(40 * 40)
		return 1_000_000 - h.w.MonsterHealth(m), h.w.Skill(p, "fist").Tries, h.w.Skill(p, "sword").Tries
	}
	fistDmg, fistTries, noSword := fight(false)
	swordDmg, noFist, swordTries := fight(true)
	if fistTries == 0 || noSword != 0 || swordTries == 0 || noFist != 0 {
		t.Errorf("tries: fists %d/%d sword, with sword %d fist/%d sword", fistTries, noSword, noFist, swordTries)
	}
	if swordDmg <= fistDmg*3/2 {
		t.Errorf("40 rounds: fists dealt %d, sword dealt %d", fistDmg, swordDmg)
	}
}

// Capacity is respected: an anvil heavier than the free capacity stays on the ground,
// while moving it from the backpack to the ground or between own containers needs none.
func TestCapacity(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) { c.Items = testItems() })
	cl, p := h.joinChar(withPack(8200, pos(10, 10)))
	h.sim.Command(gameFunc(func() {
		h.w.DropForTest(testItems()["test_anvil"], 1, pos(11, 10))
		h.w.DropForTest(testItems()["copper_coin"], 50, pos(11, 10))
	}))
	pack := openPack(t, h, cl)
	before := p.Carried()
	h.input(cl, moveItem(onTile(pos(11, 10)), anvilID, 1, inContainer(pack, 0), 1))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.too_heavy") || p.Carried() != before {
		t.Fatalf("anvil: %v, carried %d", systemKeys(evs), p.Carried())
	}
	// Coins split: 20 of the 50 go into the backpack.
	h.input(cl, moveItem(onTile(pos(11, 10)), coinID, 2, inContainer(pack, 0), 20))
	h.sim.Step()
	g := h.w.GroundAt(pos(11, 10))
	if len(g) != 2 || g[1].Count() != 30 || p.Carried() != before+240 {
		t.Fatalf("after split: ground %d items, carried %d", len(g), p.Carried())
	}
	// 20 more join the same stack.
	h.input(cl, moveItem(onTile(pos(11, 10)), coinID, 2, inContainer(pack, 0), 20))
	h.sim.Step()
	if bp := p.Equipped(slotBackpack); len(bp.Items()) != 1 || bp.Items()[0].Count() != 40 {
		t.Fatalf("backpack %v", bp.Items())
	}
	// Too far: two tiles away.
	h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["test_tunic"], 1, pos(12, 10)) }))
	h.input(cl, moveItem(onTile(pos(12, 10)), tunicID, 1, inSlot(slotArmor), 1))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.too_far") {
		t.Errorf("far tunic: %v", systemKeys(evs))
	}
	// Stale view: a wrong item id is refused.
	h.input(cl, moveItem(onTile(pos(11, 10)), swordID, 1, inContainer(pack, 0), 1))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.not_possible") {
		t.Errorf("stale: %v", systemKeys(evs))
	}
}

// Slots accept only their kind, within the level and vocation the item requires, and a
// two-handed weapon needs the left hand free.
func TestEquipRules(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) { c.Items = testItems() })
	st := func(i int) session.ItemState {
		ids := []uint16{tunicID, crownID, wandID, shieldID}
		return session.ItemState{ItemID: ids[i], Count: 1, Slot: i}
	}
	cl, p := h.joinChar(withPack(8300, pos(10, 10), st(0), st(1), st(2), st(3)))
	pack := openPack(t, h, cl)
	try := func(index uint32, item uint32, slot pb.EquipmentSlot, want string) {
		t.Helper()
		h.input(cl, moveItem(inContainer(pack, index), item, 0, inSlot(slot), 1))
		h.sim.Step()
		if evs := cl.take(); want != "" && !hasKey(evs, want) || want == "" && len(systemKeys(evs)) > 0 {
			t.Errorf("item %d to slot %v: %v, want %q", item, slot, systemKeys(evs), want)
		}
	}
	try(0, tunicID, slotHead, "inventory.wrong_slot")
	try(1, crownID, slotHead, "inventory.level_required")
	try(2, wandID, slotRight, "inventory.vocation_cannot")
	try(0, tunicID, slotArmor, "")
	if it := p.Equipped(slotArmor); it == nil || it.Def().ID != "test_tunic" {
		t.Fatalf("armor slot %v", it)
	}
	// The shield is now at index 2 (the tunic left index 0).
	try(2, shieldID, slotLeft, "")
	h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["test_greataxe"], 1, pos(10, 10)) }))
	h.input(cl, moveItem(onTile(pos(10, 10)), axeID, 1, inSlot(slotRight), 1))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.hands_full") {
		t.Errorf("two-handed axe with a shield: %v", systemKeys(evs))
	}
	// A container cannot go inside itself.
	h.input(cl, moveItem(inSlot(slotBackpack), packID, 0, inContainer(pack, 0), 1))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.into_itself") {
		t.Errorf("backpack into itself: %v", systemKeys(evs))
	}
}

// A salve heals and is used up; a second use within the cooldown is refused. Looking at
// it answers with its weight.
func TestUseAndLook(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) {
		c.Items = testItems()
		c.Balance.Inventory.UseCooldownMs = 1000
	})
	c := withPack(8400, pos(10, 10), session.ItemState{ItemID: salveID, Count: 2})
	c.Health = 50
	cl, p := h.joinChar(c)
	pack := openPack(t, h, cl)
	h.input(cl, useItem(inContainer(pack, 0), salveID, 0))
	h.input(cl, useItem(inContainer(pack, 0), salveID, 0))
	h.sim.Step()
	evs := cl.take()
	if cur, _ := p.Health(); cur != 90 || !hasKey(evs, "inventory.not_ready") {
		t.Fatalf("health %d, messages %v", cur, systemKeys(evs))
	}
	if heals := find(evs, (*pb.ServerMessage).GetFloatingText); len(heals) != 1 || heals[0].GetKind() != pb.FloatingTextKind_FLOATING_TEXT_KIND_HEAL {
		t.Errorf("FloatingText = %v", heals)
	}
	h.sim.RunTicks(20)
	h.input(cl, useItem(inContainer(pack, 0), salveID, 0))
	h.sim.Step()
	if bp := p.Equipped(slotBackpack); len(bp.Items()) != 0 {
		t.Errorf("salves left %v", bp.Items())
	}
	cl.take()
	h.input(cl, lookAt(inSlot(slotBackpack), packID, 0))
	h.input(cl, lookAt(onTile(pos(10, 10)), worldtest.Grass, 0))
	h.sim.Step()
	msgs := find(cl.take(), (*pb.ServerMessage).GetChatMessage)
	if len(msgs) != 2 || msgs[0].GetLocalized().GetKey() != "look.container" || msgs[1].GetLocalized().GetKey() != "look.ground" {
		t.Fatalf("look = %v", msgs)
	}
	var weight int64
	for _, prm := range msgs[0].GetLocalized().GetParams() {
		if prm.GetName() == "weight" {
			weight = prm.GetNumber()
		}
	}
	if weight != 1650 {
		t.Errorf("backpack weight %d", weight)
	}
}

// The inventory travels in snapshots and comes back on the next login; a character that
// never played starts with balance.yaml inventory.start_container.
func TestInventorySavedAndRestored(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) {
		c.Items = testItems()
		c.Balance.Inventory.StartContainer = "backpack"
	})
	fresh := session.Character{ID: 8500, AccountID: 8500, Name: "Newbie", Vocation: "guardian", Level: 1, Health: 145}
	cl, p := h.joinChar(fresh)
	if it := p.Equipped(slotBackpack); it == nil || it.Def().ID != "backpack" {
		t.Fatalf("new character backpack = %v", it)
	}
	h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["test_bag"], 1, p.Pos()) }))
	h.input(cl, moveItem(onTile(p.Pos()), bagID, 1, inSlot(slotBackpack), 1))
	h.sim.Step()
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	last := h.saves[len(h.saves)-1]
	if len(last.Inventory) != 1 || last.Inventory[0].ItemID != packID || len(last.Inventory[0].Items) != 1 ||
		last.Inventory[0].Items[0].ItemID != bagID {
		t.Fatalf("final snapshot inventory %+v", last.Inventory)
	}
	// Re-login before the database acknowledged: the unsaved snapshot wins (no second
	// starting backpack even though the row says the character never played).
	_, p = h.joinChar(fresh)
	if bp := p.Equipped(slotBackpack); bp == nil || len(bp.Items()) != 1 || bp.Items()[0].Def().ID != "test_bag" {
		t.Fatalf("restored backpack %v", bp)
	}
}

// Windows never outlive what they show: B's window on a bag closes when A carries the
// bag away, logging out forgets the windows, and decaying remains close theirs.
func TestContainerWindowsClose(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{wolfDef()}, spawnAt("wolf", 40, 40, 0, 600))
	clA, _ := h.joinChar(withPack(8600, pos(10, 10)))
	c := withPack(8601, pos(11, 10))
	c.Name = "Other"
	clB, _ := h.joinChar(c)
	h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["test_bag"], 1, pos(10, 11)) }))
	h.sim.Step()
	bag := h.w.GroundAt(pos(10, 11))[0]
	h.input(clB, useItem(onTile(pos(10, 11)), bagID, 1))
	h.sim.Step()
	if bag.Viewers() != 1 {
		t.Fatalf("bag viewers %d", bag.Viewers())
	}
	clB.take()
	h.input(clA, moveItem(onTile(pos(10, 11)), bagID, 1, inSlot(slotBackpack), 1))
	h.sim.Step()
	if closes := find(clB.take(), (*pb.ServerMessage).GetContainerClose); len(closes) != 1 || bag.Viewers() != 0 {
		t.Fatalf("B's window after A took the bag: %v, viewers %d", closes, bag.Viewers())
	}

	// Logout with an open ground container.
	h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["test_bag"], 1, pos(11, 11)) }))
	h.sim.Step()
	bag2 := h.w.GroundAt(pos(11, 11))[0]
	h.input(clB, useItem(onTile(pos(11, 11)), bagID, 1))
	h.sim.Step()
	h.sim.Command(h.w.Leave(clB))
	h.sim.Step()
	if bag2.Viewers() != 0 {
		t.Errorf("viewers after logout %d", bag2.Viewers())
	}

	// Walking out of reach closes the window.
	h.input(clA, useItem(onTile(pos(11, 11)), bagID, 1))
	h.sim.Step()
	clA.take()
	h.input(clA, walkPath(W, W))
	h.sim.RunTicks(60)
	if closes := find(clA.take(), (*pb.ServerMessage).GetContainerClose); len(closes) != 1 || bag2.Viewers() != 0 {
		t.Errorf("after walking away: %v, viewers %d", closes, bag2.Viewers())
	}
}

// A tile holds at most 20 different runtime items; equal stacks merge anywhere on it.
func TestGroundTileLimit(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) { c.Items = testItems() })
	cl, _ := h.joinChar(withPack(8700, pos(10, 10), session.ItemState{ItemID: coinID, Count: 5}))
	h.sim.Command(gameFunc(func() {
		h.w.DropForTest(testItems()["copper_coin"], 1, pos(10, 11))
		for range 19 {
			h.w.DropForTest(testItems()["test_tunic"], 1, pos(10, 11))
		}
		h.w.DropForTest(testItems()["test_sword"], 1, pos(11, 10))
	}))
	pack := openPack(t, h, cl)
	h.input(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(pos(10, 11)), 2))
	h.input(cl, moveItem(onTile(pos(11, 10)), swordID, 1, onTile(pos(10, 11)), 1))
	h.sim.Step()
	g := h.w.GroundAt(pos(10, 11))
	if len(g) != 20 || g[0].Count() != 3 {
		t.Fatalf("tile holds %d items, coins %d, messages %v", len(g), g[0].Count(), systemKeys(cl.take()))
	}
	if evs := cl.take(); !hasKey(evs, "inventory.tile_full") {
		t.Errorf("messages %v", systemKeys(evs))
	}
}
