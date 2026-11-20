package session_test

import (
	"slices"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Pockets (docs/02 "Bolsillos"): every character has inventory.pocket_slots built-in
// cells, part of the character, never an item; what it receives goes to the backpack
// first and then to the pockets; what they hold falls with the backpack at a death. Every
// test of the package reconciles the economy ledger each tick (newHarness), so each of
// these checks that the pockets' items are booked too.

// pocket is a saved item in a cell of the pockets (withPack puts it there).
func pocket(id uint16, n, cell int) session.ItemState {
	return session.ItemState{ItemID: id, Count: n, Slot: cell, Pocket: true}
}

// pebbles fills every pocket cell with a pebble (test_pebble: 10 g, no stack), for the
// tests whose point is a character with no room left.
func pebbles() []session.ItemState {
	out := make([]session.ItemState, pocketSlots)
	for i := range out {
		out[i] = pocket(pebbleID, 1, i)
	}
	return out
}

// full is items and then full pockets (pebbles), for withPack and the helpers on it.
func full(items ...session.ItemState) []session.ItemState { return append(items, pebbles()...) }

func inPocket(cell uint32) *pb.ItemLocation {
	return &pb.ItemLocation{Location: &pb.ItemLocation_Pocket{Pocket: cell}}
}

// pocketIDs lists what p's pockets hold, cell by cell (with the count of a stack).
func pocketIDs(p *session.Player) []string {
	var out []string
	for _, it := range p.Pockets().Items() {
		id := it.Def().ID
		if it.Def().Stackable {
			id += "x" + itoa(it.Count())
		}
		out = append(out, id)
	}
	return out
}

// lastInventory is the last Inventory of evs (nil without one).
func lastInventory(evs []*pb.ServerMessage) *pb.Inventory {
	inv := find(evs, (*pb.ServerMessage).GetInventory)
	if len(inv) == 0 {
		return nil
	}
	return inv[len(inv)-1]
}

// pocketHarness is an open 16x16 map with the test items, the copper coin a currency of
// worth 1 (money counts it).
func pocketHarness(t *testing.T, opts ...option) *harness {
	t.Helper()
	return newHarness(t, worldtest.Open(t, 0, 0, 16, 16), append([]option{func(c *session.Config) {
		c.Items = chestItems(t, testChest)
	}}, opts...)...)
}

// bare joins a character at p with no backpack, holding pocketed in its pockets.
func (h *harness) bare(name string, p world.Pos, pocketed ...session.ItemState) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	cl, pl := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: name, Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: p, InventoryLoaded: true, Inventory: pocketed})
	return cl, pl
}

// A character without a backpack has its pockets: the Inventory says how many cells and
// what they hold, items go in and out of them like a container it carries (weight
// included), they are used and looked at where they are, and a cell holding a bag takes
// what is dropped onto it into the bag. Nothing addresses the pockets themselves.
func TestPocketsHoldWhatTheCharacterCarries(t *testing.T) {
	h := pocketHarness(t)
	cl, p := h.bare("Bare", pos(5, 5))
	inv := lastInventory(cl.take())
	if inv == nil || inv.GetPocketSlots() != pocketSlots || len(inv.GetPockets()) != 0 || len(inv.GetSlots()) != 0 {
		t.Fatalf("Inventory at login = %v", inv)
	}
	h.sim.Command(gameFunc(func() {
		h.w.DropForTest(h.w.ItemForTest("copper_coin"), 30, pos(6, 5))
		h.w.DropForTest(h.w.ItemForTest("test_salve"), 2, pos(5, 6))
		h.w.DropForTest(h.w.ItemForTest("test_bag"), 1, pos(4, 5))
	}))
	h.sim.Step()
	cl.take()
	free := p.Carried()

	evs := h.send(cl, moveItem(onTile(pos(6, 5)), coinID, 1, inPocket(0), 30))
	if got := pocketIDs(p); !slices.Equal(got, []string{"copper_coinx30"}) {
		t.Fatalf("pockets after taking the coins: %v (%v)", got, systemKeys(evs))
	}
	if inv := lastInventory(evs); inv == nil || len(inv.GetPockets()) != 1 || inv.GetPockets()[0].GetCount() != 30 {
		t.Fatalf("Inventory after the move = %v", inv)
	}
	if p.Carried() != free+30*12 || h.w.Money(p) != 30 || h.w.CountItemForTest(p, "copper_coin") != 30 {
		t.Fatalf("carried %d (from %d), money %d", p.Carried(), free, h.w.Money(p))
	}
	if st := find(evs, (*pb.ServerMessage).GetPlayerStats); len(st) != 1 || st[0].GetCapacity() != st[0].GetMaxCapacity()-uint32(p.Carried()) {
		t.Errorf("PlayerStats = %v", st)
	}
	// Onto any cell: a stack joins the stack of the same item, anything else takes a cell.
	h.send(cl, moveItem(onTile(pos(5, 6)), salveID, 1, inPocket(3), 2))
	h.send(cl, moveItem(onTile(pos(4, 5)), bagID, 1, inPocket(1), 1))
	if got := pocketIDs(p); !slices.Equal(got, []string{"copper_coinx30", "test_salvex2", "test_bag"}) {
		t.Fatalf("pockets = %v", got)
	}
	// A cell holding a bag takes what is dropped onto it into the bag.
	h.send(cl, moveItem(inPocket(0), coinID, 0, inPocket(2), 10))
	if bag := p.Pockets().Items()[2]; len(bag.Items()) != 1 || bag.Items()[0].Count() != 10 || h.w.Money(p) != 30 {
		t.Fatalf("bag holds %v, money %d", bag.Items(), h.w.Money(p))
	}
	// Used and looked at where they lie.
	h.sim.Command(gameFunc(func() { h.w.SetPlayerHealthForTest(p, 50) }))
	h.sim.Step()
	cl.take()
	h.send(cl, useItem(inPocket(1), salveID, 0))
	if hp, _ := p.Health(); hp != 90 || pocketIDs(p)[1] != "test_salvex1" {
		t.Fatalf("after a salve from the pockets: health %d, pockets %v", hp, pocketIDs(p))
	}
	if !hasKey(h.send(cl, lookAt(inPocket(1), salveID, 0)), "look.item") {
		t.Error("looking at a pocket's item")
	}
	// A cell that holds nothing, or another item, is nothing.
	for _, loc := range []*pb.ItemLocation{inPocket(3), inPocket(9), inPocket(1)} {
		if !hasKey(h.send(cl, moveItem(loc, coinID, 0, onTile(pos(6, 5)), 1)), "inventory.not_possible") {
			t.Errorf("moving a coin from %v", loc)
		}
	}
	// Too heavy for the capacity left: nothing moves.
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("test_anvil"), 1, pos(6, 6)) }))
	h.sim.Step()
	cl.take()
	if !hasKey(h.send(cl, moveItem(onTile(pos(6, 6)), anvilID, 1, inPocket(3), 1)), "inventory.too_heavy") || len(p.Pockets().Items()) != 3 {
		t.Errorf("an anvil in the pockets: %v", pocketIDs(p))
	}
	// Dropped on the ground again, they leave the pockets.
	h.send(cl, moveItem(inPocket(0), coinID, 0, onTile(pos(6, 5)), 20))
	if got := pocketIDs(p); !slices.Equal(got, []string{"test_salvex1", "test_bag"}) || h.w.Money(p) != 10 {
		t.Fatalf("after dropping the coins: %v, money %d", got, h.w.Money(p))
	}
}

// The pockets are saved with the character (Pocket, the cell as Slot), apart from the
// equipment, and a login gives them back in the same cells.
func TestPocketsAreSaved(t *testing.T) {
	h := pocketHarness(t)
	nextChar++
	c := withPack(nextChar, pos(5, 5), stack(salveID, 3, 0), pocket(coinID, 40, 0), pocket(swordID, 1, 1))
	c.InventoryLoaded = true
	cl, p := h.joinChar(c)
	if got := pocketIDs(p); !slices.Equal(got, []string{"copper_coinx40", "test_sword"}) || h.w.Money(p) != 40 {
		t.Fatalf("pockets at login = %v", got)
	}
	if inv := lastInventory(cl.take()); len(inv.GetPockets()) != 2 || inv.GetPockets()[1].GetItemId() != swordID || len(inv.GetSlots()) != 1 {
		t.Fatalf("Inventory = %v", inv)
	}
	h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	h.sim.Step()
	last := h.saves[len(h.saves)-1]
	var pockets []session.ItemState
	for _, s := range last.Inventory {
		if s.Pocket {
			pockets = append(pockets, s)
		} else if s.Slot != int(slotBackpack) || len(s.Items) != 1 {
			t.Errorf("equipment saved as %+v", s)
		}
	}
	if len(pockets) != 2 || pockets[0].ItemID != coinID || pockets[0].Count != 40 || pockets[0].Slot != 0 ||
		pockets[1].ItemID != swordID || pockets[1].Slot != 1 {
		t.Fatalf("pockets saved as %+v", pockets)
	}
	nextChar++
	again := last
	_, q := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Again", Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: pos(6, 6), InventoryLoaded: true, Inventory: again.Inventory})
	if got := pocketIDs(q); !slices.Equal(got, []string{"copper_coinx40", "test_sword"}) || q.Equipped(slotBackpack) == nil {
		t.Fatalf("pockets loaded = %v", got)
	}
}

// A pickup goes to the backpack first and then to the pockets: onto the backpack slot or
// into the backpack's window when it is full, or onto the empty backpack slot without one.
// Only when the pockets are full too is there no room. A backpack dropped onto the empty
// slot is still worn, and a move from the pockets into a full backpack stays put.
func TestPickUpGoesToThePocketsWhenTheBackpackIsFull(t *testing.T) {
	h := pocketHarness(t)
	fullBag := stack(bagID, 1, 3)
	fullBag.Items = []session.ItemState{stack(pebbleID, 1, 0), stack(pebbleID, 1, 1)}
	cl, p := h.joinChar(withPack(1101, pos(5, 5), stack(swordID, 1, 0), stack(shieldID, 1, 1), stack(tunicID, 1, 2), fullBag))
	pack := openPack(t, h, cl)
	h.sim.Command(gameFunc(func() {
		h.w.DropForTest(h.w.ItemForTest("copper_coin"), 10, pos(6, 5))
		h.w.DropForTest(h.w.ItemForTest("test_salve"), 1, pos(5, 6))
	}))
	h.sim.Step()
	cl.take()
	h.send(cl, moveItem(onTile(pos(6, 5)), coinID, 1, inSlot(slotBackpack), 10))
	h.send(cl, moveItem(onTile(pos(5, 6)), salveID, 1, inContainer(pack, 0), 1))
	if got := pocketIDs(p); !slices.Equal(got, []string{"copper_coinx10", "test_salvex1"}) || len(p.Equipped(slotBackpack).Items()) != 4 {
		t.Fatalf("pockets after two pickups with a full backpack: %v", got)
	}
	// Back into the full backpack: it stays in the pockets.
	if !hasKey(h.send(cl, moveItem(inPocket(1), salveID, 0, inContainer(pack, 0), 1)), "inventory.container_full") ||
		len(pocketIDs(p)) != 2 {
		t.Fatalf("a move from the pockets into a full backpack: %v", pocketIDs(p))
	}
	// Into a full bag lying in the backpack it never spills, though the pockets have room:
	// that bag was chosen.
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("test_sword"), 1, pos(6, 5)) }))
	h.sim.Step()
	cl.take()
	if !hasKey(h.send(cl, moveItem(onTile(pos(6, 5)), swordID, 1, inContainer(pack, 3), 1)), "inventory.container_full") ||
		len(h.w.GroundAt(pos(6, 5))) != 1 || len(pocketIDs(p)) != 2 {
		t.Fatalf("a pickup into a full bag in the backpack: pockets %v", pocketIDs(p))
	}
	// With the pockets full too, there is no room at all.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "test_pebble", 2) })) // the pockets are full now
	h.sim.Step()
	cl.take()
	if !hasKey(h.send(cl, moveItem(onTile(pos(6, 5)), swordID, 1, inSlot(slotBackpack), 1)), "inventory.container_full") ||
		len(h.w.GroundAt(pos(6, 5))) != 1 {
		t.Fatal("a pickup with a full backpack and full pockets")
	}

	// Without a backpack: onto its slot goes to the pockets, a backpack is worn.
	h2 := pocketHarness(t)
	cb, b := h2.bare("Bare", pos(5, 5))
	h2.sim.Command(gameFunc(func() {
		h2.w.DropForTest(h2.w.ItemForTest("copper_coin"), 10, pos(6, 5))
		h2.w.DropForTest(h2.w.ItemForTest("backpack"), 1, pos(5, 6))
	}))
	h2.sim.Step()
	cb.take()
	if evs := h2.send(cb, moveItem(onTile(pos(6, 5)), coinID, 1, inSlot(slotBackpack), 10)); len(systemKeys(evs)) != 0 ||
		!slices.Equal(pocketIDs(b), []string{"copper_coinx10"}) {
		t.Fatalf("coins onto the empty backpack slot: %v, pockets %v", systemKeys(evs), pocketIDs(b))
	}
	h2.send(cb, moveItem(onTile(pos(5, 6)), packID, 1, inSlot(slotBackpack), 1))
	if bp := b.Equipped(slotBackpack); bp == nil || bp.Def().ID != "backpack" || len(pocketIDs(b)) != 1 {
		t.Fatalf("a backpack onto its slot: worn %v, pockets %v", bp, pocketIDs(b))
	}
	// From the pockets onto the backpack slot: into the backpack.
	h2.send(cb, moveItem(inPocket(0), coinID, 0, inSlot(slotBackpack), 10))
	if len(pocketIDs(b)) != 0 || len(b.Equipped(slotBackpack).Items()) != 1 || h2.w.Money(b) != 10 {
		t.Fatalf("coins from the pockets into the new backpack: pockets %v", pocketIDs(b))
	}
}

// A container worn in another slot (a hood that holds things, worn on the head) dropped
// onto the empty backpack slot goes to the pockets with the nesting rule of any container
// move: never deeper than the deepest nest a character may carry.
func TestPocketsKeepTheNestingLimit(t *testing.T) {
	const hoodID = 230
	h := pocketHarness(t, func(c *session.Config) {
		var it content.Item
		if err := yaml.Unmarshal([]byte("{id: test_hood, kind: container, weight: 200, armor: {slot: head}, container: {slots: 1}}"),
			&it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = hoodID
		c.Items[it.ID] = &it
	})
	// hood holds bags nested levels deep (the hood's height).
	hood := func(levels int) session.ItemState {
		nest := session.ItemState{ItemID: bagID, Count: 1}
		for range levels - 1 {
			nest = session.ItemState{ItemID: bagID, Count: 1, Items: []session.ItemState{nest}}
		}
		return session.ItemState{ItemID: hoodID, Count: 1, Slot: int(slotHead), Items: []session.ItemState{nest}}
	}
	for _, tc := range []struct {
		levels int
		key    string
	}{{7, "inventory.too_deep"}, {6, ""}} {
		cl, p := h.bare("Hooded", pos(5, 5), hood(tc.levels))
		cl.take()
		evs := h.send(cl, moveItem(inSlot(slotHead), hoodID, 0, inSlot(slotBackpack), 1))
		if tc.key != "" {
			if !hasKey(evs, tc.key) || len(p.Pockets().Items()) != 0 || p.Equipped(slotHead) == nil {
				t.Fatalf("a hood %d levels deep into the pockets: %v, pockets %v", tc.levels, systemKeys(evs), pocketIDs(p))
			}
			continue
		}
		if len(systemKeys(evs)) != 0 || !slices.Equal(pocketIDs(p), []string{"test_hood"}) || p.Equipped(slotHead) != nil {
			t.Fatalf("a hood %d levels deep into the pockets: %v, pockets %v", tc.levels, systemKeys(evs), pocketIDs(p))
		}
	}
}

// What a character receives (giveItem: a GM, a quest, a dialog, gathering...) goes to
// the backpack first, then to the pockets, then to the floor; without a backpack, to the
// pockets.
func TestGiveFillsTheBackpackThenThePockets(t *testing.T) {
	h := pocketHarness(t)
	cl, p := h.joinChar(withPack(1102, pos(5, 5), stack(swordID, 1, 0), stack(shieldID, 1, 1), stack(coinID, 95, 2)))
	cl.take()
	h.sim.Command(gameFunc(func() {
		h.w.GiveForTest(p, "copper_coin", 10) // 5 onto the stack, 5 to the free slot
		h.w.GiveForTest(p, "test_salve", 3)   // the backpack is full: the pockets
		h.w.GiveForTest(p, "copper_coin", 98) // onto the 5, then a stack in the pockets
		h.w.GiveForTest(p, "test_pebble", 4)  // two cells left: two fall
	}))
	h.sim.Step()
	if got := pocketIDs(p); !slices.Equal(got, []string{"test_salvex3", "copper_coinx3", "test_pebble", "test_pebble"}) {
		t.Fatalf("pockets = %v", got)
	}
	if h.w.Money(p) != 95+10+98 || len(h.w.GroundAt(pos(5, 5))) != 2 {
		t.Fatalf("money %d, on the floor %v", h.w.Money(p), h.w.GroundAt(pos(5, 5)))
	}
	if !hasKey(cl.take(), "dialog.item_on_floor") {
		t.Error("not told what fell")
	}
}

// Payments read both: the coins of the backpack go first, a coin in the pockets pays and
// is broken for change, and a character with only its pockets buys, and gets the change
// and what it bought there. Room for the change counts the pockets too.
func TestPayWithCoinsInThePocketsAndTheBackpack(t *testing.T) {
	h := newMarketHarness(t, withSilver(t))
	cs, s := h.atBoard("Sela", pos(1, 0), stack(salveID, 30, 0), stack(coinID, 50, 1))
	h.send(cs, createOffer(sell, salveID, 10, 20))
	id := h.w.MarketOffers(s.CharacterID())[0]

	h.sim.Command(gameFunc(func() { h.w.Teleport(s, pos(5, 3)) })) // Sela leaves the board
	h.sim.Step()

	// 30 copper in the backpack and 40 in the pockets: a salve for 20 takes the backpack's.
	cc, c := h.atBoard("Cora", pos(1, 0), stack(coinID, 30, 0), pocket(coinID, 40, 0))
	if evs := h.send(cc, acceptOffer(id, 1)); !hasKey(evs, "market.bought") || h.w.Money(c) != 50 ||
		c.Equipped(slotBackpack).Items()[0].Count() != 10 || !slices.Equal(pocketIDs(c), []string{"copper_coinx40"}) {
		t.Fatalf("bought: %v, money %d, pockets %v", systemKeys(evs), h.w.Money(c), pocketIDs(c))
	}

	// 30 copper in the backpack, 40 copper and a silver coin in the pockets: 4 salves for 80
	// break the silver (the largest coin goes first) for 20 copper back.
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 30, 0), pocket(coinID, 40, 0), pocket(silverID, 1, 1))
	if h.w.Money(b) != 170 {
		t.Fatalf("money %d, want 170", h.w.Money(b))
	}
	if evs := h.send(cb, acceptOffer(id, 4)); !hasKey(evs, "market.bought") || h.w.Money(b) != 90 ||
		h.w.CountItem(b, "test_salve") != 4 || h.w.CountItem(b, "silver_coin") != 0 || h.w.CountItem(b, "copper_coin") != 90 {
		t.Fatalf("bought: %v, money %d, salves %d", systemKeys(evs), h.w.Money(b), h.w.CountItem(b, "test_salve"))
	}

	// Only pockets: the copper pays, the salves and nothing else land in a free cell.
	nextChar++
	cn, n := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Nopack", Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: pos(1, 1), InventoryLoaded: true, Inventory: []session.ItemState{pocket(coinID, 50, 0)}})
	if u := lastMarket(h.send(cn, useBoard())); !u.GetOpen() || u.GetMoney() != 50 {
		t.Fatalf("market for a character with only pockets: %v", u)
	}
	if evs := h.send(cn, acceptOffer(id, 2)); !hasKey(evs, "market.bought") || h.w.Money(n) != 10 ||
		!slices.Equal(pocketIDs(n), []string{"copper_coinx10", "test_salvex2"}) {
		t.Fatalf("bought with only pockets: %v, pockets %v", systemKeys(evs), pocketIDs(n))
	}
}

// Novice protection, blessings and the corpse (docs/02 "Muerte" and "Bolsillos"): what the
// pockets hold falls with the backpack, on its roll, also without a backpack; the pockets
// stay, nothing new is given (no backpack: the rule of the playtest of lote 9 is gone)
// and the ledger stays even.
func TestDeathDropsThePocketsWithTheBackpack(t *testing.T) {
	pocketed := func(h *harness, name string, level, blessings int, pack bool) (*fakeClient, *session.Player) {
		h.t.Helper()
		nextChar++
		storage := map[string]int64{}
		for i := range blessings {
			storage["bless.b"+itoa(i)] = 1
		}
		inv := []session.ItemState{
			{ItemID: swordID, Count: 1, Slot: int(slotRight)},
			pocket(coinID, 25, 0), pocket(salveID, 2, 1),
		}
		if pack {
			inv = append(inv, session.ItemState{ItemID: packID, Count: 1, Slot: int(slotBackpack),
				Items: []session.ItemState{{ItemID: coinID, Count: 50}}})
		}
		e := testBalance().Experience
		return h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: name, Vocation: "guardian",
			Level: level, Experience: e.TotalFor(level) + 100, Health: 1, Pos: pos(40, 40), HasPos: true,
			Storage: storage, InventoryLoaded: true, Inventory: inv})
	}
	t.Run("no blessings", func(t *testing.T) {
		h := deathHarness(t, func(c *session.Config) { c.Balance.Inventory.StartContainer = "backpack" })
		cl, p := pocketed(h, "Bare", 20, 0, true)
		cl.take()
		h.kill(p)
		if p.Equipped(slotBackpack) != nil || p.Pockets() == nil || len(p.Pockets().Items()) != 0 {
			t.Fatalf("after the death: backpack %v, pockets %v", p.Equipped(slotBackpack), pocketIDs(p))
		}
		if got := corpseItems(h); !slices.Equal(got, []string{"backpack", "copper_coin", "test_salve"}) && !slices.Equal(got, []string{"test_sword", "backpack", "copper_coin", "test_salve"}) {
			t.Fatalf("corpse holds %v", got)
		}
		if h.w.Money(p) != 0 {
			t.Errorf("money after the death %d", h.w.Money(p))
		}
		inv := lastInventory(cl.take())
		if inv == nil || inv.GetPocketSlots() != pocketSlots || len(inv.GetPockets()) != 0 {
			t.Fatalf("Inventory after the death = %v", inv)
		}
		for _, e := range h.entries(session.EconDeath) {
			if e.Count > 0 || e.Ref != "" {
				t.Errorf("a death gave something: %+v", e)
			}
		}
		h.checkInvariants()
	})
	t.Run("no backpack", func(t *testing.T) {
		h := deathHarness(t)
		_, p := pocketed(h, "Packless", 20, 0, false)
		h.kill(p)
		if len(p.Pockets().Items()) != 0 || p.Equipped(slotBackpack) != nil {
			t.Fatalf("after the death: pockets %v", pocketIDs(p))
		}
		got := corpseItems(h)
		if !slices.Contains(got, "copper_coin") || !slices.Contains(got, "test_salve") {
			t.Fatalf("the pockets did not fall: corpse %v", got)
		}
	})
	for _, tc := range []struct {
		name      string
		level     int
		blessings int
	}{{"every blessing", 20, 5}, {"novice", 5, 0}} {
		t.Run(tc.name, func(t *testing.T) {
			h := deathHarness(t)
			_, p := pocketed(h, "Kept", tc.level, tc.blessings, true)
			h.kill(p)
			if got := pocketIDs(p); !slices.Equal(got, []string{"copper_coinx25", "test_salvex2"}) || p.Equipped(slotBackpack) == nil {
				t.Fatalf("pockets %v, backpack %v", got, p.Equipped(slotBackpack))
			}
			if got := corpseItems(h); len(got) != 0 {
				t.Fatalf("dropped %v", got)
			}
		})
	}
}

// The corpse holds everything a death drops: an outlaw loses it all, a piece in each of
// the ten equipment slots and the four pockets, where the monsters' remains have 10
// places (more pockets after a balance lowered pocket_slots, and fewer places, too).
// Nothing falls loose at the death's tile, where the corpse's owner-only time would not
// cover it.
func TestDeathCorpseHoldsEverything(t *testing.T) {
	for _, tc := range []struct {
		name             string
		places, pocketed int
	}{
		{"ten places", 10, pocketSlots},
		{"three places, pockets past pocket_slots", 3, pocketSlots + 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := deathHarness(t, func(c *session.Config) {
				c.Balance.Death.EquipmentDropPct, c.Balance.Death.BackpackDropPct = 100, 100
				c.Items["creature_remains"].Container.Slots = tc.places
			})
			inv := []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack)}}
			for slot := 1; slot <= int(slotAmmo); slot++ {
				if slot != int(slotBackpack) {
					inv = append(inv, session.ItemState{ItemID: pebbleID, Count: 1, Slot: slot})
				}
			}
			for i := range tc.pocketed {
				inv = append(inv, pocket(salveID, 1, i))
			}
			nextChar++
			_, p := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Spill", Vocation: "guardian",
				Level: 20, Experience: testBalance().Experience.TotalFor(20), Health: 1, Pos: pos(40, 40), HasPos: true,
				InventoryLoaded: true, Inventory: inv})
			if len(p.Pockets().Items()) != tc.pocketed {
				t.Fatalf("pockets before the death %v", pocketIDs(p))
			}
			h.kill(p)
			if got := corpseItems(h); len(got) != 10+tc.pocketed {
				t.Fatalf("corpse holds %d items: %v", len(got), got)
			}
			if ground := h.w.GroundAt(pos(40, 40)); len(ground) != 1 || len(h.w.CorpsesAt(pos(40, 40))) != 1 {
				t.Fatalf("loose at the death's tile: %v", ground)
			}
			if len(p.Pockets().Items()) != 0 || p.Equipped(slotBackpack) != nil {
				t.Fatalf("after the death: pockets %v", pocketIDs(p))
			}
		})
	}
}

// The trade reads the pockets: an item is offered from a cell, and a partner with no
// backpack takes what it gets into its pockets (tradeFits counts them).
func TestTradeFromAndIntoThePockets(t *testing.T) {
	h := newMarketHarness(t)
	ca, a := h.trader("Ana", pos(2, 2), stack(coinID, 5, 0), pocket(salveID, 3, 0))
	nextChar++
	cn, n := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Nopack", Vocation: "guardian",
		Level: 1, Health: 145, HasPos: true, Pos: pos(3, 2), InventoryLoaded: true,
		Inventory: []session.ItemState{pocket(swordID, 1, 0), pocket(pebbleID, 1, 1)}})
	cn.take()
	if u := lastTrade(h.send(ca, tradeReq(n.ID(), inPocket(0), salveID))); u.GetState() != pb.TradeState_TRADE_STATE_REQUESTED {
		t.Fatalf("a trade offering a pocket's salves: %v", u)
	}
	if u := lastTrade(h.send(cn, tradeReq(a.ID(), inPocket(0), swordID))); len(u.GetOwnOffer()) != 1 || len(u.GetPartnerOffer()) != 1 {
		t.Fatalf("negotiating: %v", u)
	}
	h.send(ca, tradeAccept)
	if u := lastTrade(h.send(cn, tradeAccept)); u.GetState() != pb.TradeState_TRADE_STATE_COMPLETED {
		t.Fatalf("trade: %v", u)
	}
	if got := pocketIDs(n); !slices.Equal(got, []string{"test_pebble", "test_salvex3"}) {
		t.Fatalf("Nopack's pockets: %v", got)
	}
	if h.w.CountItem(a, "test_sword") != 1 || len(a.Pockets().Items()) != 0 || len(a.Equipped(slotBackpack).Items()) != 2 {
		t.Fatalf("Ana: sword %d, pockets %v", h.w.CountItem(a, "test_sword"), pocketIDs(a))
	}
}

// Pockets that hold more than pocket_slots (a balance that lowered it) have no room for
// a trade: what is given away from them frees no cell, so nothing goes in past the limit.
func TestTradeIntoPocketsPastTheirSlots(t *testing.T) {
	h := newMarketHarness(t)
	ca, a := h.trader("Ana", pos(2, 2), stack(salveID, 3, 0))
	inv := []session.ItemState{pocket(swordID, 1, 0)}
	for i := 1; i < pocketSlots+2; i++ {
		inv = append(inv, pocket(pebbleID, 1, i))
	}
	nextChar++
	cn, n := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Overfull", Vocation: "guardian",
		Level: 1, Health: 145, HasPos: true, Pos: pos(3, 2), InventoryLoaded: true, Inventory: inv})
	cn.take()
	h.send(ca, tradeReq(n.ID(), inContainer(openPack(t, h.harness, ca), 0), salveID))
	h.send(cn, tradeReq(a.ID(), inPocket(0), swordID))
	h.send(ca, tradeAccept)
	u := lastTrade(h.send(cn, tradeAccept))
	if u.GetState() != pb.TradeState_TRADE_STATE_CANCELLED || u.GetReason() != "trade.cancel.no_room" {
		t.Fatalf("a trade into pockets past their slots: %v", u)
	}
	if len(n.Pockets().Items()) != pocketSlots+2 || h.w.CountItem(n, "test_sword") != 1 || h.w.CountItem(a, "test_salve") != 3 {
		t.Fatalf("after the trade: Overfull's pockets %v", pocketIDs(n))
	}
}

// The market reads the pockets: units in them are sold (and counted for the offer), and
// a character with only its pockets gets its mailbox there.
func TestMarketSellsFromThePockets(t *testing.T) {
	h := newMarketHarness(t)
	cs, s := h.atBoard("Sela", pos(1, 0), stack(coinID, 50, 0), pocket(salveID, 6, 0))
	if evs := h.send(cs, createOffer(sell, salveID, 4, 10)); !hasKey(evs, "market.created") ||
		!slices.Equal(pocketIDs(s), []string{"test_salvex2"}) {
		t.Fatalf("a sell offer of a pocket's salves: %v, pockets %v", systemKeys(evs), pocketIDs(s))
	}
	h.sim.Command(gameFunc(func() { h.w.MailGoldForTest(s.CharacterID(), 30) }))
	h.sim.Step()
	nextChar++
	cn, n := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Nopack", Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: pos(0, 1), InventoryLoaded: true})
	h.sim.Command(gameFunc(func() { h.w.MailGoldForTest(n.CharacterID(), 30) }))
	h.sim.Step()
	h.send(cn, useBoard())
	if evs := h.send(cn, withdraw); !hasKey(evs, "market.withdrawn") || h.w.Money(n) != 30 ||
		!slices.Equal(pocketIDs(n), []string{"copper_coinx30"}) {
		t.Fatalf("a withdraw into the pockets: %v, pockets %v", systemKeys(evs), pocketIDs(n))
	}
}

// Crafting takes its ingredients from the pockets too, and its result lands there when
// the backpack is full.
func TestCraftWithThePockets(t *testing.T) {
	h := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...))
	cl, p := crafter(h, pos(1, 0), stack(swordID, 1, 0), stack(shieldID, 1, 1), stack(tunicID, 1, 2), stack(bagID, 1, 3),
		pocket(oreID, 2, 0), pocket(logID, 1, 1))
	evs := h.craft(cl, "ingot", pos(0, 0))
	switch {
	case hasKey(evs, "craft.done"):
		if got := pocketIDs(p); len(got) != 1 || !slices.Contains([]string{"iron_ingot", "iron_ingotx1"}, got[0]) {
			t.Fatalf("pockets after the craft: %v", got)
		}
	case hasKey(evs, "craft.failed"):
		if len(p.Pockets().Items()) != 0 {
			t.Fatalf("pockets after a failed craft: %v", pocketIDs(p))
		}
	default:
		t.Fatalf("craft with the ingredients in the pockets: %v", systemKeys(evs))
	}
}

// A chest gives its rewards into the pockets of a character without a backpack, all or
// nothing (roomForAll counts the cells).
func TestChestRewardsIntoThePockets(t *testing.T) {
	h := chestHarness(t)
	nextChar++
	cl, p := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Nopack", Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: pos(1, 0), InventoryLoaded: true,
		Inventory: []session.ItemState{pocket(pebbleID, 1, 0), pocket(pebbleID, 1, 1)}})
	cl.take()
	if evs := h.send(cl, useChest); !hasKey(evs, "chest.no_room") || len(p.Pockets().Items()) != 2 {
		t.Fatalf("three rewards and two free cells: %v", systemKeys(evs))
	}
	h.sim.Command(gameFunc(func() { h.w.TakeForTest(p, "test_pebble", 1) }))
	h.sim.Step()
	cl.take()
	if evs := h.send(cl, useChest); !hasKey(evs, "chest.found") ||
		!slices.Equal(pocketIDs(p), []string{"test_pebble", "copper_coinx50", "test_salvex3", "test_tunic"}) {
		t.Fatalf("the rewards: %v, pockets %v", systemKeys(evs), pocketIDs(p))
	}
}

// A dialog's has_item and take_item, and a quest's item check, count the pockets.
func TestItemChecksCountThePockets(t *testing.T) {
	h := pocketHarness(t)
	_, p := h.joinChar(withPack(1103, pos(5, 5), stack(salveID, 2, 0), pocket(salveID, 3, 0)))
	var n, taken int
	h.sim.Command(gameFunc(func() {
		n = h.w.CountItemForTest(p, "test_salve")
		taken = h.w.TakeItemForTest(p, "test_salve", 4)
	}))
	h.sim.Step()
	if n != 5 || taken != 1 || h.w.CountItem(p, "test_salve") != 1 || !slices.Equal(pocketIDs(p), []string{"test_salvex1"}) {
		t.Fatalf("counted %d, took %d instances, pockets %v", n, taken, pocketIDs(p))
	}
}

// A key in the pockets opens its door like one in the backpack.
func TestKeyInThePocketsOpensItsDoor(t *testing.T) {
	h := newHarness(t, doorMap(t), func(c *session.Config) { c.Items = doorTestItems(true) })
	nextChar++
	cl, _ := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Keyed", Vocation: "guardian", Level: 1,
		Health: 145, HasPos: true, Pos: pos(5, 2), InventoryLoaded: true, Inventory: []session.ItemState{pocket(gateKeyID, 1, 0)}})
	cl.take()
	if evs := h.send(cl, useGate(worldtest.Door)); !hasKey(evs, "door.unlocked") || !h.w.Walkable(gate) {
		t.Fatalf("a key in the pockets: %v", systemKeys(evs))
	}
}

// The death of a character whose pockets fell is saved at once, without them.
func TestDeathSavesThePocketsEmpty(t *testing.T) {
	h := deathHarness(t)
	nextChar++
	_, p := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Saved", Vocation: "guardian", Level: 20,
		Experience: testBalance().Experience.TotalFor(20), Health: 1, Pos: pos(40, 40), HasPos: true, InventoryLoaded: true,
		Inventory: []session.ItemState{pocket(coinID, 25, 0)}})
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) { h.w.DieForTest(ctx, p) }))
	h.sim.Step()
	last := h.saves[len(h.saves)-1]
	if len(last.Inventory) != 0 || !slices.Equal(corpseItems(h), []string{"copper_coin"}) {
		t.Fatalf("death saved with %+v, corpse %v", last.Inventory, corpseItems(h))
	}
}

// An NPC's shop reads the pockets: a character with only its pockets (after a death)
// pays with the coins there and gets what it bought there; with full pockets the shop
// refuses instead of dropping it on the floor.
func TestShopBuysWithOnlyThePockets(t *testing.T) {
	h := dataHarness(t)
	nextChar++
	cl, p := h.joinFresh(session.Character{ID: nextChar, AccountID: nextChar, Name: "Poor", Vocation: "guardian", Level: 1,
		Health: 145, Mana: 20, HasPos: true, InventoryLoaded: true}, pos(11, 11))
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "copper_coin", 100) }))
	h.sim.Step()
	cl.take()
	if p.Equipped(slotBackpack) != nil || !slices.Equal(pocketIDs(p), []string{"copper_coinx100"}) {
		t.Fatalf("pockets %v", pocketIDs(p))
	}
	d := h.lastDialog(h.send(cl, talkMsg(h.npc("puerto_provisioner").ID())))
	shop := find(h.pick(cl, d, "dialog.trade"), (*pb.ServerMessage).GetShopOpen)
	if len(shop) != 1 || shop[0].Money != 100 {
		t.Fatalf("shop: %v", shop)
	}
	rope := itemNum(t, h, p, "rope")
	buy := &pb.ClientMessage{Message: &pb.ClientMessage_ShopBuy{ShopBuy: &pb.ShopBuy{DialogId: d.DialogId, ItemId: rope, Count: 1}}}
	if evs := h.send(cl, buy); h.w.Money(p) != 55 || !slices.Equal(pocketIDs(p), []string{"copper_coinx55", "rope"}) {
		t.Fatalf("bought: %v, money %d, pockets %v", messageKeys(evs), h.w.Money(p), pocketIDs(p))
	}
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "rope", 2) })) // the pockets are full
	h.sim.Step()
	cl.take()
	if evs := h.send(cl, buy); !messageKeys(evs)["shop.no_room"] || h.w.Money(p) != 55 {
		t.Fatalf("buying with full pockets: %v, money %d", messageKeys(evs), h.w.Money(p))
	}
}
