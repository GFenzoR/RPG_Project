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
	Name  string            `json:"name"`
	Rows  []json.RawMessage `json:"rows"`
	Rooms map[string]int    `json:"rooms"`
	Error string            `json:"error"`
}

// rows expands the drawing of c ({"repeat": n, "row": r} is n rows r).
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
			Repeat int    `json:"repeat"`
			Row    string `json:"row"`
		}
		if err := json.Unmarshal(raw, &rep); err != nil || rep.Repeat <= 0 {
			t.Fatalf("bad row %s", raw)
		}
		for range rep.Repeat {
			out = append(out, rep.Row)
		}
	}
	return out
}

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
	if len(doc.Cases) < 8 {
		t.Fatalf("only %d cases", len(doc.Cases))
	}
	errs := map[string]error{"open": session.ErrDoorInTheOpen, "truncated": session.ErrDoorTruncated, "tie": session.ErrDoorTie}
	for _, c := range doc.Cases {
		t.Run(c.Name, func(t *testing.T) {
			rows := c.rows(t)
			// worldtest draws the locked pair (D, d); the plain doors go on after.
			var plain, walled []world.Pos
			for y, r := range rows {
				b := []byte(r)
				for x, ch := range b {
					switch ch {
					case 'P':
						plain, b[x] = append(plain, pos(x, y)), '.'
					case 'X':
						walled, b[x] = append(walled, pos(x, y)), '#'
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
			w, err := session.New(session.Config{Map: m, Balance: testBalance(), Vocations: testVocations,
				Items: doorTestItems(true), Save: func(session.Snapshot) bool { return true }})
			if c.Error != "" {
				want, ok := errs[c.Error]
				if !ok {
					t.Fatalf("unknown error %q", c.Error)
				}
				if !errors.Is(err, want) {
					t.Fatalf("got %v, want %v", err, want)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for at, n := range c.Rooms {
				var x, y int
				if _, err := fmt.Sscanf(at, "%d,%d", &x, &y); err != nil {
					t.Fatalf("bad door %q", at)
				}
				if got := w.DoorRoomSize(pos(x, y)); got != n {
					t.Errorf("room behind %s: %d tiles, want %d", at, got, n)
				}
			}
		})
	}
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
	g := pos(43, 41)
	worldtest.SetTile(t, cfg.Map, g, ground, blocks, cfg.Items["forge_gate"].Numeric)
	return cfg, g
}

// A room behind a locked door holds nothing that belongs outside (docs/02 "Puertas con
// llave"): no temple, NPC, house, boat arrival or dialog teleport. Either the outside was
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
	cfg.Map = m
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
