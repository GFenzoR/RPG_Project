package session_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// doorRoomCase is a case of packages/map-format/src/testdata/door-rooms.json.
type doorRoomCase struct {
	Name    string            `json:"name"`
	Rows    []json.RawMessage `json:"rows"`
	Portals []struct {
		Kind string `json:"kind"`
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"portals"`
	Houses []struct {
		Rect string `json:"rect"`
		Door string `json:"door"`
		Exit string `json:"exit"`
	} `json:"houses"`
	Rooms map[string]int `json:"rooms"`
	Error string         `json:"error"`
	Door  string         `json:"door"`
}

// rows expands the drawing of c ({"repeat": n, "row": r} is n rows r, {"repeat": n,
// "rows": [...]} those rows n times).
func (c doorRoomCase) rows(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, raw := range c.Rows {
		var row string
		if err := json.Unmarshal(raw, &row); err == nil {
			out = append(out, row)
			continue
		}
		var rep struct {
			Repeat int      `json:"repeat"`
			Row    string   `json:"row"`
			Rows   []string `json:"rows"`
		}
		if err := json.Unmarshal(raw, &rep); err != nil || rep.Repeat <= 0 || (rep.Row == "") == (len(rep.Rows) == 0) {
			t.Fatalf("bad row %s", raw)
		}
		block := rep.Rows
		if rep.Row != "" {
			block = []string{rep.Row}
		}
		for range rep.Repeat {
			out = append(out, block...)
		}
	}
	return out
}

// doorRoomCases is how many cases door-rooms.json has (doors.test.ts checks the same).
const doorRoomCases = 45

// The rooms behind locked doors, and the doors that have none, are the same for the
// server and for make validate: both read door-rooms.json (docs/02 "Puertas con llave").
// A locked door whose room cannot be worked out stops the world from starting.
func TestDoorRoomsFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "map-format", "src", "testdata", "door-rooms.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []doorRoomCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) < doorRoomCases {
		t.Fatalf("only %d cases", len(doc.Cases))
	}
	errs := map[string]error{"blocked": session.ErrDoorBlocked, "portal": session.ErrDoorOnPortal,
		"walled": session.ErrDoorWalled, "open": session.ErrDoorInTheOpen, "truncated": session.ErrDoorTruncated,
		"tie": session.ErrDoorTie, "key": session.ErrDoorOtherKey, "escape": session.ErrDoorNoEscape,
		"bypass": session.ErrDoorBypassed, "gate": session.ErrGateNoEscape,
		"object": session.ErrObjectInRoom}
	for _, c := range doc.Cases {
		t.Run(c.Name, func(t *testing.T) {
			rows := c.rows(t)
			// worldtest draws the gate pair (D, d); the other doors go on after.
			var plain, walled, other, blocked []world.Pos
			living := map[world.Pos]uint16{} // C: a crate anyone breaks, L: a gate placed closed
			for y, r := range rows {
				b := []byte(r)
				for x, ch := range b {
					switch ch {
					case 'P':
						plain, b[x] = append(plain, pos(x, y)), '.'
					case 'X':
						walled, b[x] = append(walled, pos(x, y)), '#'
					case 'K':
						other, b[x] = append(other, pos(x, y)), '.'
					case 'B':
						blocked, b[x] = append(blocked, pos(x, y)), '#'
					case 'C':
						living[pos(x, y)], b[x] = lwCrateID, '.'
					case 'L':
						living[pos(x, y)], b[x] = lwGateID, '.'
					}
				}
				rows[y] = string(b)
			}
			m := worldtest.Map(t, 0, 0, 7, rows...)
			blocks := world.FlagBlocksMovement | world.FlagBlocksSight
			for _, p := range plain {
				worldtest.SetTile(t, m, p, worldtest.Grass, blocks, plainDoorID)
			}
			for _, p := range walled {
				worldtest.SetTile(t, m, p, worldtest.Grass, blocks, worldtest.Wall, plainDoorID)
			}
			for _, p := range other {
				worldtest.SetTile(t, m, p, worldtest.Grass, blocks, otherGateID)
			}
			for _, p := range blocked {
				worldtest.SetTile(t, m, p, worldtest.Grass, blocks, worldtest.Wall, worldtest.Door)
			}
			if len(c.Portals) > 0 {
				var portals []world.Portal
				for i, pt := range c.Portals {
					kind, ok := world.ParsePortalKind(pt.Kind)
					if !ok {
						t.Fatalf("bad portal kind %q", pt.Kind)
					}
					portals = append(portals, world.Portal{ID: fmt.Sprintf("p%d", i), Kind: kind,
						From: fixturePos(t, pt.From), To: fixturePos(t, pt.To)})
				}
				m = worldtest.WithPortals(t, m, portals...)
			}
			if len(c.Houses) > 0 {
				var houses []world.House
				for i, h := range c.Houses {
					var x, y uint16
					var wd, ht uint8
					if _, err := fmt.Sscanf(h.Rect, "%d,%d,%d,%d", &x, &y, &wd, &ht); err != nil {
						t.Fatalf("bad rect %q", h.Rect)
					}
					id := fmt.Sprintf("h%d", i)
					houses = append(houses, world.House{ID: id, Name: "house." + id + ".name", Rent: 10,
						Rects: []world.HouseRect{{X: x, Y: y, Z: 7, W: wd, H: ht}},
						Doors: []world.Pos{fixturePos(t, h.Door)}, Exit: fixturePos(t, h.Exit)})
				}
				m = worldtest.WithHouses(t, m, houses...)
			}
			cfg := session.Config{Map: m, Balance: testBalance(), Vocations: testVocations,
				Items: doorTestItems(true), Save: func(session.Snapshot) bool { return true }}
			if len(living) > 0 {
				livingSetup(t, m, living)(&cfg)
				cfg.Items = withDoorItems(cfg.Items, true)
			}
			w, err := session.New(cfg)
			if c.Error != "" {
				want, ok := errs[c.Error]
				if !ok {
					t.Fatalf("unknown error %q", c.Error)
				}
				if !errors.Is(err, want) {
					t.Fatalf("got %v, want %v", err, want)
				}
				// The same door as make validate: the first one refused, in map order.
				what := "locked door on "
				switch c.Error {
				case "gate":
					what = "gate on "
				case "object":
					what = "object on "
				}
				if at := what + c.Door + ",7:"; c.Door == "" || !strings.Contains(err.Error(), at) {
					t.Fatalf("got %v, want the %q", err, at)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for at, n := range c.Rooms {
				if got := w.DoorRoomSize(fixturePos(t, at)); got != n {
					t.Errorf("room behind %s: %d tiles, want %d", at, got, n)
				}
			}
		})
	}
}

// fixturePos is the tile "x,y" of floor 7 of door-rooms.json.
func fixturePos(t *testing.T, at string) world.Pos {
	t.Helper()
	var x, y int
	if _, err := fmt.Sscanf(at, "%d,%d", &x, &y); err != nil {
		t.Fatalf("bad tile %q", at)
	}
	return pos(x, y)
}

// A crowd next to a locked gate does not log anyone in on its other side: the search for
// a free tile around the saved position skips the room behind the gate (it would open the
// gate from there without the key, docs/02 "Puertas con llave").
func TestCrowdedLoginNextToLockedGate(t *testing.T) {
	h := newHarness(t, doorMap(t), func(c *session.Config) { c.Items = doorTestItems(true) })
	for i, p := range []world.Pos{pos(5, 2), pos(5, 1), pos(6, 1), pos(6, 2), pos(5, 3), pos(6, 3)} {
		c := withPack(int64(9601+i), p)
		c.Name = fmt.Sprintf("Blocker%d", i)
		if _, b := h.joinChar(c); b.Pos() != p {
			t.Fatalf("blocker at %v, want %v", b.Pos(), p)
		}
	}
	sneak := withPack(9610, pos(5, 2))
	sneak.Name = "Sneak"
	_, p := h.joinChar(sneak)
	if h.w.InDoorRoom(gate, p.Pos()) || p.Pos() != pos(7, 1) {
		t.Fatalf("sneak logged in at %v (in the room: %v), want (7,1) in the hall", p.Pos(), h.w.InDoorRoom(gate, p.Pos()))
	}

	// Saved inside the room, a player stays inside.
	inside := withPack(9611, pos(3, 1))
	inside.Name = "Inside"
	if _, q := h.joinChar(inside); q.Pos() != pos(3, 1) {
		t.Fatalf("inside logged in at %v", q.Pos())
	}

	// Saved inside a crowded room, the search goes on ring by ring and may still put it
	// in its own room: (1,3) is the first free tile of the third ring around (3,1).
	h = newHarness(t, doorMap(t), func(c *session.Config) { c.Items = doorTestItems(true) })
	crowd := []world.Pos{pos(1, 1), pos(2, 1), pos(3, 1), pos(1, 2), pos(2, 2), pos(3, 2), pos(2, 3), pos(3, 3),
		pos(5, 1), pos(5, 2)}
	for i, p := range crowd {
		c := withPack(int64(9641+i), p)
		c.Name = fmt.Sprintf("Crowd%d", i)
		if _, b := h.joinChar(c); b.Pos() != p {
			t.Fatalf("crowd at %v, want %v", b.Pos(), p)
		}
	}
	late := withPack(9660, pos(3, 1))
	late.Name = "Late"
	if _, q := h.joinChar(late); q.Pos() != pos(1, 3) {
		t.Fatalf("late logged in at %v, want (1,3) in its room", q.Pos())
	}
}

// Leaving a house to a crowded exit next to a locked gate does not end in the room behind
// the gate either (houseExit).
func TestHouseExitSkipsTheRoomBehindAGate(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"##########",
		"#..#..T..#",
		"#..D.....#",
		"#..#.....#",
		"#..#_##..#",
		"##########",
	)
	door, exit := pos(4, 4), pos(4, 3)
	m = worldtest.WithHouses(t, m, world.House{ID: "nook", Name: "house.nook.name", Rent: 10,
		Rects: []world.HouseRect{{X: 4, Y: 4, Z: 7, W: 1, H: 1}}, Doors: []world.Pos{door}, Exit: exit})
	g := pos(3, 2)
	h := newHarness(t, m, func(c *session.Config) {
		c.Items = withDoorItems(marketItems(t), true)
		c.Balance.Market = content.Market{Enabled: true, FeePermille: 100, FeeMin: 2, FeeMax: 50, MaxOffers: 2,
			MaxAmount: 100, MaxPrice: 1000, DurationsHours: []int{1, 2}, ListSize: 5, HistorySize: 4,
			ReferenceDays: 3, MailboxShown: 10, ActionBurst: 50, ActionRefillMs: 50}
		c.Balance.Houses = content.Houses{Enabled: true, MinLevel: 5, PeriodDays: 7, MaxPeriods: 2, MaxGuests: 2,
			ItemsPerTile: 1, TransferMinutes: 5, ActionBurst: 100, ActionRefillMs: 50}
		c.Transfer = func(session.Transfer) bool { return true }
	})
	if h.w.DoorRoomSize(g) != 8 || !h.w.InDoorRoom(g, pos(2, 1)) {
		t.Fatalf("room behind the gate: %d tiles", h.w.DoorRoomSize(g))
	}
	for i, p := range []world.Pos{exit, pos(4, 2), pos(5, 2), pos(5, 3)} {
		c := withPack(int64(9621+i), p)
		c.Name = fmt.Sprintf("Crowd%d", i)
		h.joinChar(c)
	}
	// A character without access to the house saved inside it logs in at the exit, or
	// the free tile closest to it: never the room behind the gate.
	stranger := withPack(9630, door)
	stranger.Name = "Stranger"
	_, p := h.joinChar(stranger)
	if h.w.InDoorRoom(g, p.Pos()) || p.Pos() != pos(4, 1) {
		t.Fatalf("the stranger left the house to %v (in the room: %v), want (4,1)", p.Pos(), h.w.InDoorRoom(g, p.Pos()))
	}
}

// roomConfig is the data harness config with a 3x3 walled room (40..42, 40..42) behind
// the forge gate on (43, 41).
func roomConfig(t *testing.T, routes content.BoatRoutes, spawns ...world.Spawn) (session.Config, world.Pos) {
	t.Helper()
	cfg := dataConfig(t, routes, spawns...)
	ground, _, _ := cfg.Map.Tile(pos(0, 0))
	blocks := world.FlagBlocksMovement | world.FlagBlocksSight
	for y := 39; y <= 43; y++ {
		for x := 39; x <= 43; x++ {
			if x == 39 || x == 43 || y == 39 || y == 43 {
				worldtest.SetTile(t, cfg.Map, pos(x, y), ground, blocks)
			}
		}
	}
	// The gate stands on real grass: worldtest's ground numbers are no items of data/, and
	// a locked door on a tile nobody walks on is refused (errDoorBlocked).
	g := pos(43, 41)
	worldtest.SetTile(t, cfg.Map, g, cfg.Items["grass"].Numeric, blocks, cfg.Items["forge_gate"].Numeric)
	return cfg, g
}

// A room behind a locked door holds nothing that belongs outside (docs/02 "Puertas con
// llave"): no temple, NPC, house, portal end, boat arrival or dialog teleport. Either the outside was
// taken for the room, or a player would land behind the door. Monsters may live there.
func TestRoomHoldsNothingOfTheOutside(t *testing.T) {
	inside := pos(41, 41)
	at := content.Position{X: 41, Y: 41, Z: 7}

	cfg, g := roomConfig(t, nil, spawnAt("bilge_rat", 41, 41, 1, 60))
	w, err := session.New(cfg)
	if err != nil {
		t.Fatalf("a spawn in the room: %v", err)
	}
	if w.DoorRoomSize(g) != 9 || !w.InDoorRoom(g, inside) {
		t.Fatalf("room behind the gate: %d tiles", w.DoorRoomSize(g))
	}

	for name, c := range map[string]struct {
		edit func(*session.Config)
		want string
	}{
		"the temple": {func(c *session.Config) { c.Map.Islands()[0].Temple = inside }, "temple"},
		"an npc": {func(c *session.Config) {
			npcs := c.Map.Islands()[0].NPCs
			npcs[len(npcs)-1].Pos = inside
		}, "npc"},
		"a house": {func(c *session.Config) {
			c.Map = worldtest.WithHouses(t, c.Map, world.House{ID: "vault_house", Name: "house.vault_house.name", Rent: 10,
				Rects: []world.HouseRect{{X: 40, Y: 40, Z: 7, W: 1, H: 2}}, Doors: []world.Pos{pos(40, 41)}, Exit: inside})
		}, "house"},
		// Its exit outside the room, a tile of the house inside it (across the wall).
		"a house tile": {func(c *session.Config) {
			c.Map = worldtest.WithHouses(t, c.Map, world.House{ID: "wall_house", Name: "house.wall_house.name", Rent: 10,
				Rects: []world.HouseRect{{X: 42, Y: 40, Z: 7, W: 3, H: 1}}, Doors: []world.Pos{pos(44, 40)}, Exit: pos(45, 40)})
		}, `house "wall_house" on 42,40,7`},
		"a portal entrance": {func(c *session.Config) {
			c.Map = worldtest.WithPortals(t, c.Map, world.Portal{ID: "out", Kind: world.PortalTeleport, From: inside, To: pos(20, 20)})
		}, `portal "out"`},
		"a portal destination": {func(c *session.Config) {
			c.Map = worldtest.WithPortals(t, c.Map, world.Portal{ID: "in", Kind: world.PortalTeleport, From: pos(20, 20), To: inside})
		}, `portal "in"`},
		"a boat arrival": {func(c *session.Config) {
			c.BoatRoutes = testRoutes()
			c.BoatRoutes[1].To = at
		}, "boat route"},
		"a dialog teleport": {func(c *session.Config) {
			d := c.NPCs["puerto_priest"].Dialog
			n := d.Nodes[d.Start]
			n.Options = append(n.Options[:len(n.Options):len(n.Options)],
				content.DialogOption{Text: n.Options[0].Text, Action: content.Actions{{Teleport: &at}}})
		}, "teleports"},
	} {
		t.Run(name, func(t *testing.T) {
			cfg, _ := roomConfig(t, nil)
			c.edit(&cfg)
			_, err := session.New(cfg)
			if err == nil || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "room behind the locked door") {
				t.Fatalf("%s in the room: %v", name, err)
			}
		})
	}
}

// The rooms of the real map (world/) hold nothing of the outside, with the real boat
// routes and dialogs; the same check refuses the forge echo moved into the forge, or the
// volcanic temple.
func TestRoomsOnTheMap(t *testing.T) {
	m, err := compile.Compile(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	routes, err := content.LoadBoatRoutes(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	at8 := func(x, y int) world.Pos { return world.Pos{X: uint16(x), Y: uint16(y), Z: 8} }
	gate, forge := at8(3692, 5832), at8(3692, 5840)
	cfg := dataConfig(t, routes)
	cfg.Map, cfg.Quests = m, realQuests(t)
	w, err := session.New(cfg)
	if err != nil {
		t.Fatalf("the real world: %v", err)
	}
	if n := w.DoorRoomSize(gate); n < 100 || !w.InDoorRoom(gate, forge) {
		t.Fatalf("the forge room: %d tiles", n)
	}

	volcan := m.Island("volcan")
	for name, edit := range map[string]func(){
		"the forge echo": func() {
			for i := range volcan.NPCs {
				if volcan.NPCs[i].NPC == "volcan_forge_echo" {
					volcan.NPCs[i].Pos = forge
				}
			}
		},
		"the temple": func() { volcan.Temple = forge },
	} {
		t.Run(name, func(t *testing.T) {
			temple, npcs := volcan.Temple, append([]world.NPCPlacement(nil), volcan.NPCs...)
			defer func() { volcan.Temple, volcan.NPCs = temple, npcs }()
			edit()
			if _, err := session.New(cfg); err == nil || !strings.Contains(err.Error(), "room behind the locked door on 3692,5832,8") {
				t.Fatalf("%s in the forge: %v", name, err)
			}
		})
	}
}

// Two gates of one hall whose outsides meet only through a house: a house is no street,
// so the areas of the escape check take it for a wall, the east outside reaches no temple
// and the world refuses to start (make validate refuses it too, doors.test.ts).
func TestSharedRoomOutsidesDoNotCrossHouses(t *testing.T) {
	rows := []string{
		"#############",
		"#...#...#...#",
		"#.T.D...D...#",
		"#...#...#...#",
		"#...#####...#",
		"#...........#",
		"#############",
	}
	start := func(m *world.Map) (*session.World, error) {
		return session.New(session.Config{Map: m, Balance: testBalance(), Vocations: testVocations,
			Items: doorTestItems(true), Save: func(session.Snapshot) bool { return true }})
	}
	w, err := start(worldtest.Map(t, 0, 0, 7, rows...))
	if err != nil {
		t.Fatalf("outsides joined by the street below: %v", err)
	}
	if w.DoorRoomSize(pos(4, 2)) != 9 || w.DoorRoomSize(pos(8, 2)) != 9 {
		t.Fatalf("hall: %d and %d tiles", w.DoorRoomSize(pos(4, 2)), w.DoorRoomSize(pos(8, 2)))
	}
	m := worldtest.WithHouses(t, worldtest.Map(t, 0, 0, 7, rows...), world.House{ID: "nook", Name: "house.nook.name",
		Rent: 10, Rects: []world.HouseRect{{X: 6, Y: 5, Z: 7, W: 1, H: 1}}, Doors: []world.Pos{pos(6, 5)}, Exit: pos(5, 5)})
	if _, err := start(m); !errors.Is(err, session.ErrDoorNoEscape) || !strings.Contains(err.Error(), "its side on 9,1,7") {
		t.Fatalf("outsides joined only through a house: %v", err)
	}
}
