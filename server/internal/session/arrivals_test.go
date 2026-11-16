package session_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// arrivalsFixture is packages/map-format/src/testdata/arrivals.json.
type arrivalsFixture struct {
	Origin string   `json:"origin"`
	Rows   []string `json:"rows"`
	Houses []struct {
		Rect string `json:"rect"`
		Door string `json:"door"`
		Exit string `json:"exit"`
	} `json:"houses"`
	Cases []struct {
		Name  string `json:"name"`
		By    string `json:"by"`
		To    string `json:"to"`
		Error string `json:"error"`
	} `json:"cases"`
}

// arrivalCases is how many cases arrivals.json has (arrivals.test.ts checks the same).
const arrivalCases = 13

// A boat arrival or a dialog teleport on a house tile, on a locked door placed open or
// (a dialog teleport) on no walkable tile of an island stops the world from starting, with
// the island and the tile; make validate refuses the same (docs/03 "Validación"): both
// read arrivals.json.
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
			cfg := arrivalsConfig(t, fx)
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
// harbor_master) with the drawing and the houses of fx.
func arrivalsConfig(t *testing.T, fx arrivalsFixture) session.Config {
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
	for i, h := range fx.Houses {
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
