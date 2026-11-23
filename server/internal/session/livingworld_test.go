package session_test

import (
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Items of the living-world tests (ids nobody else uses).
const (
	lwCrateID   = 300
	lwDebrisID  = 301
	lwRockID    = 302
	lwVinesID   = 303
	lwPickID    = 304
	lwBoulderID = 305
	lwGateID    = 306
	lwGateOpen  = 307
	lwPlateID   = 308
)

var livingItemDefs = map[uint16]string{
	lwCrateID:   "{id: lw_crate, kind: decoration, pickupable: false, blocks_movement: true, blocks_sight: true}",
	lwDebrisID:  "{id: lw_crate_debris, kind: decoration, pickupable: false}",
	lwRockID:    "{id: lw_rock, kind: decoration, pickupable: false, blocks_movement: true}",
	lwVinesID:   "{id: lw_vines, kind: decoration, pickupable: false, blocks_movement: true}",
	lwPickID:    "{id: lw_pick, kind: tool, weight: 4200, tool: {use: mining}}",
	lwBoulderID: "{id: lw_boulder, kind: decoration, pickupable: false, blocks_movement: true}",
	lwGateID:    "{id: lw_gate, kind: decoration, pickupable: false, blocks_movement: true}",
	lwGateOpen:  "{id: lw_gate_open, kind: decoration, pickupable: false}",
	lwPlateID:   "{id: lw_plate, kind: decoration, pickupable: false}",
}

const livingYAML = `
- item: lw_crate
  breakable:
    hp: 20
    by: [melee, any_attack, fire]
    becomes: lw_crate_debris
    debris_seconds: 2
    respawn_seconds: 4
    effect: wood
    loot: [{ item: copper_coin, chance: 1, count: [5, 5] }]
- item: lw_rock
  breakable: { hp: 15, by: ["tool:pick"], becomes: none, respawn_seconds: 60 }
- item: lw_vines
  breakable: { hp: 1, by: [melee], becomes: none, respawn_seconds: 1 }
- item: lw_boulder
  pushable: { reset_seconds: 600 }
- item: lw_gate
  gate: { open: lw_gate_open }
- item: lw_plate
  plate: { radius: 6 }
`

// livingHarness builds a world of m with the living-world items; objects puts each item
// on its tile (blocking as mapcompile would have flagged it).
func livingHarness(t *testing.T, m *world.Map, objects map[world.Pos]uint16) *harness {
	t.Helper()
	items := testItems()
	for n, src := range livingItemDefs {
		var it content.Item
		if err := yaml.Unmarshal([]byte(src), &it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = n
		items[it.ID] = &it
	}
	for p, id := range objects {
		var f world.Flags
		for _, def := range items {
			if def.Numeric == id && def.BlocksMovement() {
				f = world.FlagBlocksMovement
			}
		}
		worldtest.SetTile(t, m, p, worldtest.Grass, f, id)
	}
	var defs session.LivingDefs
	if err := yaml.Unmarshal([]byte(livingYAML), &defs); err != nil {
		t.Fatal(err)
	}
	return newHarness(t, m, func(c *session.Config) {
		c.Items = items
		c.LivingWorld = defs
	})
}

func armed(h *harness, p world.Pos, item uint16) (*fakeClient, *session.Player) {
	nextChar++
	c := withPack(nextChar, p)
	if item != 0 {
		c.Inventory = append(c.Inventory, session.ItemState{ItemID: item, Count: 1, Slot: int(slotRight)})
	}
	return h.joinChar(c)
}

// strike uses the object of p (stack index 1: the map's own stack is empty there).
func strike(h *harness, cl *fakeClient, p world.Pos, item uint16) []*pb.ServerMessage {
	h.input(cl, useItem(onTile(p), uint32(item), 1))
	h.sim.Step()
	return cl.take()
}

func livingEvents(evs []*pb.ServerMessage) []pb.LivingObjectKind {
	var out []pb.LivingObjectKind
	for _, e := range find(evs, (*pb.ServerMessage).GetLivingObject) {
		out = append(out, e.GetKind())
	}
	return out
}

func lastTile(evs []*pb.ServerMessage, p world.Pos) []uint32 {
	var ids []uint32
	for _, u := range find(evs, (*pb.ServerMessage).GetTileUpdate) {
		if u.GetPos().GetX() == uint32(p.X) && u.GetPos().GetY() == uint32(p.Y) {
			ids = ids[:0]
			for _, it := range u.GetTile().GetItems() {
				ids = append(ids, it.GetItemId())
			}
		}
	}
	return ids
}

func coinsOn(h *harness, p world.Pos) int {
	n := 0
	for _, it := range h.w.GroundAt(p) {
		if it.Def().Numeric == coinID {
			n += it.Count()
		}
	}
	return n
}

// A crate takes two sword strikes (attack 13, 20 hp), shows its debris and drops its loot
// once: strikes on the debris neither hurt nor drop again. The tile is walkable at once.
func TestLivingCrateBreaksAndDropsLootOnce(t *testing.T) {
	crate := pos(3, 2)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{crate: lwCrateID})
	m := h.w.Map()
	if m.Walkable(crate) || len(m.Stack(crate)) != 0 {
		t.Fatal("the crate must leave the map's stack and still block")
	}
	cl, _ := armed(h, pos(2, 2), swordID)
	evs := cl.take()
	_ = evs
	if got := livingEvents(strike(h, cl, crate, lwCrateID)); len(got) != 1 || got[0] != pb.LivingObjectKind_LIVING_OBJECT_KIND_HIT {
		t.Fatalf("first strike: %v", got)
	}
	h.sim.RunTicks(2) // the pace of the trades
	evs = strike(h, cl, crate, lwCrateID)
	if got := livingEvents(evs); len(got) != 1 || got[0] != pb.LivingObjectKind_LIVING_OBJECT_KIND_BREAK {
		t.Fatalf("second strike: %v", got)
	}
	if tile := lastTile(evs, crate); len(tile) != 3 || tile[1] != lwDebrisID || tile[2] != coinID {
		t.Fatalf("tile after the break: %v, want grass, debris, coins", tile)
	}
	if !m.Walkable(crate) || coinsOn(h, crate) != 5 {
		t.Fatalf("walkable %v, coins %d", m.Walkable(crate), coinsOn(h, crate))
	}
	for range 3 {
		h.sim.RunTicks(2)
		if evs := strike(h, cl, crate, lwDebrisID); !hasKey(evs, "living.already_broken") {
			t.Fatalf("a strike on the debris: %v", systemKeys(evs))
		}
	}
	if coinsOn(h, crate) != 5 {
		t.Fatalf("coins after strikes on the debris: %d", coinsOn(h, crate))
	}
}

// A cracked rock refuses the sword and breaks with a pickaxe used on it.
func TestLivingRockNeedsAPick(t *testing.T) {
	rock := pos(3, 2)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{rock: lwRockID})
	cl, _ := armed(h, pos(2, 2), swordID)
	cl.take()
	if evs := strike(h, cl, rock, lwRockID); !hasKey(evs, "living.wrong_way") || len(livingEvents(evs)) != 0 {
		t.Fatalf("sword on the rock: %v", systemKeys(evs))
	}
	miner, _ := armed(h, pos(3, 1), lwPickID)
	miner.take()
	evs := h.try(miner, lwPickID, rock)
	h.sim.RunTicks(2)
	evs = append(evs, h.try(miner, lwPickID, rock)...)
	if got := livingEvents(evs); len(got) != 2 || got[1] != pb.LivingObjectKind_LIVING_OBJECT_KIND_BREAK {
		t.Fatalf("pick strikes: %v (%v)", got, systemKeys(evs))
	}
	if !h.w.Map().Walkable(rock) || h.w.LivingObjects()[0].State != "gone" {
		t.Fatalf("rock after the pick: %+v", h.w.LivingObjects())
	}
}

// Cut vines come back after a second, but never under a player: they wait until the
// tile is free.
func TestLivingRespawnWaitsForTheOccupant(t *testing.T) {
	vines := pos(3, 2)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{vines: lwVinesID})
	cl, p := armed(h, pos(2, 2), swordID)
	cl.take()
	strike(h, cl, vines, lwVinesID)
	h.input(cl, walk(E))
	h.sim.RunTicks(80)
	if p.Pos() != vines {
		t.Fatalf("player at %v, want on the cut vines %v", p.Pos(), vines)
	}
	if s := h.w.LivingObjects()[0]; s.State != "gone" {
		t.Fatalf("vines respawned under the player: %+v", s)
	}
	h.input(cl, walk(W))
	h.sim.RunTicks(80)
	if s := h.w.LivingObjects()[0]; s.State != "intact" || h.w.Map().Walkable(vines) {
		t.Fatalf("vines did not come back on the free tile: %+v", s)
	}
}

func push(p world.Pos, d pb.Direction) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_PushObject{PushObject: &pb.PushObject{
		Pos: &pb.Position{X: uint32(p.X), Y: uint32(p.Y), Z: uint32(p.Z)}, Dir: d}}}
}

// Two players push the same boulder on one tick: the first moves it, the second finds
// nothing where it pushed. A push into a wall is refused and moves nothing.
func TestLivingPushes(t *testing.T) {
	boulder := pos(3, 2)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
		"......",
		".....#",
	), map[world.Pos]uint16{boulder: lwBoulderID})
	a, _ := armed(h, pos(2, 2), 0)
	b, _ := armed(h, pos(3, 1), 0)
	a.take()
	b.take()
	h.input(a, push(boulder, E))
	h.input(b, push(boulder, S))
	h.sim.Step()
	if s := h.w.LivingObjects()[0]; s.Pos != pos(4, 2) {
		t.Fatalf("boulder at %v, want 4,2", s.Pos)
	}
	if !hasKey(b.take(), "inventory.not_possible") && !h.w.Map().Walkable(boulder) {
		t.Fatal("the second push must find nothing")
	}
	if h.w.Map().Walkable(pos(4, 2)) || !h.w.Map().Walkable(boulder) {
		t.Fatal("the boulder's block must move with it")
	}
	evs := a.take()
	if got := livingEvents(evs); len(got) != 1 || got[0] != pb.LivingObjectKind_LIVING_OBJECT_KIND_PUSH {
		t.Fatalf("push events: %v", got)
	}
	// Not next to it any more: too far. Then from 4,1 south twice: the wall at 5,4 is not
	// in the way, the second push onto 4,4 is free, a third would leave the map's row.
	h.input(a, push(pos(4, 2), E))
	h.sim.Step()
	if !hasKey(a.take(), "inventory.too_far") {
		t.Fatal("a push from afar must be refused")
	}
	wall := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"...#..",
		"......",
	), map[world.Pos]uint16{pos(2, 0): lwBoulderID})
	c, _ := armed(wall, pos(1, 0), 0)
	c.take()
	wall.input(c, push(pos(2, 0), E))
	wall.sim.Step()
	if !hasKey(c.take(), "living.push_blocked") || wall.w.LivingObjects()[0].Pos != pos(2, 0) {
		t.Fatalf("push into a wall: %+v", wall.w.LivingObjects())
	}
}

// A player on the pressure plate opens the gate; leaving it closes it again.
func TestLivingPlateOpensTheGate(t *testing.T) {
	gate, plate := pos(4, 1), pos(1, 1)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{gate: lwGateID, plate: lwPlateID})
	m := h.w.Map()
	if m.Walkable(gate) || len(m.Stack(plate)) != 1 {
		t.Fatal("the gate starts closed; the plate stays on the map")
	}
	cl, _ := armed(h, pos(1, 2), 0)
	cl.take()
	h.input(cl, walk(N))
	h.sim.RunTicks(40)
	if !m.Walkable(gate) {
		t.Fatal("the plate is pressed: the gate must be open")
	}
	h.input(cl, walk(S))
	h.sim.RunTicks(40)
	if m.Walkable(gate) {
		t.Fatal("the plate is free: the gate must close")
	}
}

// The object is one more item of the tile for the client: in the view, looked at and
// used at stack index 1.
func TestLivingObjectInTheView(t *testing.T) {
	crate := pos(3, 2)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{crate: lwCrateID})
	cl, _ := armed(h, pos(2, 2), swordID)
	view := find(cl.take(), (*pb.ServerMessage).GetFullMapView)
	if len(view) != 1 {
		t.Fatal("no FullMapView")
	}
	found := false
	for _, tile := range view[0].GetArea().GetPalette() {
		if items := tile.GetItems(); len(items) == 2 && items[1].GetItemId() == lwCrateID {
			found = true
		}
	}
	if !found {
		t.Fatal("the crate is not in the view")
	}
	h.input(cl, lookAt(onTile(crate), lwCrateID, 1))
	h.sim.Step()
	if hasKey(cl.take(), "inventory.not_possible") {
		t.Fatal("looking at the crate must work")
	}
}
