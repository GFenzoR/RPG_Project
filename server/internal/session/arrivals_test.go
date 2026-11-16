package session_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// fixtureHouse is a house of arrivals.json: its rect and door ("x,y,w,h", "x,y" on
// floor 7) and its exit (or the case's tile).
type fixtureHouse struct {
	Rect string `json:"rect"`
	Door string `json:"door"`
	Exit string `json:"exit"`
}

// arrivalsFixture is packages/map-format/src/testdata/arrivals.json.
type arrivalsFixture struct {
	Origin string         `json:"origin"`
	Rows   []string       `json:"rows"`
	Houses []fixtureHouse `json:"houses"`
	Cases  []struct {
		Name  string        `json:"name"`
		By    string        `json:"by"`
		To    string        `json:"to"`
		House *fixtureHouse `json:"house"`
		Error string        `json:"error"`
	} `json:"cases"`
}

// arrivalCases is how many cases arrivals.json has (arrivals.test.ts checks the same).
const arrivalCases = 17

// A boat arrival or a dialog teleport on a house tile, on a locked door placed open or
// (a dialog teleport) on no walkable tile of an island, and a house exit on a locked door
// (open or closed) or on no walkable tile, stops the world from starting, with the island
// and the tile; make validate refuses the same (docs/03 "Validación"): both read
// arrivals.json.
func TestArrivalsFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "map-format", "src", "testdata", "arrivals.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx arrivalsFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) != arrivalCases {
		t.Fatalf("%d cases, want %d", len(fx.Cases), arrivalCases)
	}
	why := map[string]string{"house": `in house "h0"`, "door": "on a locked door", "walkable": "not a walkable tile"}
	for _, c := range fx.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var more []fixtureHouse
			if c.House != nil {
				more = append(more, fixtureHouse{Rect: c.House.Rect, Door: c.House.Door, Exit: c.To})
			}
			cfg := arrivalsConfig(t, fx, more...)
			to := fixturePos(t, c.To)
			at := content.Position{X: int(to.X), Y: int(to.Y), Z: 7}
			switch c.By {
			case "boat":
				cfg.BoatRoutes = content.BoatRoutes{{ID: "r", Captain: "harbor_master", Text: "route.cheap",
					From: content.Position{X: 8, Y: 11, Z: 7}, To: at, Price: 30}}
			case "dialog":
				d := cfg.NPCs["puerto_priest"].Dialog
				n := d.Nodes[d.Start]
				n.Options = append(n.Options[:len(n.Options):len(n.Options)],
					content.DialogOption{Text: n.Options[0].Text, Action: content.Actions{{Teleport: &at}}})
			case "exit":
				if c.House == nil {
					t.Fatal("an exit case without its house")
				}
			default:
				t.Fatalf("bad arrival kind %q", c.By)
			}
			_, err := session.New(cfg)
			if c.Error == "" {
				if err != nil {
					t.Fatalf("refused: %v", err)
				}
				return
			}
			want, ok := why[c.Error]
			if !ok {
				t.Fatalf("unknown error %q", c.Error)
			}
			if c.By == "exit" {
				want = `house "h1"`
				if c.Error == "walkable" {
					want += ": exit " + to.String() + ` (island "test") is not on a walkable tile`
				} else {
					want += ": exit " + to.String() + ` (island "test") lies ` + why[c.Error]
				}
			}
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("got %v, want an error with %q", err, want)
			}
			// The new refusals name the island and the tile (the walkability of a boat
			// arrival is initTravel's older check, by route).
			if c.Error != "walkable" || c.By == "dialog" {
				if !strings.Contains(err.Error(), to.String()) {
					t.Fatalf("got %v, want the tile %v", err, to)
				}
			}
			if c.Error != "walkable" && !strings.Contains(err.Error(), `(island "test")`) {
				t.Fatalf("got %v, want the island", err)
			}
		})
	}
}

// arrivalsConfig is the data harness config (a 64x64 field of real grass with the captain
// harbor_master) with the drawing and the houses of fx, then the more ones.
func arrivalsConfig(t *testing.T, fx arrivalsFixture, more ...fixtureHouse) session.Config {
	t.Helper()
	cfg := dataConfig(t, nil)
	var ox, oy int
	if _, err := fmt.Sscanf(fx.Origin, "%d,%d", &ox, &oy); err != nil {
		t.Fatalf("bad origin %q", fx.Origin)
	}
	grass := cfg.Items["grass"].Numeric
	blocks := world.FlagBlocksMovement | world.FlagBlocksSight
	for y, row := range fx.Rows {
		for x, ch := range row {
			p := pos(ox+x, oy+y)
			switch ch {
			case '.':
				worldtest.SetTile(t, cfg.Map, p, grass, 0)
			case '#':
				worldtest.SetTile(t, cfg.Map, p, grass, blocks, cfg.Items["stone_wall"].Numeric)
			case 'D':
				worldtest.SetTile(t, cfg.Map, p, grass, blocks, cfg.Items["forge_gate"].Numeric)
			case 'd':
				worldtest.SetTile(t, cfg.Map, p, grass, 0, cfg.Items["forge_gate_open"].Numeric)
			default:
				t.Fatalf("unknown tile %q", ch)
			}
		}
	}
	var houses []world.House
	for i, h := range append(slices.Clip(fx.Houses), more...) {
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
	cfg.Map = worldtest.WithHouses(t, cfg.Map, houses...)
	return cfg
}
