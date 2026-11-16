package session_test

import (
	"path/filepath"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// ropeID is the rope of the portal tests (tool.use rope, like data/items/tools.yaml).
const ropeID = 86

const nw = pb.Direction_DIRECTION_NORTH_WEST

func at3(x, y, z int) world.Pos { return world.Pos{X: uint16(x), Y: uint16(y), Z: uint8(z)} }

// The portals of the tests, on two open floors of 14x8 (portalMap): stairs down and up
// next to each other, a hole, a ladder and a rope spot up from floor 8, a teleport and a
// boat portal on floor 7.
var (
	stairsDown = at3(5, 2, 7)
	stairsUp   = at3(5, 2, 8)
	hole       = at3(8, 2, 7)
	ladder     = at3(2, 5, 8)
	ropeSpot   = at3(10, 5, 8)
	teleport   = at3(12, 1, 7)
	boat       = at3(12, 6, 7)
)

func testPortals() []world.Portal {
	return []world.Portal{
		{ID: "down", Kind: world.PortalStairs, From: stairsDown, To: at3(5, 3, 8)},
		{ID: "up", Kind: world.PortalStairs, From: stairsUp, To: at3(5, 3, 7)},
		{ID: "pit", Kind: world.PortalHole, From: hole, To: at3(8, 2, 8)},
		{ID: "climb", Kind: world.PortalLadder, From: ladder, To: at3(2, 5, 7)},
		{ID: "rope", Kind: world.PortalRopeSpot, From: ropeSpot, To: at3(10, 5, 7)},
		{ID: "gate", Kind: world.PortalTeleport, From: teleport, To: at3(1, 6, 7)},
		{ID: "ferry", Kind: world.PortalBoat, From: boat, To: at3(12, 4, 7)},
	}
}

func portalMap(t *testing.T) *world.Map {
	t.Helper()
	rows := make([]string, 8)
	for i := range rows {
		rows[i] = ".............."
	}
	m := worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 7, Rows: rows}, worldtest.Layer{Z: 8, Rows: rows})
	return worldtest.WithPortals(t, m, testPortals()...)
}

// portalHarness runs portalMap with arrivals within radius (travel.arrival_radius), a rope
// and a pickaxe.
func portalHarness(t *testing.T, radius int) *harness {
	t.Helper()
	items := testItems()
	for n, src := range map[uint16]string{
		ropeID: "{id: rope, kind: tool, weight: 1450, tool: {use: rope}}",
		pickID: gatherItemDefs[pickID],
	} {
		var it content.Item
		if err := yaml.Unmarshal([]byte(src), &it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = n
		items[it.ID] = &it
	}
	return newHarness(t, portalMap(t), func(c *session.Config) {
		c.Items = items
		c.Balance.Travel.ArrivalRadius = radius
	})
}

// step waits for p's last step to end and walks one tile in d, returning what the client
// heard in that tick.
func (h *harness) step(cl *fakeClient, d pb.Direction) []*pb.ServerMessage {
	h.sim.RunFor(time.Second)
	cl.take()
	return h.send(cl, walk(d))
}

// landed checks that evs moved the player through a portal: its step (if any) and then
// a full view of the floor of to, where it stands now.
func landed(t *testing.T, p *session.Player, evs []*pb.ServerMessage, to world.Pos) {
	t.Helper()
	views := find(evs, (*pb.ServerMessage).GetFullMapView)
	if p.Pos() != to || len(views) != 1 {
		t.Fatalf("at %v with %d full views (%v), want %v", p.Pos(), len(views), kinds(evs), to)
	}
	floors := views[0].GetArea().GetFloors()
	if to.Z > 7 && (len(floors) != 1 || floors[0].GetZ() != uint32(to.Z)) {
		t.Fatalf("floors of the view under ground: %v", floors)
	}
	self := false
	for _, c := range views[0].GetArea().GetCreatures() {
		self = self || c.GetId() == p.ID()
	}
	if !self {
		t.Fatal("the full view does not hold the player")
	}
}

// Stairs: a step onto them takes the player to the other floor, next to the stairs back,
// and those who watched see it walk onto the stairs and vanish; those below see it come.
func TestStairsDownAndUp(t *testing.T) {
	h := portalHarness(t, 2)
	cl, p := h.join("Delver", at(5, 1))
	clUp, up := h.join("Watcher", at(5, 5))
	_, below := h.join("Miner", ptr(at3(7, 4, 8)))
	cl.take()
	clUp.take()

	evs := h.step(cl, S)
	if ms := moves(evs); len(ms) != 1 || ms[0].GetTo().GetY() != 2 || ms[0].GetTo().GetZ() != 7 {
		t.Fatalf("the step onto the stairs: %v", kinds(evs))
	}
	landed(t, p, evs, at3(5, 3, 8))
	seen := clUp.take()
	if len(moves(seen)) != 1 || len(find(seen, (*pb.ServerMessage).GetCreatureDisappear)) != 1 || up.Knows(p.ID()) {
		t.Fatalf("the watcher above: %v", kinds(seen))
	}
	if !below.Knows(p.ID()) || !p.Knows(below.ID()) {
		t.Fatal("the miner below and the delver do not see each other")
	}
	h.checkInvariants()

	// Back up: onto the stairs up, landing south of the stairs down (not on them).
	evs = h.step(cl, N)
	landed(t, p, evs, at3(5, 3, 7))
	if below.Knows(p.ID()) || !up.Knows(p.ID()) {
		t.Fatal("after climbing back the views did not follow")
	}
	h.checkInvariants()
}

// A taken destination: the player lands on the nearest free tile, never on the stairs
// back (a tile a portal leaves from on step); with no free tile within the radius the
// step is refused and nothing moves.
func TestStairsArrivalTaken(t *testing.T) {
	h := portalHarness(t, 2)
	h.join("Blocker", ptr(at3(5, 3, 8)))
	h.join("Blocker Two", ptr(at3(4, 2, 8)))
	cl, p := h.join("Delver", at(5, 1))
	// Ring 1 from 5,3,8 in scan order: 4,2 (taken), 5,2 (the stairs up), then 6,2.
	landed(t, p, h.step(cl, S), at3(6, 2, 8))
	h.checkInvariants()

	h = portalHarness(t, 0)
	h.join("Blocker", ptr(at3(5, 3, 8)))
	cl, p = h.join("Delver", at(5, 1))
	evs := h.step(cl, S)
	if p.Pos() != pos(5, 1) || !hasKey(evs, "portal.blocked") || len(find(evs, (*pb.ServerMessage).GetWalkRejected)) != 1 || len(moves(evs)) != 0 {
		t.Fatalf("a blocked arrival: at %v, %v", p.Pos(), systemKeys(evs))
	}
}

// A hole leads down one way: its destination below is a plain tile.
func TestHoleIsOneWay(t *testing.T) {
	h := portalHarness(t, 2)
	cl, p := h.join("Faller", at(8, 1))
	landed(t, p, h.step(cl, S), at3(8, 2, 8))
	h.step(cl, N)
	if evs := h.step(cl, S); p.Pos() != at3(8, 2, 8) || len(find(evs, (*pb.ServerMessage).GetFullMapView)) != 0 {
		t.Fatalf("stepping back onto the landing: at %v (%v)", p.Pos(), kinds(evs))
	}
}

// A teleport moves whoever steps onto it, on its own floor too; a boat portal moves
// nobody (boat travel is the captain's).
func TestTeleportAndBoatPortal(t *testing.T) {
	h := portalHarness(t, 2)
	cl, p := h.join("Wanderer", at(11, 1))
	landed(t, p, h.step(cl, E), pos(1, 6))

	cl, p = h.join("Sailor", at(11, 6))
	if evs := h.step(cl, E); p.Pos() != boat || len(find(evs, (*pb.ServerMessage).GetFullMapView)) != 0 {
		t.Fatalf("on the boat portal: at %v (%v)", p.Pos(), kinds(evs))
	}
}

// A ladder is used, not stepped on: from its tile or next to it, within reach, not in the
// middle of a step and with the item of the tile the client saw.
func TestLadderNeedsUse(t *testing.T) {
	h := portalHarness(t, 2)
	cl, p := h.join("Climber", ptr(at3(2, 4, 8)))
	use := useItem(onTile(ladder), worldtest.Grass, 0)
	if evs := h.step(cl, S); p.Pos() != ladder || len(find(evs, (*pb.ServerMessage).GetFullMapView)) != 0 {
		t.Fatalf("stepping onto the ladder: at %v (%v)", p.Pos(), kinds(evs))
	}
	h.step(cl, N)
	if evs := h.send(cl, use); p.Pos() != at3(2, 4, 8) || !hasKey(evs, "portal.not_ready") {
		t.Fatalf("a climb in the middle of a step: at %v, %v", p.Pos(), systemKeys(evs))
	}
	if evs := h.send(cl, useItem(onTile(ladder), worldtest.Road, 0)); !hasKey(evs, "inventory.not_possible") {
		t.Fatalf("another item than the tile's: %v", systemKeys(evs))
	}
	clFar, far := h.join("Onlooker", ptr(at3(2, 1, 8)))
	if evs := h.send(clFar, use); far.Pos() != at3(2, 1, 8) || !hasKey(evs, "inventory.too_far") {
		t.Fatalf("a climb from 4 tiles: at %v, %v", far.Pos(), systemKeys(evs))
	}
	h.sim.RunFor(time.Second)
	cl.take()
	landed(t, p, h.send(cl, use), at3(2, 5, 7))
	h.checkInvariants()
}

// A rope spot needs a rope used on it: bare it says so, another tool finds nothing there,
// too far it is refused.
func TestRopeSpotNeedsRope(t *testing.T) {
	h := portalHarness(t, 2)
	nextChar++
	c := withPack(nextChar, at3(10, 4, 8))
	c.Inventory = append(c.Inventory,
		session.ItemState{ItemID: ropeID, Count: 1, Slot: int(slotRight)},
		session.ItemState{ItemID: pickID, Count: 1, Slot: int(slotLeft)})
	cl, p := h.joinChar(c)
	cl.take()
	if evs := h.send(cl, useItem(onTile(ropeSpot), worldtest.Grass, 0)); p.Pos() != at3(10, 4, 8) || !hasKey(evs, "portal.need_rope") {
		t.Fatalf("a bare rope spot: at %v, %v", p.Pos(), systemKeys(evs))
	}
	pick := &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
		From: inSlot(slotLeft), ItemId: pickID,
		To: &pb.ActionTarget{Target: &pb.ActionTarget_Pos{Pos: &pb.Position{X: 10, Y: 5, Z: 8}}},
	}}}
	if evs := h.send(cl, pick); p.Pos() != at3(10, 4, 8) || !hasKey(evs, "gather.nothing") {
		t.Fatalf("a pickaxe on the rope spot: at %v, %v", p.Pos(), systemKeys(evs))
	}
	h.step(cl, N)
	h.step(cl, N)
	h.sim.RunFor(time.Second)
	cl.take()
	if evs := h.send(cl, useOn(ropeID, ropeSpot)); p.Pos() != at3(10, 2, 8) || !hasKey(evs, "inventory.too_far") {
		t.Fatalf("a rope from 3 tiles: at %v, %v", p.Pos(), systemKeys(evs))
	}
	h.step(cl, S)
	h.step(cl, S)
	h.sim.RunFor(time.Second)
	cl.take()
	landed(t, p, h.send(cl, useOn(ropeID, ropeSpot)), at3(10, 5, 7))
}

// An attacker under its PvP lock cannot reach a protection zone through a portal from
// outside one, like on foot.
func TestPortalKeepsLockedAttackersOutOfProtection(t *testing.T) {
	rows := make([]string, 8)
	for i := range rows {
		rows[i] = ".............."
	}
	m := worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 7, Rows: rows}, worldtest.Layer{Z: 8, Rows: rows})
	for _, s := range m.Islands()[0].Sectors() {
		if s.Z == 8 {
			for i := range s.Flags {
				s.Flags[i] |= world.FlagProtection
			}
		}
	}
	m = worldtest.WithPortals(t, m, testPortals()...)
	h := newHarness(t, m, func(c *session.Config) { c.Balance.Travel.ArrivalRadius = 2 })
	cl, p := h.join("Raider", at(5, 1))
	h.sim.Command(gameFunc(func() { h.w.SetAttackLockForTest(p, h.sim.Tick()+game.Tick(1000)) }))
	if evs := h.step(cl, S); p.Pos() != pos(5, 1) || !hasKey(evs, "pvp.protection_locked") {
		t.Fatalf("a locked attacker down the stairs: at %v, %v", p.Pos(), systemKeys(evs))
	}
	h.sim.Command(gameFunc(func() { h.w.SetAttackLockForTest(p, 0) }))
	landed(t, p, h.step(cl, S), at3(5, 3, 8))
}

// Monsters do not use portals: they never step onto stairs, a hole or a teleport, even
// when that is the only way to their target.
func TestMonstersKeepOffPortals(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"T.......",
		"########",
		"........",
		"########",
	)
	gateAt := pos(3, 2)
	m = worldtest.WithPortals(t, m, world.Portal{ID: "gate", Kind: world.PortalTeleport, From: gateAt, To: pos(0, 0)})
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 0, 2, 0, 60)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolfDef()}
		c.Items = testItems()
	})
	if h.w.MonsterCanEnterForTest(gateAt) || !h.w.MonsterCanEnterForTest(pos(4, 2)) {
		t.Fatal("a monster may stand on the teleport, or not next to it")
	}
	cl, p := h.join("Bait", at(6, 2))
	cl.take()
	for range 400 { // 20 s
		h.sim.Step()
		for _, w := range h.w.Monsters() {
			if w.Pos().X >= gateAt.X {
				t.Fatalf("tick %d: the wolf got to %v", h.sim.Tick(), w.Pos())
			}
		}
	}
	if len(h.w.Monsters()) != 1 || h.w.Monsters()[0].Pos() != pos(2, 2) || p.Pos() != pos(6, 2) {
		t.Fatalf("wolf at %v, bait at %v", h.w.Monsters()[0].Pos(), p.Pos())
	}
}

// The volcanic mine of the real map (world/islands/volcan): its stairs at 3692,5796 lead
// down to the mine on floor 8 and back up, so the mine and the forge behind its keyed gate
// are reachable on foot.
func TestVolcanicMineStairsOnTheMap(t *testing.T) {
	m, err := compile.Compile(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	h := dataHarnessWith(t, func(cfg *session.Config) {
		cfg.Map = m
		for _, is := range m.Islands() {
			is.Spawns = nil // no monsters: this is about the stairs
		}
	})
	cl, p := h.joinFresh(session.Character{ID: 9401, AccountID: 9401, Name: "Ember Delver", Vocation: "guardian",
		Level: 30, Health: 1000, Mana: 100, Town: "volcan"}, at3(3692, 5795, 7))
	landed(t, p, h.step(cl, S), at3(3692, 5797, 8))
	landed(t, p, h.step(cl, N), at3(3692, 5797, 7))
	// The mine stairs again, this time by the diagonal from the west.
	h.step(cl, W)
	landed(t, p, h.step(cl, pb.Direction_DIRECTION_NORTH_EAST), at3(3692, 5797, 8))
	h.step(cl, nw)
	if p.Pos() != at3(3691, 5796, 8) {
		t.Fatalf("a step on floor 8 next to the stairs: at %v", p.Pos())
	}
}

func ptr(p world.Pos) *world.Pos { return &p }
