package session_test

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
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

// gateRows are a room (1..3, 1..3) behind a locked gate at (4,2), drawn closed (D) or
// placed open (d), and a hall east of it with the temple.
func gateRows(gate string) []string {
	return []string{
		"###########",
		"#...#..T..#",
		"#..." + gate + ".....#",
		"#...#.....#",
		"###########",
	}
}

// A search for a free tile from a locked door lands on its outside (area.go searchFrom),
// never in its doorway nor in the room behind it: whoever logged out standing in the open
// doorway came from the outside, or from the room, which the gate opens onto the outside
// without the key. With the gate shut again since, the character still logs in beside it,
// outside, not at the temple. The ring around the gate offers the room tile (3,1) first.
func TestFreeTileFromALockedDoorIsOutside(t *testing.T) {
	gate, room := pos(4, 2), pos(3, 1)
	for _, drawn := range []string{"d", "D"} {
		t.Run(drawn, func(t *testing.T) {
			h := newHarness(t, worldtest.Map(t, 0, 0, 7, gateRows(drawn)...),
				func(c *session.Config) { c.Items = doorTestItems(true) })
			if h.w.DoorRoomSize(gate) != 9 || !h.w.InDoorRoom(gate, room) || h.w.AreaOf(gate) != 0 {
				t.Fatalf("room behind the gate: %d tiles, gate in area %d", h.w.DoorRoomSize(gate), h.w.AreaOf(gate))
			}
			for i, want := range []world.Pos{pos(5, 1), pos(5, 2), pos(5, 3), pos(6, 1)} {
				c := withPack(int64(9721+i), gate)
				c.Name = fmt.Sprintf("Doorway%d", i)
				if _, p := h.joinChar(c); p.Pos() != want {
					t.Fatalf("login %d on the gate at %v (in the room: %v), want %v outside",
						i, p.Pos(), h.w.InDoorRoom(gate, p.Pos()), want)
				}
			}
		})
	}
}

// A staff /tp onto a locked door placed open lands on its outside, like a login there:
// never in the doorway, where it would hold the gate open.
func TestStaffTeleportOntoALockedDoorLandsOutside(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, gateRows("d")...), func(c *session.Config) {
		c.Items = doorTestItems(true)
		c.Admin = func(session.AdminJob) bool { return true }
	})
	c := withPack(9741, pos(8, 3))
	c.Name, c.Role = "Warden", session.RoleGM
	cl, g := h.joinChar(c)
	cl.take()
	h.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/tp 4 2 7"))
	h.sim.Step()
	if keys := sysKeys(cl.take()); !slices.Equal(keys, []string{"gm.teleported"}) || g.Pos() != pos(5, 1) {
		t.Fatalf("/tp onto the open gate: %v at %v, want (5,1) outside", keys, g.Pos())
	}
}

// A door that is not locked joins its two sides in one area, shut or open: a character
// that logged out in its open doorway logs in beside it, on either side (the first free
// tile of the ring, here in the west room), even with the door shut since (a restart puts
// every door back as the map draws it), not at the temple.
func TestLoginOnAShutPlainDoorIsBesideIt(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, gateRows("D")...),
		func(c *session.Config) { c.Items = doorTestItems(false) })
	door := pos(4, 2)
	if a := h.w.AreaOf(door); a == 0 || h.w.AreaOf(pos(3, 1)) != a || h.w.AreaOf(pos(7, 1)) != a {
		t.Fatalf("areas: door %d, west %d, temple %d", a, h.w.AreaOf(pos(3, 1)), h.w.AreaOf(pos(7, 1)))
	}
	c := withPack(9791, door)
	c.Name = "Doorway"
	if _, p := h.joinChar(c); p.Pos() != pos(3, 1) {
		t.Fatalf("login on the shut door at %v, want (3,1) beside it", p.Pos())
	}
}

// With every tile a search may give taken, a character saved on a locked door (open or
// shut) shares the tile of its temple rather than stand in the doorway, a step from the
// room without the key: the outside (3,1) and the temple (4,1) are the only tiles of the
// outside, and the room (1,1) is no place for it. On a shut plain door (its area is both
// sides) it shares the temple too, rather than stand inside the shut door.
func TestCrowdedLoginOnADoorSharesTheTemple(t *testing.T) {
	gate, temple := pos(2, 1), pos(4, 1)
	for _, tc := range []struct {
		name, drawn string
		locked      bool
		crowd       []world.Pos
	}{
		{"locked open", "d", true, []world.Pos{temple, pos(3, 1)}},
		{"locked shut", "D", true, []world.Pos{temple, pos(3, 1)}},
		{"plain shut", "D", false, []world.Pos{temple, pos(3, 1), pos(1, 1)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, worldtest.Map(t, 0, 0, 7, "######", "#."+tc.drawn+".T#", "######"),
				func(c *session.Config) { c.Items = doorTestItems(tc.locked) })
			if h.w.InDoorRoom(gate, pos(1, 1)) != tc.locked || (h.w.AreaOf(gate) == 0) != tc.locked ||
				h.w.AreaOf(pos(3, 1)) != h.w.AreaOf(temple) {
				t.Fatalf("the map: room %v, gate in area %d", h.w.InDoorRoom(gate, pos(1, 1)), h.w.AreaOf(gate))
			}
			for i, p := range tc.crowd {
				c := withPack(int64(9811+i), p)
				c.Name = fmt.Sprintf("Crowd%d", i)
				if _, b := h.joinChar(c); b.Pos() != p {
					t.Fatalf("crowd at %v, want %v", b.Pos(), p)
				}
			}
			late := withPack(9819, gate)
			late.Name = "Late"
			if _, p := h.joinChar(late); p.Pos() != temple {
				t.Fatalf("late logged in at %v, want the temple %v, not the doorway", p.Pos(), temple)
			}
		})
	}
}

// A search for a free tile from a tile no player may be on with no rule of its own (a
// wall, no tile at all) finds nothing (area.go searchFrom): it does not guess. Its caller
// falls back on its last resort (the temple, the exit, a refusal); the ring around the
// wall (2,1) offers the pocket (1,1) and the house (3,1), both free.
func TestFreeTileFromAWallFindsNone(t *testing.T) {
	h := newHarness(t, houseRowsMap(t))
	for _, from := range []world.Pos{pos(2, 1), pos(0, 0), pos(200, 200)} {
		if q, ok := h.w.FreeNear(from, 3); ok {
			t.Fatalf("a search from %v found %v", from, q)
		}
	}
	if q, ok := h.w.FreeNear(pos(1, 1), 3); !ok || q != pos(1, 1) {
		t.Fatalf("a search from the pocket found %v, %v", q, ok)
	}
}

// houseRows are a house (3..4, 1..2, its door (3,2) above its exit (3,3)), a tile (1,1)
// two rings west of it sealed by walls, and a street with the temple below.
var houseRows = []string{
	"########",
	"#.#..###",
	"###..###",
	"###...T#",
	"########",
}

// houseRowsMap is houseRows with the house "nook" on it.
func houseRowsMap(t *testing.T) *world.Map {
	t.Helper()
	return worldtest.WithHouses(t, worldtest.Map(t, 0, 0, 7, houseRows...), world.House{ID: "nook",
		Name: "house.nook.name", Rent: 10, Rects: []world.HouseRect{{X: 3, Y: 1, Z: 7, W: 2, H: 2}},
		Doors: []world.Pos{pos(3, 2)}, Exit: pos(3, 3)})
}

// A search for a free tile from a house tile stays in the house (its tiles joined on foot,
// a house area) or on the street its exit leads to (area.go searchFrom): a crowded house
// does not log anyone in on the pocket sealed by walls two rings away (offered first),
// but on the street. The tiles of the house are no area: the escape check takes a house
// for a wall.
func TestFreeTileFromAHouseStaysInItOrOnItsStreet(t *testing.T) {
	h := newHarness(t, houseRowsMap(t))
	home, pocket, street := pos(3, 1), pos(1, 1), pos(5, 3)
	if a := h.w.HouseAreaOf(home); a == 0 || h.w.AreaOf(home) != 0 || h.w.HouseAreaOf(pos(4, 2)) != a ||
		h.w.HouseAreas() != 1 || h.w.AreaOf(pocket) == 0 || h.w.AreaOf(street) != h.w.AreaOf(pos(3, 3)) {
		t.Fatalf("house area %d (%d of them), pocket %d, street %d", h.w.HouseAreaOf(home), h.w.HouseAreas(),
			h.w.AreaOf(pocket), h.w.AreaOf(street))
	}
	for i, p := range []world.Pos{home, pos(4, 1), pos(3, 2), pos(4, 2), pos(3, 3), pos(4, 3)} {
		c := withPack(int64(9751+i), p)
		c.Name = fmt.Sprintf("Crowd%d", i)
		if _, b := h.joinChar(c); b.Pos() != p {
			t.Fatalf("crowd at %v, want %v", b.Pos(), p)
		}
	}
	late := withPack(9760, home)
	late.Name = "Late"
	if _, p := h.joinChar(late); p.Pos() != street {
		t.Fatalf("late logged in at %v, want %v on the street of the exit, not the pocket %v", p.Pos(), street, pocket)
	}
}

// A house split by a wall in two parts that meet only through the street is two house
// areas: a crowded part does not put anyone in the other one (it could be another
// house's, or a closet with no door), only on the street of the exit.
func TestHouseAreasFollowItsWalls(t *testing.T) {
	m := worldtest.WithHouses(t, worldtest.Map(t, 0, 0, 7,
		"#######",
		"#.#.###",
		"#.#.###",
		"#.....T",
		"#######",
	), world.House{ID: "pair", Name: "house.pair.name", Rent: 10,
		Rects: []world.HouseRect{{X: 1, Y: 1, Z: 7, W: 1, H: 2}, {X: 3, Y: 1, Z: 7, W: 1, H: 2}},
		Doors: []world.Pos{pos(1, 2), pos(3, 2)}, Exit: pos(2, 3)})
	h := newHarness(t, m)
	west, east := h.w.HouseAreaOf(pos(1, 1)), h.w.HouseAreaOf(pos(3, 1))
	if west == 0 || east == 0 || west == east || h.w.HouseAreas() != 2 {
		t.Fatalf("house areas: west %d, east %d", west, east)
	}
	for i, p := range []world.Pos{pos(3, 1), pos(3, 2), pos(2, 3)} {
		c := withPack(int64(9771+i), p)
		c.Name = fmt.Sprintf("Crowd%d", i)
		h.joinChar(c)
	}
	late := withPack(9780, pos(3, 1))
	late.Name = "Late"
	if _, p := h.joinChar(late); p.Pos() != pos(1, 3) {
		t.Fatalf("late logged in at %v, want (1,3) on the street, not the west part (1,1) offered first", p.Pos())
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

// A character saved on a house tile that something solid fills now (a bush in a rented
// garden, made solid) wakes up at its temple, not beside it: besideSolid never guesses
// inside a house, whose tiles answer to its owner and its guests.
func TestSavedOnASolidHouseTileGoesToTheTemple(t *testing.T) {
	m := worldtest.WithHouses(t, worldtest.Map(t, 0, 0, 7,
		"############",
		"#.v#.......#",
		"#..#.......#",
		"#..........T",
		"############",
	), world.House{ID: "garden", Name: "house.garden.name", Rent: 10,
		Rects: []world.HouseRect{{X: 1, Y: 1, Z: 7, W: 2, H: 2}}, Doors: []world.Pos{pos(1, 2)}, Exit: pos(1, 3)})
	h := newHarness(t, m)
	vein, temple := pos(2, 1), pos(11, 3)
	if m.Flags(vein)&(world.BlockFlags|world.FlagHouse) != world.FlagBlocksMovement|world.FlagHouse {
		t.Fatalf("the vein at %v must be a solid house tile one sees over: flags %b", vein, m.Flags(vein))
	}
	_, p := h.join("Gardener", &vein)
	if p.Pos() != temple {
		t.Fatalf("saved on the solid house tile %v, logged in at %v, want the temple %v", vein, p.Pos(), temple)
	}
}
