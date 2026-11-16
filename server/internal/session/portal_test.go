package session_test

import (
	"path/filepath"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"
	"google.golang.org/protobuf/proto"

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
	return portalHarnessOn(t, portalMap(t), radius)
}

// protectedFloor makes every tile of floor z of m (one island) a protection zone.
func protectedFloor(m *world.Map, z uint8) *world.Map {
	for _, s := range m.Islands()[0].Sectors() {
		if s.Z == z {
			for i := range s.Flags {
				s.Flags[i] |= world.FlagProtection
			}
		}
	}
	return m
}

// portalHarnessOn is portalHarness on the map m.
func portalHarnessOn(t *testing.T, m *world.Map, radius int) *harness {
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
	return newHarness(t, m, func(c *session.Config) {
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
// a full view of the floor of to, where it stands now. No MapSlice: the edge of the floor
// it left would be thrown away by the full view.
func landed(t *testing.T, p *session.Player, evs []*pb.ServerMessage, to world.Pos) {
	t.Helper()
	views := find(evs, (*pb.ServerMessage).GetFullMapView)
	if p.Pos() != to || len(views) != 1 {
		t.Fatalf("at %v with %d full views (%v), want %v", p.Pos(), len(views), kinds(evs), to)
	}
	if n := len(find(evs, (*pb.ServerMessage).GetMapSlice)); n != 0 {
		t.Fatalf("%d map slices beside the full view (%v)", n, kinds(evs))
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

// A hole leads down: a step onto it from any side (a diagonal here) drops the player to
// the floor below, beside whoever stands under it; those above see it step onto the hole
// and vanish. That nothing leads back up is the map's rule (world.NewMap refuses a hole
// that goes up, the "hole up" case of world/portal_test.go), not the session's.
func TestHoleDropsBesideWhoeverIsUnder(t *testing.T) {
	h := portalHarness(t, 2)
	_, under := h.join("Under", ptr(at3(8, 2, 8)))
	clUp, up := h.join("Watcher", at(10, 4))
	cl, p := h.join("Faller", at(9, 1))
	clUp.take()
	// Ring 1 from 8,2,8 in scan order: 7,1 is the first free tile.
	landed(t, p, h.step(cl, sw), at3(7, 1, 8))
	seen := clUp.take()
	if len(moves(seen)) != 1 || len(find(seen, (*pb.ServerMessage).GetCreatureDisappear)) != 1 || up.Knows(p.ID()) {
		t.Fatalf("the watcher above: %v", kinds(seen))
	}
	if !under.Knows(p.ID()) {
		t.Fatal("the one under the hole does not see the faller")
	}
	h.checkInvariants()
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

// A ladder climbs from its own tile too, and whatever lies on it does not hide it: the
// UseItem of its ground (stack index 0, what the client sends for a ladder) climbs; the
// UseItem of the coins on top uses the coins.
func TestLadderFromItsTileUnderCoins(t *testing.T) {
	h := portalHarness(t, 2)
	cl, p := h.join("Climber", ptr(ladder))
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("copper_coin"), 3, ladder) }))
	h.sim.RunFor(time.Second)
	cl.take()
	if evs := h.send(cl, useItem(onTile(ladder), coinID, 1)); p.Pos() != ladder || len(find(evs, (*pb.ServerMessage).GetFullMapView)) != 0 {
		t.Fatalf("using the coins on the ladder: at %v (%v)", p.Pos(), kinds(evs))
	}
	landed(t, p, h.send(cl, useItem(onTile(ladder), worldtest.Grass, 0)), at3(2, 5, 7))
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
	if evs := h.step(cl, S); p.Pos() != at3(10, 4, 8) || len(moves(evs)) != 1 {
		t.Fatalf("the step back next to the rope spot: at %v (%v)", p.Pos(), kinds(evs))
	}
	if evs := h.send(cl, useOn(ropeID, ropeSpot)); p.Pos() != at3(10, 4, 8) || !hasKey(evs, "portal.not_ready") {
		t.Fatalf("a rope in the middle of a step: at %v, %v", p.Pos(), systemKeys(evs))
	}
	h.sim.RunFor(time.Second)
	cl.take()
	landed(t, p, h.send(cl, useOn(ropeID, ropeSpot)), at3(10, 5, 7))
}

// An attacker under its PvP lock cannot reach a protection zone through a portal from
// outside one, like on foot: not down the stairs, not up a ladder or a rope.
func TestPortalKeepsLockedAttackersOutOfProtection(t *testing.T) {
	h := portalHarnessOn(t, protectedFloor(portalMap(t), 8), 2)
	lock := func(p *session.Player, on bool) {
		h.sim.Command(gameFunc(func() {
			until := game.Tick(0)
			if on {
				until = h.sim.Tick() + game.Tick(1000)
			}
			h.w.SetAttackLockForTest(p, until)
		}))
	}
	cl, p := h.join("Raider", at(5, 1))
	lock(p, true)
	if evs := h.step(cl, S); p.Pos() != pos(5, 1) || !hasKey(evs, "pvp.protection_locked") {
		t.Fatalf("a locked attacker down the stairs: at %v, %v", p.Pos(), systemKeys(evs))
	}
	lock(p, false)
	landed(t, p, h.step(cl, S), at3(5, 3, 8))

	// Up: floor 7 is the protection zone now.
	h = portalHarnessOn(t, protectedFloor(portalMap(t), 7), 2)
	nextChar++
	c := withPack(nextChar, at3(2, 4, 8))
	c.Name = "Climbing Raider"
	c.Inventory = append(c.Inventory, session.ItemState{ItemID: ropeID, Count: 1, Slot: int(slotRight)})
	cl, p = h.joinChar(c)
	lock(p, true)
	h.sim.RunFor(time.Second)
	cl.take()
	if evs := h.send(cl, useItem(onTile(ladder), worldtest.Grass, 0)); p.Pos() != at3(2, 4, 8) || !hasKey(evs, "pvp.protection_locked") {
		t.Fatalf("a locked attacker up the ladder: at %v, %v", p.Pos(), systemKeys(evs))
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, at3(10, 4, 8)) }))
	h.sim.RunFor(time.Second)
	cl.take()
	if evs := h.send(cl, useOn(ropeID, ropeSpot)); p.Pos() != at3(10, 4, 8) || !hasKey(evs, "pvp.protection_locked") {
		t.Fatalf("a locked attacker up the rope: at %v, %v", p.Pos(), systemKeys(evs))
	}
	lock(p, false)
	h.sim.RunFor(time.Second)
	cl.take()
	landed(t, p, h.send(cl, useOn(ropeID, ropeSpot)), at3(10, 5, 7))
}

// A walk path blocked by a creature is searched again around creatures and around stairs,
// holes and teleports: with the only way round over a teleport, the walk stops there.
func TestRerouteKeepsOffPortals(t *testing.T) {
	gate := world.Portal{ID: "gate", Kind: world.PortalTeleport, From: pos(2, 0), To: pos(4, 0)}
	m := worldtest.WithPortals(t, worldtest.Map(t, 0, 0, 7,
		"T....",
		".....",
		"#####",
	), gate)
	h := newHarness(t, m)
	h.join("Blocker", at(2, 1))
	cl, p := h.join("Walker", at(1, 1))
	cl.take()
	evs := h.send(cl, walkPath(E, E, E))
	h.sim.RunFor(time.Second)
	evs = append(evs, cl.take()...)
	if p.Pos() != pos(1, 1) || len(find(evs, (*pb.ServerMessage).GetWalkRejected)) != 1 || len(find(evs, (*pb.ServerMessage).GetFullMapView)) != 0 {
		t.Fatalf("the walk round the blocker: at %v (%v)", p.Pos(), kinds(evs))
	}
	// The same walk with a free way round below: it goes round the blocker on foot.
	m = worldtest.WithPortals(t, worldtest.Map(t, 0, 0, 7,
		"T....",
		".....",
		".....",
	), gate)
	h = newHarness(t, m)
	h.join("Blocker", at(2, 1))
	cl, p = h.join("Walker", at(1, 1))
	h.send(cl, walkPath(E, E, E))
	h.sim.RunFor(3 * time.Second)
	if p.Pos() != pos(4, 1) {
		t.Fatalf("the walk round the blocker below: at %v", p.Pos())
	}
}

// Monsters never appear on stairs, a hole or a teleport: a spawn whose only other tile
// is a teleport keeps one wolf of its two.
func TestSpawnKeepsOffPortals(t *testing.T) {
	m := worldtest.WithPortals(t, worldtest.Map(t, 0, 0, 7,
		"T#####",
		"##..##",
		"######",
	), world.Portal{ID: "gate", Kind: world.PortalTeleport, From: pos(3, 1), To: pos(0, 0)})
	m.Islands()[0].Spawns = []world.Spawn{{ID: "den", Center: pos(2, 1), Radius: 1, RespawnSeconds: 60,
		Monsters: []world.SpawnMonster{{Monster: "wolf", Count: 2}}}}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolfDef()}
		c.Items = testItems()
	})
	h.join("Bait", nil)
	h.sim.RunFor(10 * time.Second)
	if ms := h.w.Monsters(); len(ms) != 1 || ms[0].Pos() != pos(2, 1) {
		t.Fatalf("%d monsters (%v)", len(ms), ms)
	}
}

// A character saved on stairs (before the server loaded portals) is never put back on
// them: on a free tile beside them, or, with every tile around taken, at its temple.
func TestLoginOffTheStairs(t *testing.T) {
	m := worldtest.WithPortals(t, worldtest.Map(t, 0, 0, 7, "T."),
		world.Portal{ID: "gate", Kind: world.PortalTeleport, From: pos(1, 0), To: pos(0, 0)})
	h := newHarness(t, m)
	_, first := h.join("Early", at(1, 0))
	if first.Pos() != pos(0, 0) {
		t.Fatalf("a login on the teleport: at %v", first.Pos())
	}
	_, p := h.join("Late", at(1, 0))
	if p.Pos() != pos(0, 0) {
		t.Fatalf("a crowded login on the teleport: at %v", p.Pos())
	}
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
// are reachable on foot. Going up and down without end costs a FullMapView a step: what
// the client receives stays within docs/07's 4 KB/s a player.
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

	// Up and down for good: east onto the stairs up, then north onto each stairs.
	h.sim.RunFor(time.Second)
	cl.take()
	start, bytes, trips := h.sim.Tick(), 0, 0
	h.input(cl, walk(E))
	for range 400 { // 20 s
		h.sim.Step()
		for _, e := range cl.take() {
			bytes += proto.Size(e)
			if e.GetFullMapView() != nil {
				trips++
				h.input(cl, walk(N)) // queued: it runs when the step ends
			}
		}
	}
	rate := float64(bytes) / (float64(h.sim.Tick()-start) * game.TickDuration.Seconds())
	t.Logf("%d trips in 20 s, %d bytes: %.0f B/s", trips, bytes, rate)
	if trips < 20 || rate > 4096 {
		t.Fatalf("%d trips in 20 s at %.0f B/s", trips, rate)
	}
}

// A step onto stairs always ends on the other floor: the step skips the view of the floor
// it leaves, so the landing does not depend on Teleport's check that the player is still
// listed (stepPlayer only walks players of the world).
func TestStairsStepAlwaysLands(t *testing.T) {
	h := portalHarness(t, 2)
	cl, p := h.join("Delver", at(4, 1))
	h.sim.RunFor(time.Second)
	cl.take()
	h.send(cl, walkPath(E, S)) // 5,1, then the stairs at 5,2
	if p.Pos() != pos(5, 1) {
		t.Fatalf("the first step: at %v", p.Pos())
	}
	h.sim.Command(gameFunc(func() { h.w.UnlistForTest(p) }))
	h.sim.RunFor(time.Second)
	if p.Pos() != at3(5, 3, 8) {
		t.Fatalf("after the step onto the stairs: at %v, want 5,3,8", p.Pos())
	}
	h.sim.Command(gameFunc(func() { h.w.RelistForTest(p) }))
	h.sim.Step()
	h.checkInvariants()
}

// With a reach above 1 (inventory.reach), a ladder or a rope spot across a wall is out of
// sight, as for gathering: the climb is refused.
func TestLadderAndRopeNeedSight(t *testing.T) {
	rows := []string{
		"T.#..",
		"..#..",
		".....",
	}
	m := worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 7, Rows: rows}, worldtest.Layer{Z: 8, Rows: rows})
	m = worldtest.WithPortals(t, m,
		world.Portal{ID: "climb", Kind: world.PortalLadder, From: at3(3, 0, 8), To: at3(3, 0, 7)},
		world.Portal{ID: "rope", Kind: world.PortalRopeSpot, From: at3(3, 1, 8), To: at3(3, 1, 7)})
	items := testItems()
	var rope content.Item
	if err := yaml.Unmarshal([]byte("{id: rope, kind: tool, weight: 1450, tool: {use: rope}}"), &rope); err != nil {
		t.Fatal(err)
	}
	rope.Numeric = ropeID
	items[rope.ID] = &rope
	h := newHarness(t, m, func(c *session.Config) {
		c.Items = items
		c.Balance.Inventory.Reach = 2
		c.Balance.Travel.ArrivalRadius = 1
	})
	nextChar++
	c := withPack(nextChar, at3(1, 0, 8))
	c.Inventory = append(c.Inventory, session.ItemState{ItemID: ropeID, Count: 1, Slot: int(slotRight)})
	cl, p := h.joinChar(c)
	h.sim.RunFor(time.Second)
	cl.take()
	if evs := h.send(cl, useItem(onTile(at3(3, 0, 8)), worldtest.Grass, 0)); p.Pos() != at3(1, 0, 8) || !hasKey(evs, "magic.no_sight") {
		t.Fatalf("the ladder across the wall: at %v, %v", p.Pos(), systemKeys(evs))
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, at3(1, 1, 8)) }))
	h.sim.RunFor(time.Second)
	cl.take()
	if evs := h.send(cl, useOn(ropeID, at3(3, 1, 8))); p.Pos() != at3(1, 1, 8) || !hasKey(evs, "magic.no_sight") {
		t.Fatalf("the rope across the wall: at %v, %v", p.Pos(), systemKeys(evs))
	}
	// Round the wall, two tiles away and in sight: both climb.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, at3(3, 2, 8)) }))
	h.sim.RunFor(time.Second)
	cl.take()
	landed(t, p, h.send(cl, useOn(ropeID, at3(3, 1, 8))), at3(3, 1, 7))
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, at3(4, 2, 8)) }))
	h.sim.RunFor(time.Second)
	cl.take()
	landed(t, p, h.send(cl, useItem(onTile(at3(3, 0, 8)), worldtest.Grass, 0)), at3(3, 0, 7))
	h.checkInvariants()
}

func ptr(p world.Pos) *world.Pos { return &p }
