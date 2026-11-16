package session_test

import (
	"bytes"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Items and portals (docs/02 "Cambiar de piso"): what is dropped onto stairs, a hole or a
// teleport falls through to the other end; on a ladder or a rope spot it stays. And every
// portal should stand under the item that shows it (initPortals).

// thrower joins a character named name at p with a backpack holding pack, opens the
// backpack and returns its window id.
func (h *harness) thrower(name string, id int64, p world.Pos, pack ...session.ItemState) (*fakeClient, *session.Player, uint32) {
	h.t.Helper()
	c := withPack(id, p, pack...)
	c.Name = name
	cl, pl := h.joinChar(c)
	w := openPack(h.t, h, cl)
	cl.take()
	return cl, pl, w
}

// fill puts n swords (they do not stack: n items) on the ground at p.
func (h *harness) fill(p world.Pos, n int) {
	h.sim.Command(gameFunc(func() {
		for range n {
			h.w.DropForTest(h.w.ItemForTest("test_sword"), 1, p)
		}
	}))
	h.sim.Step()
}

// counts returns the item ids and counts of the ground items at p, bottom first.
func (h *harness) counts(p world.Pos) [][2]int {
	var out [][2]int
	for _, it := range h.w.GroundAt(p) {
		out = append(out, [2]int{int(it.Def().Numeric), it.Count()})
	}
	return out
}

// Coins dropped onto the stairs fall to where the stairs lead (beside the stairs back),
// join the pile there, and a sword pushed from the next tile follows them: who watches
// the tile it left sees it go, who watches below sees it land, and the stairs keep no
// item. The thrower hears nothing: it was a drop.
func TestItemsFallDownStairs(t *testing.T) {
	h := portalHarness(t, 2)
	cl, p, pack := h.thrower("Thrower", 9501, pos(5, 1), stack(coinID, 10, 0))
	clAbove, _ := h.join("Watcher", at(6, 1))
	clBelow, _ := h.join("Miner", ptr(at3(7, 4, 8)))
	h.fill(pos(4, 1), 1) // a sword next to the thrower
	cl.take()
	clAbove.take()
	clBelow.take()
	landing := at3(5, 3, 8)

	evs := h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(stairsDown), 4))
	if len(systemKeys(evs)) != 0 || !slices.Equal(h.counts(landing), [][2]int{{coinID, 4}}) ||
		len(h.w.GroundAt(stairsDown)) != 0 || h.w.CountItem(p, "copper_coin") != 6 {
		t.Fatalf("4 coins onto the stairs: %v, below %v, on the stairs %d, carried %d",
			systemKeys(evs), h.counts(landing), len(h.w.GroundAt(stairsDown)), h.w.CountItem(p, "copper_coin"))
	}
	if len(find(evs, (*pb.ServerMessage).GetContainerUpdate)) != 1 || len(find(evs, (*pb.ServerMessage).GetTileUpdate)) != 0 {
		t.Fatalf("the thrower got %v", kinds(evs))
	}
	if got := tileOf(clBelow.take(), landing); !slices.Equal(got, []uint32{worldtest.Grass, coinID}) {
		t.Fatalf("the miner below sees %v", got)
	}
	if len(find(clAbove.take(), (*pb.ServerMessage).GetTileUpdate)) != 0 {
		t.Fatal("the watcher above saw a tile change")
	}

	h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(stairsDown), 3))
	if got := h.counts(landing); !slices.Equal(got, [][2]int{{coinID, 7}}) {
		t.Fatalf("3 more coins: below %v", got)
	}
	clBelow.take()

	// The sword lies on (4,1,7) above the static ground (stack index 1).
	evs = h.send(cl, moveItem(onTile(pos(4, 1)), swordID, 1, onTile(stairsDown), 1))
	if len(h.w.GroundAt(pos(4, 1))) != 0 || !slices.Equal(h.counts(landing), [][2]int{{coinID, 7}, {swordID, 1}}) {
		t.Fatalf("the sword: left %d, below %v (%v)", len(h.w.GroundAt(pos(4, 1))), h.counts(landing), systemKeys(evs))
	}
	if got := tileOf(evs, pos(4, 1)); !slices.Equal(got, []uint32{worldtest.Grass}) {
		t.Fatalf("the thrower sees the tile it left as %v", got)
	}
	if got := tileOf(clAbove.take(), pos(4, 1)); !slices.Equal(got, []uint32{worldtest.Grass}) {
		t.Fatalf("the watcher above sees the tile it left as %v", got)
	}
	if got := tileOf(clBelow.take(), landing); !slices.Equal(got, []uint32{worldtest.Grass, coinID, swordID}) {
		t.Fatalf("the miner below sees %v", got)
	}
	h.checkInvariants()
}

// A hole and a teleport (on its own floor) take what falls in too; a ladder and a rope
// spot are used by hand: what is dropped there stays.
func TestItemsFallThroughHolesAndTeleportsNotLadders(t *testing.T) {
	h := portalHarness(t, 2)
	cl, _, pack := h.thrower("Digger", 9511, pos(9, 1), stack(coinID, 10, 0))
	h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(hole), 2))
	if got := h.counts(at3(8, 2, 8)); !slices.Equal(got, [][2]int{{coinID, 2}}) || len(h.w.GroundAt(hole)) != 0 {
		t.Fatalf("into the hole: below %v", got)
	}
	cl, _, pack = h.thrower("Mage", 9512, pos(11, 2), stack(coinID, 10, 0))
	h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(teleport), 2))
	if got := h.counts(pos(1, 6)); !slices.Equal(got, [][2]int{{coinID, 2}}) || len(h.w.GroundAt(teleport)) != 0 {
		t.Fatalf("into the teleport: at its end %v", got)
	}
	cl, _, pack = h.thrower("Climber", 9513, at3(3, 5, 8), stack(coinID, 10, 0))
	h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(ladder), 2))
	if got := h.counts(ladder); !slices.Equal(got, [][2]int{{coinID, 2}}) || len(h.w.GroundAt(at3(2, 5, 7))) != 0 {
		t.Fatalf("onto the ladder: on it %v", got)
	}
	cl, _, pack = h.thrower("Roper", 9514, at3(9, 5, 8), stack(coinID, 10, 0))
	h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(ropeSpot), 2))
	if got := h.counts(ropeSpot); !slices.Equal(got, [][2]int{{coinID, 2}}) || len(h.w.GroundAt(at3(10, 5, 7))) != 0 {
		t.Fatalf("onto the rope spot: on it %v", got)
	}
	h.checkInvariants()
}

// A destination with no room (maxGroundItems different items) passes what falls to the
// nearest tile with room within travel.arrival_radius, never onto the stairs back; a pile
// it joins is room enough. With no room within the radius the drop is refused and nothing
// moves.
func TestItemFallFindsRoom(t *testing.T) {
	landing := at3(5, 3, 8)
	h := portalHarness(t, 2)
	cl, _, pack := h.thrower("Thrower", 9521, pos(5, 1), stack(coinID, 10, 0))
	h.fill(landing, 20)
	h.fill(at3(4, 2, 8), 20)
	h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(stairsDown), 4))
	// Ring 1 from 5,3,8 in scan order: 4,2 (full), then 5,2, the stairs up (never: it
	// would fall again), then 6,2.
	if got := h.counts(at3(6, 2, 8)); !slices.Equal(got, [][2]int{{coinID, 4}}) || len(h.w.GroundAt(stairsUp)) != 0 ||
		len(h.w.GroundAt(landing)) != 20 || len(h.w.GroundAt(at3(4, 2, 8))) != 20 {
		t.Fatalf("a full destination: on 6,2,8 %v, on the stairs up %d", got, len(h.w.GroundAt(stairsUp)))
	}

	h = portalHarness(t, 0)
	cl, p, pack := h.thrower("Thrower", 9522, pos(5, 1), stack(coinID, 10, 0))
	h.fill(landing, 20)
	evs := h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(stairsDown), 4))
	if !hasKey(evs, "portal.no_room") || h.w.CountItem(p, "copper_coin") != 10 || len(h.w.GroundAt(landing)) != 20 {
		t.Fatalf("no room: %v, carried %d", systemKeys(evs), h.w.CountItem(p, "copper_coin"))
	}
	// 19 swords and a pile of coins: the coins join the pile.
	h = portalHarness(t, 0)
	cl, p, pack = h.thrower("Thrower", 9523, pos(5, 1), stack(coinID, 10, 0))
	h.fill(landing, 19)
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("copper_coin"), 5, landing) }))
	h.sim.Step()
	evs = h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(stairsDown), 4))
	g := h.w.GroundAt(landing)
	if len(systemKeys(evs)) != 0 || len(g) != 20 || g[19].Count() != 9 || h.w.CountItem(p, "copper_coin") != 6 {
		t.Fatalf("onto a pile on a full tile: %v, %d items, top %d", systemKeys(evs), len(g), g[19].Count())
	}
	h.checkInvariants()
}

// What falls never lands in a house nor in the room behind a locked door, whatever the
// order of the rings (the rules of a player's arrival, TestPortalArrivalSkipsHousesAndRooms):
// with the destination and (7,2) full, ring 1 offers the house tile (6,2) first and ring 2
// the room tile (4,1); the coins land on (6,1), the next tile of the street with room.
// Onto a ladder (used by hand) nothing falls.
func TestItemFallSkipsHousesAndRooms(t *testing.T) {
	house, room, street := at3(6, 2, 8), at3(4, 1, 8), at3(6, 1, 8)
	h := arrivalHarness(t, world.PortalStairs)
	cl, _, pack := h.thrower("Thrower", 9531, at3(6, 1, 7), stack(coinID, 10, 0))
	h.fill(at3(6, 3, 8), 20)
	h.fill(at3(7, 2, 8), 20)
	evs := h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(at3(6, 2, 7)), 4))
	if got := h.counts(street); !slices.Equal(got, [][2]int{{coinID, 4}}) || len(h.w.GroundAt(house)) != 0 || len(h.w.GroundAt(room)) != 0 {
		t.Fatalf("on the street %v, house %d, room %d (%v)", got, len(h.w.GroundAt(house)), len(h.w.GroundAt(room)), systemKeys(evs))
	}

	h = arrivalHarness(t, world.PortalLadder)
	cl, _, pack = h.thrower("Thrower", 9532, at3(6, 1, 7), stack(coinID, 10, 0))
	h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(at3(6, 2, 7)), 4))
	if got := h.counts(at3(6, 2, 7)); !slices.Equal(got, [][2]int{{coinID, 4}}) || len(h.w.GroundAt(at3(6, 3, 8))) != 0 {
		t.Fatalf("onto the ladder: on it %v", got)
	}
}

// The transfer hold (hold.go): a held player drops nothing through stairs either, as on
// any tile of the public ground, until the database confirms its transfer. What falls
// never joins a pile reserved to another player: it lands as a pile of its own.
func TestItemFallKeepsTheHold(t *testing.T) {
	landing := at3(5, 3, 8)
	h := portalHarness(t, 2)
	cl, p, pack := h.thrower("Buyer", 9541, pos(5, 1), stack(coinID, 10, 0))
	_, other := h.join("Other", ptr(at3(7, 4, 8)))
	h.sim.Command(gameFunc(func() {
		h.w.DropForTest(h.w.ItemForTest("copper_coin"), 5, landing)
		h.w.ReserveForTest(h.w.GroundAt(landing)[0], other, 1<<40)
		h.w.HoldForTest(p, 1<<40)
	}))
	h.sim.Step()
	drop := moveItem(inContainer(pack, 0), coinID, 0, onTile(stairsDown), 4)
	evs := h.send(cl, drop)
	if !hasKey(evs, "inventory.saving") || h.w.CountItem(p, "copper_coin") != 10 || !slices.Equal(h.counts(landing), [][2]int{{coinID, 5}}) {
		t.Fatalf("a held player dropped through the stairs: %v, carried %d, below %v",
			systemKeys(evs), h.w.CountItem(p, "copper_coin"), h.counts(landing))
	}
	h.sim.Command(h.w.Saved(p.CharacterID(), 1<<40))
	h.sim.Step()
	evs = h.send(cl, drop)
	g := h.w.GroundAt(landing)
	if len(systemKeys(evs)) != 0 || !slices.Equal(h.counts(landing), [][2]int{{coinID, 5}, {coinID, 4}}) ||
		h.w.ReservedTo(g[0]) != other.CharacterID() || h.w.ReservedTo(g[1]) != 0 {
		t.Fatalf("after the ack: %v, below %v", systemKeys(evs), h.counts(landing))
	}
	h.checkInvariants()
}

// A bag with its window open, dropped down the stairs from the backpack: it lands below
// with what it holds, its window closes (it is on another floor now: closeUnreachable),
// and that window moves nothing more out of it.
func TestBagFallsWithItsWindowClosed(t *testing.T) {
	landing := at3(5, 3, 8)
	h := portalHarness(t, 2)
	bag := session.ItemState{ItemID: bagID, Count: 1, Items: []session.ItemState{stack(coinID, 5, 0)}}
	cl, p, pack := h.thrower("Thrower", 9551, pos(5, 1), bag)
	h.input(cl, useItem(inContainer(pack, 0), bagID, 0))
	h.sim.Step()
	opens := find(cl.take(), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 || opens[0].GetItemId() != bagID {
		t.Fatalf("opening the bag: %v", opens)
	}
	window := opens[0].GetContainerId()

	evs := h.send(cl, moveItem(inContainer(pack, 0), bagID, 0, onTile(stairsDown), 1))
	g := h.w.GroundAt(landing)
	if len(systemKeys(evs)) != 0 || len(g) != 1 || g[0].Def().Numeric != bagID || len(g[0].Items()) != 1 ||
		g[0].Items()[0].Count() != 5 || g[0].Viewers() != 0 {
		t.Fatalf("the bag down the stairs: %v, below %v", systemKeys(evs), h.counts(landing))
	}
	closes := find(evs, (*pb.ServerMessage).GetContainerClose)
	if len(closes) != 1 || closes[0].GetContainerId() != window {
		t.Fatalf("the bag's window: closes %v (%v)", closes, kinds(evs))
	}
	evs = h.send(cl, moveItem(inContainer(window, 0), coinID, 0, inContainer(pack, 0), 5))
	if !hasKey(evs, "inventory.not_possible") || h.w.CountItem(p, "copper_coin") != 0 || g[0].Items()[0].Count() != 5 {
		t.Fatalf("coins out of the closed window: %v, carried %d", systemKeys(evs), h.w.CountItem(p, "copper_coin"))
	}
	h.checkInvariants()
}

// The cottage of houseMap with stairs by its door (4,5) down to (4,5,8) on an open floor
// below, an arrival radius of 1, and its owner Ana standing on the door with a backpack
// holding pack (its window id is returned).
func cellarHarness(t *testing.T, pack ...session.ItemState) (*houseHarness, *fakeClient, *session.Player, uint32) {
	t.Helper()
	under := make([]string, len(houseMap))
	for i := range under {
		under[i] = ".........."
	}
	m := worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 7, Rows: houseMap}, worldtest.Layer{Z: 8, Rows: under})
	m = worldtest.WithHouses(t, m, testHouses()...)
	m = worldtest.WithPortals(t, m, world.Portal{ID: "cellar", Kind: world.PortalStairs, From: cellarStairs, To: cellarLanding})
	h := newHouseHarnessOn(t, m, func(c *session.Config) { c.Balance.Travel.ArrivalRadius = 1 })
	cl, a := h.tenant("Ana", 0, cottageExit, pack...)
	h.rent(cl)
	h.step(cl, N) // onto the door, a house tile next to the stairs
	return h, cl, a, openPack(t, h.harness, cl)
}

// The stairs of cellarHarness and where they lead.
var cellarStairs, cellarLanding = pos(4, 5), at3(4, 5, 8)

// What the owner takes out of its house through the stairs by its door is reserved to it
// where it lands, like anything that leaves a house for the public ground (leftHouse).
func TestItemFallFromAHouse(t *testing.T) {
	stairs, landing := cellarStairs, cellarLanding
	h, cl, a, pack := cellarHarness(t, stack(swordID, 1, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.send(cl, moveItem(inContainer(pack, 0), swordID, 0, onTile(pos(3, 3)), 1))
	if len(h.w.GroundAt(pos(3, 3))) != 1 {
		t.Fatal("the sword is not on the house floor")
	}
	evs := h.send(cl, moveItem(onTile(pos(3, 3)), swordID, 1, onTile(stairs), 1))
	g := h.w.GroundAt(landing)
	if len(systemKeys(evs)) != 0 || len(g) != 1 || g[0].Def().Numeric != swordID || len(h.w.GroundAt(pos(3, 3))) != 0 {
		t.Fatalf("out of the house through the stairs: %v, below %d", systemKeys(evs), len(g))
	}
	if h.w.ReservedTo(g[0]) != a.CharacterID() {
		t.Fatalf("the sword below is reserved to %d, want the owner %d", h.w.ReservedTo(g[0]), a.CharacterID())
	}
	h.checkInvariants()
}

// Coins the owner takes out of its house through the stairs land as a pile of their own,
// reserved to it: never in a public pile of coins on the landing (a reservation must not
// take over a stranger's pile), but in the owner's own reserved pile there. A player
// standing on the landing changes nothing (an item lies under a creature: fallTo). With
// the landing full (19 swords and that public pile) they land on the next tile of ring 1
// in scan order, (3,4,8), not in the public pile.
func TestCoinsFallFromAHouseAsTheirOwnPile(t *testing.T) {
	floor, landing := pos(3, 3), cellarLanding
	h, cl, a, pack := cellarHarness(t, stack(coinID, 100, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	_, bob := h.join("Bob", ptr(landing))
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("copper_coin"), 5, landing) }))
	h.sim.Step()
	down := func(n uint32) []*pb.ServerMessage {
		h.send(cl, moveItem(inContainer(pack, 0), coinID, 0, onTile(floor), n))
		if got := h.counts(floor); !slices.Equal(got, [][2]int{{coinID, int(n)}}) {
			t.Fatalf("on the house floor %v, want %d coins", got, n)
		}
		return h.send(cl, moveItem(onTile(floor), coinID, 1, onTile(cellarStairs), n))
	}
	evs := down(30)
	g := h.w.GroundAt(landing)
	if len(systemKeys(evs)) != 0 || !slices.Equal(h.counts(landing), [][2]int{{coinID, 5}, {coinID, 30}}) ||
		h.w.ReservedTo(g[0]) != 0 || h.w.ReservedTo(g[1]) != a.CharacterID() {
		t.Fatalf("out of the house onto a public pile: %v, below %v", systemKeys(evs), h.counts(landing))
	}
	if bob.Pos() != landing {
		t.Fatalf("Bob moved to %v", bob.Pos())
	}
	evs = down(10)
	if g = h.w.GroundAt(landing); len(systemKeys(evs)) != 0 ||
		!slices.Equal(h.counts(landing), [][2]int{{coinID, 5}, {coinID, 40}}) || h.w.ReservedTo(g[1]) != a.CharacterID() {
		t.Fatalf("onto the owner's reserved pile: %v, below %v", systemKeys(evs), h.counts(landing))
	}
	h.checkInvariants()

	next := at3(3, 4, 8)
	h, cl, a, pack = cellarHarness(t, stack(coinID, 100, 0), stack(coinID, 100, 1), stack(coinID, 100, 2))
	h.fill(landing, 19)
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("copper_coin"), 5, landing) }))
	h.sim.Step()
	evs = down(30)
	g = h.w.GroundAt(next)
	if len(systemKeys(evs)) != 0 || !slices.Equal(h.counts(next), [][2]int{{coinID, 30}}) ||
		h.w.ReservedTo(g[0]) != a.CharacterID() || len(h.w.GroundAt(landing)) != 20 ||
		h.w.GroundAt(landing)[19].Count() != 5 {
		t.Fatalf("onto a full landing: %v, on %v %v, landing %v", systemKeys(evs), next, h.counts(next), h.counts(landing))
	}
	h.checkInvariants()
}

// Numeric ids of the portal looks of TestPortalWithoutItemWarns.
const (
	stairsLookID = 180
	holeLookID   = 181
)

// A portal (but a boat) whose entrance holds no item that shows it is logged as a
// warning when the World starts: the stairs down with their item and the hole with its
// own are fine; the stairs up wear the item of stairs leading down (the wrong way), and
// the ladder, the rope spot and the teleport have none.
func TestPortalWithoutItemWarns(t *testing.T) {
	rows := make([]string, 8)
	for i := range rows {
		rows[i] = ".............."
	}
	m := worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 7, Rows: rows}, worldtest.Layer{Z: 8, Rows: rows})
	worldtest.SetTile(t, m, stairsDown, worldtest.Grass, 0, stairsLookID)
	worldtest.SetTile(t, m, stairsUp, worldtest.Grass, 0, stairsLookID)
	worldtest.SetTile(t, m, hole, worldtest.Grass, 0, holeLookID)
	m = worldtest.WithPortals(t, m, testPortals()...)
	items := testItems()
	for n, src := range map[uint16]string{
		stairsLookID: "{id: test_stairs_down, kind: decoration, pickupable: false, portal: {kind: stairs, leads: down}}",
		holeLookID:   "{id: test_hole, kind: decoration, pickupable: false, portal: {kind: hole}}",
	} {
		var it content.Item
		if err := yaml.Unmarshal([]byte(src), &it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = n
		items[it.ID] = &it
	}
	var logged bytes.Buffer
	newHarness(t, m, logTo(&logged), func(c *session.Config) { c.Items = items })
	var warned []string
	for _, line := range strings.Split(logged.String(), "\n") {
		if !strings.Contains(line, "portal without the item that shows it") {
			continue
		}
		_, rest, _ := strings.Cut(line, "portal=")
		id, _, _ := strings.Cut(rest, " ")
		warned = append(warned, id)
	}
	slices.Sort(warned)
	if want := []string{"climb", "gate", "rope", "up"}; !slices.Equal(warned, want) {
		t.Fatalf("warned about %v, want %v\n%s", warned, want, logged.String())
	}
}
