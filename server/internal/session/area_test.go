package session_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

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

// The world of the escape check is the areas of the temples and of the boat arrivals, and
// a portal that moves players leads out of an area (docs/02 "Puertas con llave"). A vault
// no door guards (bigger than the hall before it, so its door takes it for the outside)
// stops the world from starting; a boat that arrives in it, or a teleport out of it, lets
// it start; a boat portal out of it moves nobody, so it does not.
func TestEscapeReachesTemplesBoatsAndPortals(t *testing.T) {
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
		for _, g := range []world.Pos{pos(30, 41), pos(34, 41)} {
			worldtest.SetTile(t, cfg.Map, g, ground, blocks, cfg.Items["forge_gate"].Numeric)
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
	if err := start(routes); err != nil {
		t.Fatalf("a boat arrives in the vault: %v", err)
	}
	if err := start(nil, world.Portal{ID: "out", Kind: world.PortalTeleport, From: vault, To: pos(10, 20)}); err != nil {
		t.Fatalf("a teleport out of the vault: %v", err)
	}
	if err := start(nil, world.Portal{ID: "ferry", Kind: world.PortalBoat, From: vault, To: pos(10, 20)}); !errors.Is(err, session.ErrDoorNoEscape) {
		t.Fatalf("a boat portal out of the vault: %v", err)
	}
}
