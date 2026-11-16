package session_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// pocketRows are a temple at (4,3) and, two rings north-west of it, a tile (2,1) sealed by
// walls: no door, no way in on foot.
var pocketRows = []string{
	"#######",
	"##.#..#",
	"####..#",
	"#...T.#",
	"#.....#",
	"#######",
}

// The search for a free tile by rings stays in the area it starts in (area.go): a crowded
// temple does not put anyone in a pocket sealed by walls, the first free tile of the
// second ring, but on the next one of the temple's own area (docs/02 "Puertas con llave").
func TestFreeTileStaysInItsArea(t *testing.T) {
	temple, pocket := pos(4, 3), pos(2, 1)
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, pocketRows...))
	if a := h.w.AreaOf(temple); a == 0 || h.w.AreaOf(pocket) == 0 || h.w.AreaOf(pocket) == a ||
		h.w.AreaOf(pos(4, 1)) != a || h.w.AreaOf(pos(1, 1)) != 0 {
		t.Fatalf("areas: temple %d, pocket %d", h.w.AreaOf(temple), h.w.AreaOf(pocket))
	}
	for i, p := range []world.Pos{temple, pos(4, 2), pos(5, 2), pos(3, 3), pos(5, 3), pos(3, 4), pos(4, 4), pos(5, 4)} {
		c := withPack(int64(9701+i), p)
		c.Name = fmt.Sprintf("Crowd%d", i)
		if _, b := h.joinChar(c); b.Pos() != p {
			t.Fatalf("crowd at %v, want %v", b.Pos(), p)
		}
	}
	late := withPack(9710, temple)
	late.Name = "Late"
	if _, p := h.joinChar(late); p.Pos() != pos(4, 1) {
		t.Fatalf("late logged in at %v, want (4,1) by the temple, not the pocket %v", p.Pos(), pocket)
	}
}

// A search for a free tile from a tile of no area that is no portal entrance (a locked
// door placed open, a house tile) still skips the rooms behind locked doors: a crowded
// open gate does not put anyone in the room behind it, the first free tile of the first
// ring, but on the next one outside.
func TestFreeTileFromNoAreaSkipsRooms(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"###########",
		"#...#..T..#",
		"#...d.....#",
		"#...#.....#",
		"###########",
	)
	gate, room := pos(4, 2), pos(3, 1)
	h := newHarness(t, m, func(c *session.Config) { c.Items = doorTestItems(true) })
	if h.w.DoorRoomSize(gate) != 9 || !h.w.InDoorRoom(gate, room) || h.w.AreaOf(gate) != 0 {
		t.Fatalf("room behind the gate: %d tiles, gate in area %d", h.w.DoorRoomSize(gate), h.w.AreaOf(gate))
	}
	blocker := withPack(9721, gate)
	blocker.Name = "Blocker"
	if _, b := h.joinChar(blocker); b.Pos() != gate {
		t.Fatalf("blocker at %v, want the open gate %v", b.Pos(), gate)
	}
	late := withPack(9730, gate)
	late.Name = "Late"
	if _, p := h.joinChar(late); p.Pos() != pos(5, 1) {
		t.Fatalf("late logged in at %v, want (5,1) outside the room %v", p.Pos(), room)
	}
}

// The entrance of a teleport (stairs, a hole) lies in no area: nobody stands on it, and a
// step onto it moves the player, so the areas go round it, not across it. A search for a
// free tile from it (a character saved on it, an arrival on it) stays in the areas next to
// it, the only ones a player there could walk to: with the one tile beside it taken, not
// in the pocket sealed by walls two rings away, but on the temple further on.
func TestFreeTileFromAPortalStaysBesideIt(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"#######",
		"#.#####",
		"###..T#",
		"#######",
	)
	tp, beside, pocket := pos(3, 2), pos(4, 2), pos(1, 1)
	m = worldtest.WithPortals(t, m, world.Portal{ID: "tp", Kind: world.PortalTeleport, From: tp, To: pos(5, 2)})
	h := newHarness(t, m)
	if a := h.w.AreaOf(beside); a == 0 || h.w.AreaOf(tp) != 0 || h.w.AreaOf(pos(5, 2)) != a || h.w.AreaOf(pocket) == 0 {
		t.Fatalf("areas: teleport %d, beside it %d, pocket %d", h.w.AreaOf(tp), a, h.w.AreaOf(pocket))
	}
	blocker := withPack(9731, beside)
	blocker.Name = "Blocker"
	if _, b := h.joinChar(blocker); b.Pos() != beside {
		t.Fatalf("blocker at %v, want %v", b.Pos(), beside)
	}
	late := withPack(9732, tp)
	late.Name = "Late"
	if _, p := h.joinChar(late); p.Pos() != pos(5, 2) {
		t.Fatalf("late logged in at %v, want (5,2) past the one beside the teleport, not the pocket %v", p.Pos(), pocket)
	}
}

// A ladder is used, not stepped onto: its tile is ground of its area like any other, so a
// one-tile corridor that holds a ladder up to a sealed pocket still joins a vault with the
// field of the temple (the teleport of door-rooms.json in the same corridor does not).
func TestEscapeWalksAcrossALadder(t *testing.T) {
	m := worldtest.Floors(t, 0, 0,
		worldtest.Layer{Z: 6, Rows: []string{"###", "#.#", "###"}},
		worldtest.Layer{Z: 7, Rows: []string{
			"#################",
			"#..T..#...#.....#",
			"#.....D...D.....#",
			"#.....#...#.....#",
			"#.#############.#",
			"#...............#",
			"#################",
		}})
	m = worldtest.WithPortals(t, m, world.Portal{ID: "up", Kind: world.PortalLadder, From: pos(8, 5), To: at3(1, 1, 6)})
	w, err := session.New(session.Config{Map: m, Balance: testBalance(), Vocations: testVocations,
		Items: doorTestItems(true), Save: func(session.Snapshot) bool { return true }})
	if err != nil {
		t.Fatalf("a vault joined to the field across a ladder: %v", err)
	}
	if a := w.AreaOf(pos(7, 5)); a == 0 || w.AreaOf(pos(8, 5)) != a || w.AreaOf(pos(13, 2)) != a {
		t.Fatalf("areas: west %d, ladder %d, vault %d", a, w.AreaOf(pos(8, 5)), w.AreaOf(pos(13, 2)))
	}
}

// The areas take every locked door and every house tile for a wall, and a plain door for
// open ground: a room behind a gate is an area of its own, and the tiles of a house and a
// locked door lie in none.
func TestAreasOfDoorsAndHouses(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"##########",
		"#..#..T..#",
		"#..D.....#",
		"#..#.....#",
		"#..#_##..#",
		"##########",
	)
	m = worldtest.WithHouses(t, m, world.House{ID: "nook", Name: "house.nook.name", Rent: 10,
		Rects: []world.HouseRect{{X: 4, Y: 4, Z: 7, W: 1, H: 1}}, Doors: []world.Pos{pos(4, 4)}, Exit: pos(4, 3)})
	w, err := session.New(session.Config{Map: m, Balance: testBalance(), Vocations: testVocations,
		Items: doorTestItems(true), Save: func(session.Snapshot) bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	hall, room := w.AreaOf(pos(6, 1)), w.AreaOf(pos(1, 1))
	if hall == 0 || room == 0 || hall == room || w.AreaOf(pos(2, 3)) != room || w.AreaOf(pos(4, 3)) != hall {
		t.Fatalf("hall %d, room %d", hall, room)
	}
	if w.AreaOf(pos(3, 2)) != 0 || w.AreaOf(pos(4, 4)) != 0 || w.AreaOf(pos(0, 0)) != 0 {
		t.Fatalf("door %d, house %d, wall %d", w.AreaOf(pos(3, 2)), w.AreaOf(pos(4, 4)), w.AreaOf(pos(0, 0)))
	}
	if n, _ := w.Areas(); n != 2 {
		t.Fatalf("%d areas, want 2", n)
	}

	plain := worldtest.Map(t, 0, 0, 7, "#####", "#.#.#", "#.#T#", "#####")
	worldtest.SetTile(t, plain, pos(2, 1), worldtest.Grass, world.FlagBlocksMovement|world.FlagBlocksSight, plainDoorID)
	w, err = session.New(session.Config{Map: plain, Balance: testBalance(), Vocations: testVocations,
		Items: doorTestItems(true), Save: func(session.Snapshot) bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	if a := w.AreaOf(pos(1, 2)); a == 0 || w.AreaOf(pos(3, 2)) != a || w.AreaOf(pos(2, 1)) != a {
		t.Fatalf("a plain door splits its area: %d, %d, %d", a, w.AreaOf(pos(3, 2)), w.AreaOf(pos(2, 1)))
	}
}

// The world of the escape check is the areas of the temples, and a portal a player takes
// without anything leads out of an area (docs/02 "Puertas con llave"). A vault no door
// guards (bigger than the hall before it, so its door takes it for the outside) stops the
// world from starting; a teleport out of it lets it start. A boat that arrives in it does
// not: an arrival is a way in, not out (whoever slipped into the vault from the hall and
// got locked in would stay there), and a boat portal out of it moves nobody.
func TestEscapeReachesTemplesByPortals(t *testing.T) {
	vault := pos(40, 41)
	start := func(routes content.BoatRoutes, portals ...world.Portal) error {
		cfg := dataConfig(t, routes)
		ground, _, _ := cfg.Map.Tile(pos(0, 0))
		blocks := world.FlagBlocksMovement | world.FlagBlocksSight
		// A box (30..50, 38..44): a hall (31..33) behind a gate on (30,41) and a vault
		// (35..49) behind a gate on (34,41).
		for y := 38; y <= 44; y++ {
			for x := 30; x <= 50; x++ {
				if x == 30 || x == 34 || x == 50 || y == 38 || y == 44 {
					worldtest.SetTile(t, cfg.Map, pos(x, y), ground, blocks)
				}
			}
		}
		for _, g := range []world.Pos{pos(30, 41), pos(34, 41)} { // on real grass (roomConfig)
			worldtest.SetTile(t, cfg.Map, g, cfg.Items["grass"].Numeric, blocks, cfg.Items["forge_gate"].Numeric)
		}
		if len(portals) > 0 {
			cfg.Map = worldtest.WithPortals(t, cfg.Map, portals...)
		}
		_, err := session.New(cfg)
		return err
	}
	if err := start(nil); !errors.Is(err, session.ErrDoorNoEscape) || !strings.Contains(err.Error(), "locked door on 34,41,7") {
		t.Fatalf("a vault no door guards: %v", err)
	}
	routes := testRoutes()
	routes[1].To = content.Position{X: 40, Y: 41, Z: 7}
	if err := start(routes); !errors.Is(err, session.ErrDoorNoEscape) || !strings.Contains(err.Error(), "locked door on 34,41,7") {
		t.Fatalf("a boat arrives in the vault: %v", err)
	}
	if err := start(nil, world.Portal{ID: "out", Kind: world.PortalTeleport, From: vault, To: pos(10, 20)}); err != nil {
		t.Fatalf("a teleport out of the vault: %v", err)
	}
	if err := start(nil, world.Portal{ID: "ferry", Kind: world.PortalBoat, From: vault, To: pos(10, 20)}); !errors.Is(err, session.ErrDoorNoEscape) {
		t.Fatalf("a boat portal out of the vault: %v", err)
	}
}

// A rope spot is no way out of an area for the escape check: it needs a rope, which a
// player need not carry (docs/02 "Puertas con llave"). The vault of door-rooms.json, bigger
// than the hall before it, with a way up from it to an open floor 6 that has stairs down
// to the field of the temple: by a ladder the world starts, by a rope spot it does not.
func TestEscapeNeedsNoRope(t *testing.T) {
	floor6 := make([]string, 5)
	for i := range floor6 {
		floor6[i] = "................."
	}
	start := func(up world.PortalKind) error {
		// Floors go up the list; the T on floor 7 is the temple all the same.
		m := worldtest.Floors(t, 0, 0,
			worldtest.Layer{Z: 6, Rows: floor6},
			worldtest.Layer{Z: 7, Rows: []string{
				"#################",
				"#..T..#...#.....#",
				"#.....D...D.....#",
				"#.....#...#.....#",
				"#################",
			}})
		m = worldtest.WithPortals(t, m,
			world.Portal{ID: "up", Kind: up, From: pos(15, 2), To: at3(15, 2, 6)},
			world.Portal{ID: "down", Kind: world.PortalStairs, From: at3(2, 2, 6), To: pos(2, 2)})
		_, err := session.New(session.Config{Map: m, Balance: testBalance(), Vocations: testVocations,
			Items: doorTestItems(true), Save: func(session.Snapshot) bool { return true }})
		return err
	}
	if err := start(world.PortalLadder); err != nil {
		t.Fatalf("a ladder up from the vault: %v", err)
	}
	if err := start(world.PortalRopeSpot); !errors.Is(err, session.ErrDoorNoEscape) || !strings.Contains(err.Error(), "locked door on 10,2,7") {
		t.Fatalf("a rope spot up from the vault: %v", err)
	}
}
