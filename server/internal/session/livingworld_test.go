package session_test

import (
	"errors"
	"strings"
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

// livingBalance is balance.living of the tests (data/balance.yaml's numbers).
var livingBalance = content.Living{FistDamage: 5, ToolDamage: 10, PushCooldownMs: 400}

// livingSetup is the option of a world of m with the living-world items; objects puts
// each item on its tile (blocking as mapcompile would have flagged it).
func livingSetup(t *testing.T, m *world.Map, objects map[world.Pos]uint16) option {
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
	return func(c *session.Config) {
		c.Items = items
		c.LivingWorld = defs
		c.Balance.Living = livingBalance
	}
}

// livingHarness builds a world of m with the living-world items and objects (livingSetup),
// then applies opts.
func livingHarness(t *testing.T, m *world.Map, objects map[world.Pos]uint16, opts ...option) *harness {
	t.Helper()
	return newHarness(t, m, append([]option{livingSetup(t, m, objects)}, opts...)...)
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

// coinsAround counts the coins on the tiles within one of p, p left out.
func coinsAround(h *harness, p world.Pos) int {
	n := 0
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if q := pos(int(p.X)+dx, int(p.Y)+dy); q != p {
				n += coinsOn(h, q)
			}
		}
	}
	return n
}

// The loot nobody picks up never holds the crate back: when it stands again (nobody
// looks: who broke it left), the coins are moved to a tile next to it (none lost, none
// made).
func TestLivingCrateRespawnsOverItsUntakenLoot(t *testing.T) {
	crate := pos(3, 2)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{crate: lwCrateID})
	cl, _ := armed(h, pos(2, 2), swordID)
	cl.take()
	strike(h, cl, crate, lwCrateID)
	h.sim.RunTicks(2)
	strike(h, cl, crate, lwCrateID)
	if coinsOn(h, crate) != 5 {
		t.Fatalf("loot on the crate's tile: %d", coinsOn(h, crate))
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.RunTicks(4*20 + 20) // respawn_seconds, and one retry to spare
	if s := h.w.LivingObjects()[0]; s.State != "intact" || h.w.Map().Walkable(crate) {
		t.Fatalf("the crate did not stand again over its loot: %+v", s)
	}
	if coinsOn(h, crate) != 0 || coinsAround(h, crate) != 5 {
		t.Fatalf("coins on the crate %d, next to it %d, want 0 and 5", coinsOn(h, crate), coinsAround(h, crate))
	}
}

// An item dropped in an open gateway does not keep the gate open once its plate is let
// go: it is moved aside and the gate closes.
func TestLivingGateClosesOverALooseItem(t *testing.T) {
	gate, plate := pos(4, 1), pos(1, 1)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{gate: lwGateID, plate: lwPlateID})
	m := h.w.Map()
	cl, _ := armed(h, pos(1, 2), 0)
	cl.take()
	h.input(cl, walk(N))
	h.sim.RunTicks(40)
	if !m.Walkable(gate) {
		t.Fatal("the plate is pressed: the gate must be open")
	}
	h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["copper_coin"], 7, gate) }))
	h.sim.Step()
	h.input(cl, walk(S))
	h.sim.RunTicks(40)
	if m.Walkable(gate) {
		t.Fatal("a coin in the gateway kept the gate open")
	}
	if coinsOn(h, gate) != 0 || coinsAround(h, gate) != 7 {
		t.Fatalf("coins in the gateway %d, next to it %d, want 0 and 7", coinsOn(h, gate), coinsAround(h, gate))
	}
}

// Cut vines come back after a second, but never under a creature: they wait until the
// tile is free. The occupant is a staff member walking invisible, the only player whose
// view does not hold a respawn back (TestLivingRespawnWaitsWhileSeen).
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
	h.sim.Command(gameFunc(func() {
		h.w.SetRoleForTest(p, session.RoleGM)
		h.w.SetInvisibleForTest(p, true)
	}))
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

// Nothing of the living world comes back in a player's view: cut vines stay cut while
// who cut them stands by, and grow back once it is gone. A boulder pushed off its home
// stays where it was left while a player sees it.
func TestLivingRespawnWaitsWhileSeen(t *testing.T) {
	vines, boulder := pos(3, 2), pos(3, 0)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{vines: lwVinesID, boulder: lwBoulderID})
	cl, _ := armed(h, pos(2, 2), swordID)
	other, _ := armed(h, pos(2, 0), 0)
	cl.take()
	strike(h, cl, vines, lwVinesID)
	h.input(other, push(boulder, E))
	h.sim.RunTicks(601 * 20) // past the vines' second and the boulder's reset_seconds
	state := func() (string, world.Pos) {
		var v string
		var b world.Pos
		for _, o := range h.w.LivingObjects() {
			if o.Item == "lw_vines" {
				v = o.State
			} else {
				b = o.Pos
			}
		}
		return v, b
	}
	if v, b := state(); v != "gone" || b != pos(4, 0) {
		t.Fatalf("in sight: vines %q, boulder at %v; want gone and still at 4,0", v, b)
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.Command(h.w.Leave(other))
	h.sim.RunTicks(3 * 20)
	if v, b := state(); v != "intact" || b != boulder {
		t.Fatalf("nobody looks: vines %q, boulder at %v; want intact and home", v, b)
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
	if evs := b.take(); !hasKey(evs, "inventory.not_possible") || len(livingEvents(evs)) != 1 {
		// b sees a's push (one event) and is told its own found nothing.
		t.Fatalf("the second push must find nothing: %v, events %v", systemKeys(evs), livingEvents(evs))
	}
	if h.w.Map().Walkable(pos(4, 2)) || !h.w.Map().Walkable(boulder) {
		t.Fatal("the boulder's block must move with it")
	}
	evs := a.take()
	if got := livingEvents(evs); len(got) != 1 || got[0] != pb.LivingObjectKind_LIVING_OBJECT_KIND_PUSH {
		t.Fatalf("push events: %v", got)
	}
	// Not next to it any more: too far.
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

// A boulder never goes onto a door's tile, even an open one: the door would close on it,
// and in a locked door's way it could shut a room.
func TestLivingPushOntoADoorIsRefused(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	)
	door := pos(3, 1)
	h := livingHarness(t, m, map[world.Pos]uint16{pos(2, 1): lwBoulderID},
		func(c *session.Config) { c.Items = withDoorItems(c.Items, false) })
	worldtest.SetTile(t, m, door, worldtest.Grass, 0, plainOpenID)
	cl, _ := armed(h, pos(1, 1), 0)
	cl.take()
	h.input(cl, push(pos(2, 1), E))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "living.push_blocked") || h.w.LivingObjects()[0].Pos != pos(2, 1) {
		t.Fatalf("push onto an open door: %v, %+v", systemKeys(evs), h.w.LivingObjects())
	}
}

// A gate whose plate is let go stays open while someone stands in it, and closes once
// that one walks on.
func TestLivingGateWaitsForWhoStandsInIt(t *testing.T) {
	gate, plate := pos(4, 1), pos(1, 1)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	), map[world.Pos]uint16{gate: lwGateID, plate: lwPlateID})
	m := h.w.Map()
	holder, _ := armed(h, pos(1, 2), 0)
	walker, wp := armed(h, pos(3, 1), 0)
	holder.take()
	walker.take()
	h.input(holder, walk(N))
	h.sim.RunTicks(40)
	h.input(walker, walk(E))
	h.sim.RunTicks(40)
	if wp.Pos() != gate {
		t.Fatalf("walker at %v, want in the open gate", wp.Pos())
	}
	h.input(holder, walk(S))
	h.sim.RunTicks(40)
	if !m.Walkable(gate) {
		t.Fatal("the gate closed on the player standing in it")
	}
	h.input(walker, walk(E))
	h.sim.RunTicks(40)
	if m.Walkable(gate) {
		t.Fatal("the gate must close once its tile is free")
	}
}

// A gate that shuts a room with no other way to a temple stops the world from starting:
// whoever is inside when its plates are let go (or after a restart) would be locked in.
// A teleport out of the room lets it start.
func TestLivingGateMustNotShutARoom(t *testing.T) {
	rows := []string{
		"#########",
		"#T......#",
		"#.......#",
		"#####.###",
		"#.......#",
		"#########",
	}
	gate := pos(5, 3)
	m := worldtest.Map(t, 0, 0, 7, rows...)
	cfg := session.Config{Map: m, Balance: testBalance(), Vocations: testVocations,
		Save: func(session.Snapshot) bool { return true }}
	livingSetup(t, m, map[world.Pos]uint16{gate: lwGateID, pos(2, 2): lwPlateID})(&cfg)
	if _, err := session.New(cfg); !errors.Is(err, session.ErrGateNoEscape) || !strings.Contains(err.Error(), "gate on 5,3,7") {
		t.Fatalf("got %v, want %v", err, session.ErrGateNoEscape)
	}

	m = worldtest.Map(t, 0, 0, 7, rows...)
	m = worldtest.WithPortals(t, m, world.Portal{ID: "out", Kind: world.PortalTeleport, From: pos(7, 4), To: pos(3, 1)})
	cfg.Map = m
	livingSetup(t, m, map[world.Pos]uint16{gate: lwGateID, pos(2, 2): lwPlateID})(&cfg)
	if _, err := session.New(cfg); err != nil {
		t.Fatalf("with a teleport out: %v", err)
	}
}

// A crate burns in a fire area spell over its tile (the crate blocks sight, but its own
// tile is in the area); a spell of another element leaves it whole.
func TestLivingFireAreaBurnsACrate(t *testing.T) {
	crate := pos(4, 2)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"........",
		"........",
		"........",
		"........",
	), map[world.Pos]uint16{crate: lwCrateID}, func(c *session.Config) {
		c.Spells = testSpells()
		c.Balance.Skills.Base["magic"] = content.SkillBase{StartLevel: 0, BaseTries: magicTries}
	})
	cl, _ := arcanist(t, h, pos(2, 2))
	evs := h.castNow(cl, cast("test_ring")) // fire, radius 2, 10 damage of 20 hp
	if got := livingEvents(evs); len(got) != 1 || got[0] != pb.LivingObjectKind_LIVING_OBJECT_KIND_HIT {
		t.Fatalf("fire ring on the crate: %v", got)
	}
	if hp := h.w.LivingObjects()[0].HP; hp != 10 {
		t.Fatalf("crate hp %d, want 10", hp)
	}
}

// A bow strikes a crate from afar and spends an arrow; without arrows it does nothing. A
// wand strikes from afar with nothing to spend. Both refuse a rock that needs a pick.
func TestLivingShotsAtObjects(t *testing.T) {
	rows := []string{
		"........",
		"........",
		"........",
	}
	crate, rock := pos(5, 1), pos(5, 2)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7, rows...),
		map[world.Pos]uint16{crate: lwCrateID, rock: lwRockID})
	nextChar++
	c := withPack(nextChar, pos(2, 1))
	c.Vocation = "ranger"
	c.Inventory = append(c.Inventory, session.ItemState{ItemID: bowID, Count: 1, Slot: int(slotRight)},
		session.ItemState{ItemID: arrowID, Count: 1, Slot: int(slotAmmo)})
	archer, ap := h.joinChar(c)
	archer.take()
	if evs := strike(h, archer, crate, lwCrateID); len(livingEvents(evs)) != 1 {
		t.Fatalf("bow shot at the crate 3 tiles away: %v (%v)", livingEvents(evs), systemKeys(evs))
	}
	if ap.Equipped(slotAmmo) != nil {
		t.Fatal("the shot must spend the arrow")
	}
	h.sim.RunTicks(2)
	if evs := strike(h, archer, crate, lwCrateID); !hasKey(evs, "combat.no_ammo") || len(livingEvents(evs)) != 0 {
		t.Fatalf("bow without arrows: %v", systemKeys(evs))
	}
	if evs := strike(h, archer, rock, lwRockID); !hasKey(evs, "combat.no_ammo") && !hasKey(evs, "living.wrong_way") {
		t.Fatalf("bow at the rock: %v", systemKeys(evs))
	}

	mage, _ := armed(h, pos(2, 2), energyWand)
	mage.take()
	if evs := strike(h, mage, crate, lwCrateID); len(livingEvents(evs)) != 1 {
		t.Fatalf("wand at the crate: %v (%v)", livingEvents(evs), systemKeys(evs))
	}
	h.sim.RunTicks(2)
	if evs := strike(h, mage, rock, lwRockID); !hasKey(evs, "living.wrong_way") {
		t.Fatalf("wand at the rock: %v", systemKeys(evs))
	}
}

// An axe swung as a weapon cuts vines that break by tool:axe only.
func TestLivingAxeWeaponCuts(t *testing.T) {
	vines := pos(3, 1)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
	), map[world.Pos]uint16{vines: lwVinesID}, func(c *session.Config) {
		c.LivingWorld[2].Breakable.By = []string{"tool:axe"}
	})
	sword, _ := armed(h, pos(2, 0), swordID)
	sword.take()
	if evs := strike(h, sword, vines, lwVinesID); !hasKey(evs, "living.wrong_way") {
		t.Fatalf("sword on axe-only vines: %v", systemKeys(evs))
	}
	axe, _ := armed(h, pos(2, 1), axeID)
	axe.take()
	if got := livingEvents(strike(h, axe, vines, lwVinesID)); len(got) != 1 || got[0] != pb.LivingObjectKind_LIVING_OBJECT_KIND_BREAK {
		t.Fatalf("axe on the vines: %v", got)
	}
}

// No pushed object rests where a portal arrives: whoever takes it would find its landing
// taken (review of lote 17).
func TestLivingPushOntoAPortalLandingIsRefused(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
		"......",
	)
	opt := livingSetup(t, m, map[world.Pos]uint16{pos(2, 1): lwBoulderID})
	m = worldtest.WithPortals(t, m, world.Portal{ID: "tp", Kind: world.PortalTeleport, From: pos(0, 2), To: pos(3, 1)})
	h := newHarness(t, m, opt)
	cl, _ := armed(h, pos(1, 1), 0)
	cl.take()
	h.input(cl, push(pos(2, 1), E))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "living.push_blocked") || h.w.LivingObjects()[0].Pos != pos(2, 1) {
		t.Fatalf("push onto a portal's landing: %v, %+v", systemKeys(evs), h.w.LivingObjects())
	}
}

// An object the map puts on a door's tile or a portal's entrance stays a plain map item,
// as the map validator wants it (checkLiving).
func TestLivingObjectOnADoorOrPortalStaysAMapItem(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
	)
	opt := livingSetup(t, m, nil)
	worldtest.SetTile(t, m, pos(4, 0), worldtest.Grass, 0, plainOpenID, lwVinesID)
	worldtest.SetTile(t, m, pos(1, 1), worldtest.Grass, 0, lwCrateID)
	m = worldtest.WithPortals(t, m, world.Portal{ID: "tp", Kind: world.PortalTeleport, From: pos(1, 1), To: pos(3, 1)})
	h := newHarness(t, m, opt, func(c *session.Config) { c.Items = withDoorItems(c.Items, false) })
	if got := h.w.LivingObjects(); len(got) != 0 {
		t.Fatalf("objects on a door and a portal entrance: %+v", got)
	}
}

// Whoever sees only where a pushed object lands gets its event too, once; whoever sees
// both tiles gets it once.
func TestLivingPushEventReachesWhoSeesTheLanding(t *testing.T) {
	row := strings.Repeat(".", 24)
	boulder := pos(3, 1)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7, row, row, row),
		map[world.Pos]uint16{boulder: lwBoulderID})
	pusher, _ := armed(h, pos(2, 1), 0)
	far, _ := armed(h, pos(4+session.ViewHalfW, 1), 0)
	pusher.take()
	far.take()
	h.input(pusher, push(boulder, E))
	h.sim.Step()
	if got := livingEvents(pusher.take()); len(got) != 1 {
		t.Fatalf("pusher events: %v", got)
	}
	if got := livingEvents(far.take()); len(got) != 1 || got[0] != pb.LivingObjectKind_LIVING_OBJECT_KIND_PUSH {
		t.Fatalf("who sees only the landing: %v", got)
	}
}

// A push that finds nothing waits for the push cooldown too: one message per cooldown,
// whatever a client sends.
func TestLivingEmptyPushWaitsForTheCooldown(t *testing.T) {
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"......",
	), map[world.Pos]uint16{pos(5, 0): lwBoulderID})
	cl, _ := armed(h, pos(1, 1), 0)
	cl.take()
	h.input(cl, push(pos(2, 1), E))
	h.input(cl, push(pos(2, 1), E))
	h.input(cl, push(pos(2, 1), E))
	h.sim.Step()
	if n := systemKeys(cl.take())["inventory.not_possible"]; n != 1 {
		t.Fatalf("empty pushes in one cooldown: %d messages, want 1", n)
	}
}

// A character that logged out on the tile of a living object wakes up there, not at its
// temple: on the debris while the tile is free ground, and beside the object once it
// stands again, even one that hides what is behind it (placement, besideSolid). The areas
// were numbered with the object standing, so its tile is in none.
func TestLivingSavedOnAnObjectWakesThere(t *testing.T) {
	crate, boulder := pos(12, 1), pos(20, 1)
	h := livingHarness(t, worldtest.Map(t, 0, 0, 7,
		"T.......................",
		"........................",
		"........................",
	), map[world.Pos]uint16{crate: lwCrateID, boulder: lwBoulderID})
	m := h.w.Map()
	near := func(got, want world.Pos) bool {
		return got != want && m.Walkable(got) && max(dist(got.X, want.X), dist(got.Y, want.Y)) == 1
	}
	sleep := func(on world.Pos) world.Pos {
		t.Helper()
		nextChar++
		c := withPack(nextChar, on)
		cl, p := h.joinChar(c)
		got := p.Pos()
		h.leave(cl)
		return got
	}

	// Saved inside the standing crate: beside it.
	if got := sleep(crate); !near(got, crate) {
		t.Fatalf("saved on the standing crate %v, woke up at %v", crate, got)
	}

	cl, _ := armed(h, pos(11, 1), swordID)
	strike(h, cl, crate, lwCrateID)
	h.sim.RunTicks(2)
	strike(h, cl, crate, lwCrateID)
	h.leave(cl)
	if !m.Walkable(crate) {
		t.Fatal("the crate did not break")
	}
	// On its debris: the very tile.
	if got := sleep(crate); got != crate {
		t.Fatalf("saved on the crate's debris %v, woke up at %v", crate, got)
	}

	// The crate stands again (2 s of debris, 4 s more) and hides what is behind it.
	h.sim.RunTicks(200)
	if m.Walkable(crate) || m.LineOfSight(pos(11, 1), pos(13, 1)) {
		t.Fatal("the crate did not come back")
	}
	if got := sleep(crate); !near(got, crate) {
		t.Fatalf("saved on the crate that came back %v, woke up at %v", crate, got)
	}

	// The tile a pushed boulder left: the very tile.
	cl, _ = armed(h, pos(19, 1), 0)
	h.input(cl, push(boulder, E))
	h.sim.RunTicks(20)
	h.leave(cl)
	if !m.Walkable(boulder) {
		t.Fatal("the boulder was not pushed")
	}
	if got := sleep(boulder); got != boulder {
		t.Fatalf("saved where the boulder stood %v, woke up at %v", boulder, got)
	}
}
