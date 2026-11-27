package session_test

import (
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// corpseMoveWait is inventory.corpse_move_cooldown_ms in these tests.
const corpseMoveWait = 300

// dragHarness is m with a calm wolf (and rats) on the given spawns and the default remains.
func dragHarness(t *testing.T, m *world.Map, items content.Items, spawns ...world.Spawn) *harness {
	t.Helper()
	wolf := wolfDef()
	wolf.Behavior.Aggressive = false
	wolf.Loot = []content.LootEntry{{Item: "copper_coin", Chance: 1, Count: []int{3, 3}}}
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolf, "rat": ratDef()}
		c.Items = items
		c.Balance.Inventory.CorpseMoveCooldownMs = corpseMoveWait
		c.Map.Islands()[0].Spawns = spawns
	})
}

// drag sends a MoveItem of the remains at index of from to the tile to, runs a tick and
// returns the key of the message the player got ("" if none).
func (h *harness) drag(cl *fakeClient, from world.Pos, index uint32, to *pb.ItemLocation) string {
	h.t.Helper()
	cl.take()
	h.input(cl, moveItem(onTile(from), corpseID, index, to, 1))
	h.sim.Step()
	if msgs := find(cl.take(), (*pb.ServerMessage).GetChatMessage); len(msgs) > 0 {
		return msgs[0].GetLocalized().GetKey()
	}
	return ""
}

// waitDrag lets the wait between two drags of a body go by.
func (h *harness) waitDrag() { h.sim.RunFor(corpseMoveWait * time.Millisecond) }

// whose lists the monsters whose remains lie on p, oldest (bottom) first.
func whose(h *harness, p world.Pos) []string {
	var out []string
	for _, c := range h.w.CorpsesAt(p) {
		out = append(out, c.Monster)
	}
	return out
}

func same(a []string, b ...string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// The remains of a monster are dragged one tile at a time by a player standing next to
// them, onto a walkable tile of the same floor, never into a slot or a container; they
// stay the same container with the same loot, land on top of what lies there, every body
// of a pile is reachable, and they decay when they would have without the moves.
func TestDragCorpse(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"########",
		"#T.....#",
		"#......#",
		"#......#",
		"########",
	)
	h := dragHarness(t, m, testItems(), spawnAt("wolf", 3, 1, 0, 600), spawnAt("rat", 4, 1, 0, 600))
	cl, _ := h.join("Dragger", at(2, 2))  // next to the wolf, two tiles from the rat
	other, _ := h.join("Other", at(5, 1)) // next to the rat
	h.sim.Step()
	killAll(h)
	wolfAt, ratAt := pos(3, 1), pos(4, 1)
	if !same(whose(h, wolfAt), "wolf") || !same(whose(h, ratAt), "rat") {
		t.Fatalf("remains: %v %v", whose(h, wolfAt), whose(h, ratAt))
	}
	wolf := h.w.CorpsesAt(wolfAt)[0]
	loot := wolf.Item.Items()
	if len(loot) != 1 || loot[0].Count() != 3 {
		t.Fatalf("wolf loot %v", wolf.Loot())
	}

	// Refused: out of the player's reach, more than a tile away, a wall, a slot.
	for name, c := range map[string]struct {
		from world.Pos
		to   *pb.ItemLocation
		want string
	}{
		"body out of reach":     {ratAt, onTile(pos(4, 2)), "inventory.too_far"},
		"two tiles away":        {wolfAt, onTile(pos(3, 3)), "inventory.corpse_drag"},
		"a wall":                {wolfAt, onTile(pos(3, 0)), "inventory.not_possible"},
		"the backpack slot":     {wolfAt, inSlot(slotBackpack), "inventory.corpse_drag"},
		"the right hand's slot": {wolfAt, inSlot(pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND), "inventory.corpse_drag"},
	} {
		if got := h.drag(cl, c.from, 1, c.to); got != c.want {
			t.Errorf("%s: message %q, want %q", name, got, c.want)
		}
	}
	if !same(whose(h, wolfAt), "wolf") || !same(whose(h, ratAt), "rat") || len(h.w.GroundAt(pos(3, 3))) != 0 {
		t.Fatalf("a refused drag moved something: %v %v", whose(h, wolfAt), whose(h, ratAt))
	}

	// One tile: both tiles are sent, the body is the same container with its loot.
	cl.take()
	h.input(cl, moveItem(onTile(wolfAt), corpseID, 1, onTile(pos(3, 2)), 1))
	h.sim.Step()
	evs := cl.take()
	if msgs := find(evs, (*pb.ServerMessage).GetChatMessage); len(msgs) != 0 {
		t.Fatalf("drag refused: %v", msgs)
	}
	if left, now := tileOf(evs, wolfAt), tileOf(evs, pos(3, 2)); len(left) != 1 || len(now) != 2 || now[1] != corpseID {
		t.Errorf("tiles after the drag: left %v, new %v", left, now)
	}
	if len(whose(h, wolfAt)) != 0 || !same(whose(h, pos(3, 2)), "wolf") || h.w.CorpsesAt(pos(3, 2))[0] != wolf ||
		len(h.w.GroundAt(wolfAt)) != 0 || len(h.w.GroundAt(pos(3, 2))) != 1 {
		t.Fatalf("after the drag: %v at the old tile, %v at the new", whose(h, wolfAt), whose(h, pos(3, 2)))
	}
	if now := wolf.Item.Items(); len(now) != 1 || now[0] != loot[0] || now[0].Count() != 3 {
		t.Errorf("loot after the drag: %v", wolf.Loot())
	}

	// Rate limited: the next drag waits.
	if got := h.drag(cl, pos(3, 2), 1, onTile(pos(3, 3))); got != "inventory.corpse_not_ready" {
		t.Errorf("a drag right after another: message %q", got)
	}
	if !same(whose(h, pos(3, 2)), "wolf") {
		t.Fatal("the body moved during the wait")
	}
	h.waitDrag()

	// Other opens the rat and drags it diagonally onto the wolf: it lands on top, and its
	// window closes, since Other no longer reaches it (no looting from afar).
	other.take()
	h.input(other, useItem(onTile(ratAt), corpseID, 1))
	h.sim.Step()
	opens := find(other.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 || opens[0].GetMods().GetRemainsOf() != "rat" {
		t.Fatalf("rat not opened: %v", opens)
	}
	h.input(other, moveItem(onTile(ratAt), corpseID, 1, onTile(pos(3, 2)), 1))
	h.sim.Step()
	evs = other.take()
	if closes := find(evs, (*pb.ServerMessage).GetContainerClose); len(closes) != 1 {
		t.Errorf("the window of a body dragged out of reach stayed open: %v", find(evs, (*pb.ServerMessage).GetChatMessage))
	}
	if !same(whose(h, pos(3, 2)), "wolf", "rat") {
		t.Fatalf("pile: %v", whose(h, pos(3, 2)))
	}
	if g := h.w.GroundAt(pos(3, 2)); len(g) != 2 || g[1].Mods().RemainsOf != "rat" {
		t.Fatalf("the dragged body is not on top")
	}

	// Every body of the pile is reachable: the one below opens by its index, and dragging
	// the top one away reveals it.
	open := func(index uint32) string {
		cl.take()
		h.input(cl, useItem(onTile(pos(3, 2)), corpseID, index))
		h.sim.Step()
		o := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
		if len(o) != 1 {
			t.Fatalf("body %d of the pile not opened", index)
		}
		return o[0].GetMods().GetRemainsOf()
	}
	if top, below := open(2), open(1); top != "rat" || below != "wolf" {
		t.Errorf("pile opens %q on top and %q below", top, below)
	}
	if got := h.drag(cl, pos(3, 2), 2, onTile(pos(3, 3))); got != "" {
		t.Fatalf("dragging the top body: %q", got)
	}
	if !same(whose(h, pos(3, 2)), "wolf") || !same(whose(h, pos(3, 3)), "rat") {
		t.Fatalf("after dragging the top one: %v and %v", whose(h, pos(3, 2)), whose(h, pos(3, 3)))
	}

	// Decay: monster_corpse_ms after the death, wherever the bodies lie now.
	left := time.Duration(testBalance().Combat.MonsterCorpseMs) * time.Millisecond
	h.sim.RunFor(left - 5*time.Second)
	if !same(whose(h, pos(3, 2)), "wolf") || !same(whose(h, pos(3, 3)), "rat") {
		t.Fatal("a dragged body decayed early")
	}
	h.sim.RunFor(5 * time.Second)
	for _, p := range []world.Pos{wolfAt, ratAt, pos(3, 2), pos(3, 3)} {
		if len(h.w.CorpsesAt(p)) != 0 || len(h.w.GroundAt(p)) != 0 {
			t.Errorf("remains left at %v after monster_corpse_ms", p)
		}
	}
}

// The body of a player follows the rule of its loot: while it is reserved to who died
// (corpse_owner_only_ms) only that player drags it, and dragging it changes neither the
// reservation nor when it decays.
func TestDragPlayerCorpse(t *testing.T) {
	h := deathHarness(t, func(c *session.Config) { c.Balance.Death.EquipmentDropPct = 100 })
	owner, p := h.geared("Owner", 20, 0)
	other, q := h.join("Other", at(41, 40))
	h.kill(p)
	body := pos(40, 40)
	corpse := h.w.CorpsesAt(body)[0]
	held := len(corpse.Item.Items())

	if got := h.drag(other, body, 1, onTile(pos(41, 41))); got != "death.corpse_not_owner" {
		t.Errorf("another player dragging a reserved body: %q", got)
	}
	if len(h.w.CorpsesAt(body)) != 1 {
		t.Fatal("another player dragged a reserved body")
	}

	// Its owner comes back and drags it; it stays reserved where it lies now.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(39, 40)) }))
	h.sim.Step()
	if got := h.drag(owner, body, 1, onTile(pos(40, 41))); got != "" {
		t.Fatalf("the owner dragging its body: %q", got)
	}
	body = pos(40, 41)
	if c := h.w.CorpsesAt(body); len(c) != 1 || c[0] != corpse || len(h.w.CorpsesAt(pos(40, 40))) != 0 {
		t.Fatal("the body did not move")
	}
	var window uint32
	take := func() string {
		other.take()
		if window == 0 { // the window stays open: using the body again would close it
			h.input(other, useItem(onTile(body), corpseID, 1))
			h.sim.Step()
			evs := other.take()
			opens := find(evs, (*pb.ServerMessage).GetContainerOpen)
			if len(opens) != 1 {
				t.Fatalf("body not opened: %v", evs)
			}
			window = opens[0].GetContainerId()
		}
		first := corpse.Item.Items()[0]
		h.input(other, moveItem(inContainer(window, 0), uint32(first.Def().Numeric), 0, onTile(q.Pos()), uint32(first.Count())))
		h.sim.Step()
		if msgs := find(other.take(), (*pb.ServerMessage).GetChatMessage); len(msgs) > 0 {
			return msgs[0].GetLocalized().GetKey()
		}
		return ""
	}
	if got := take(); got != "death.corpse_not_owner" || len(corpse.Item.Items()) != held {
		t.Errorf("another player took from a dragged body: %q", got)
	}
	if got := h.drag(other, body, 1, onTile(pos(41, 41))); got != "death.corpse_not_owner" {
		t.Errorf("another player dragging a dragged, reserved body: %q", got)
	}

	// The reservation ends when it would have: corpse_owner_only_ms after the death.
	d := testBalance().Death
	h.sim.RunFor(time.Duration(d.CorpseOwnerOnlyMs)*time.Millisecond - 10*time.Second)
	if got := h.drag(other, body, 1, onTile(pos(41, 41))); got != "death.corpse_not_owner" {
		t.Errorf("the reservation ended early: %q", got)
	}
	h.sim.RunFor(10 * time.Second)
	if got := take(); got != "" || len(corpse.Item.Items()) != held-1 {
		t.Errorf("after the reservation: %q", got)
	}
	if got := h.drag(other, body, 1, onTile(pos(41, 41))); got != "" {
		t.Errorf("anyone drags it after the reservation: %q", got)
	}
	body = pos(41, 41)

	// And it decays corpse_ms after the death.
	h.sim.RunFor(time.Duration(d.CorpseMs-d.CorpseOwnerOnlyMs)*time.Millisecond - 5*time.Second)
	if len(h.w.CorpsesAt(body)) != 1 {
		t.Fatal("a dragged body decayed early")
	}
	h.sim.RunFor(5 * time.Second)
	if len(h.w.CorpsesAt(body)) != 0 || len(h.w.GroundAt(body)) != 0 {
		t.Error("the body did not decay at corpse_ms")
	}
}

// A body is never dragged onto the tile of a door (it would keep it open), the entrance
// of stairs (it would fall to another floor) or a house tile.
func TestDragCorpseKeepsOffDoorsStairsAndHouses(t *testing.T) {
	t.Run("door", func(t *testing.T) {
		h := dragHarness(t, doorMap(t), doorTestItems(false), spawnAt("wolf", 5, 2, 0, 600))
		cl, _ := h.join("Dragger", at(5, 3))
		h.sim.Step()
		killAll(h)
		cl.take()
		h.input(cl, useGate(uint32(worldtest.Door)))
		h.sim.Step()
		if tile := tileOf(cl.take(), gate); len(tile) != 2 || tile[1] != uint32(worldtest.OpenDoor) {
			t.Fatalf("gate not open: %v", tile)
		}
		if got := h.drag(cl, pos(5, 2), 1, onTile(gate)); got != "inventory.corpse_no_place" {
			t.Errorf("onto an open door: %q", got)
		}
		if len(h.w.CorpsesAt(gate)) != 0 || len(h.w.GroundAt(gate)) != 0 || len(h.w.CorpsesAt(pos(5, 2))) != 1 {
			t.Error("a body lies on the door's tile")
		}
	})
	t.Run("stairs", func(t *testing.T) {
		h := dragHarness(t, portalMap(t), testItems(), spawnAt("wolf", 4, 2, 0, 600))
		cl, _ := h.join("Dragger", at(4, 3))
		h.sim.Step()
		killAll(h)
		if got := h.drag(cl, pos(4, 2), 1, onTile(stairsDown)); got != "inventory.corpse_no_place" {
			t.Errorf("onto stairs: %q", got)
		}
		if len(h.w.CorpsesAt(pos(4, 2))) != 1 || len(h.w.GroundAt(stairsDown)) != 0 || len(h.w.GroundAt(at3(5, 3, 8))) != 0 {
			t.Error("a body went down the stairs")
		}
	})
	t.Run("house", func(t *testing.T) {
		m := worldtest.WithHouses(t, worldtest.Open(t, 0, 0, 64, 64), world.House{ID: "nook", Name: "house.nook.name", Rent: 10,
			Rects: []world.HouseRect{{X: 22, Y: 20, Z: 7, W: 1, H: 1}}, Doors: []world.Pos{pos(22, 20)}, Exit: pos(22, 21)})
		h := dragHarness(t, m, testItems(), spawnAt("wolf", 21, 20, 0, 600))
		cl, _ := h.join("Dragger", at(20, 20))
		h.sim.Step()
		killAll(h)
		if got := h.drag(cl, pos(21, 20), 1, onTile(pos(22, 20))); got != "inventory.corpse_no_place" {
			t.Errorf("into a house: %q", got)
		}
		if len(h.w.CorpsesAt(pos(21, 20))) != 1 || len(h.w.GroundAt(pos(22, 20))) != 0 {
			t.Error("a body lies in a house")
		}
	})
}
