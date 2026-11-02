// Package worldtest builds small maps from ASCII drawings for tests of the packages that
// use internal/world (session, gateway, sim scenarios).
package worldtest

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Ground and item ids of the drawings. Grass and floor use the default terrain cost
// (100 %), road is fast (50 %) and mud is slow (200 %).
const (
	Grass = 1
	Road  = 2
	Mud   = 3
	Floor = 4
	Wall  = 10 // item on top of grass that blocks movement and sight
)

// Speeds is the terrain cost table of the drawings, indexed by item id.
var Speeds = []uint16{0, 0, 50, 200, 0}

// Map builds a one-island map ("test") whose top-left drawn tile is (ox, oy, z):
//
//	.  grass    =  road    m  mud    _  floor    #  wall (grass + Wall item)
//	~  water (blocks movement only)    T  grass, and the island's temple
//	   (space) no tile
//
// The island rect is the smallest sector-aligned rect holding the drawing. Without a T
// the temple is the first walkable tile.
func Map(t testing.TB, ox, oy int, z uint8, rows ...string) *world.Map {
	t.Helper()
	w := 0
	for _, r := range rows {
		w = max(w, len(r))
	}
	const ss = world.SectorSize
	x0, y0 := ox/ss*ss, oy/ss*ss
	x1 := (ox + w + ss - 1) / ss * ss
	y1 := (oy + len(rows) + ss - 1) / ss * ss
	is := &world.Island{
		ID:     "test",
		Rect:   world.Rect{X: uint32(x0), Y: uint32(y0), W: uint32(x1 - x0), H: uint32(y1 - y0)},
		Floors: []uint8{z},
	}
	templeSet := false
	byKey := map[[2]int]*world.Sector{}
	var list []*world.Sector
	stacks := map[*world.Sector][]world.TileStack{}
	for y, row := range rows {
		for x, c := range row {
			gx, gy := ox+x, oy+y
			key := [2]int{gx / ss, gy / ss}
			s := byKey[key]
			if s == nil {
				s = &world.Sector{CX: uint16(key[0]), CY: uint16(key[1]), Z: z}
				for i := range s.Flags {
					s.Flags[i] = world.FlagBlocksMovement
				}
				byKey[key] = s
				list = append(list, s)
			}
			i := (gy%ss)*ss + gx%ss
			var g uint16
			var f world.Flags
			switch c {
			case '.', 'T':
				g = Grass
			case '=':
				g = Road
			case 'm':
				g = Mud
			case '_':
				g = Floor
			case '#':
				g, f = Grass, world.FlagBlocksMovement|world.FlagBlocksSight
				stacks[s] = append(stacks[s], world.TileStack{Index: uint16(i), Items: []uint16{Wall}})
			case '~':
				g, f = Floor, world.FlagBlocksMovement
			case ' ':
				f = world.FlagBlocksMovement
			default:
				t.Fatalf("worldtest: unknown map char %q", c)
			}
			s.Ground[i], s.Flags[i] = g, f
			p := world.Pos{X: uint16(gx), Y: uint16(gy), Z: z}
			if c == 'T' || (!templeSet && f == 0 && g != 0) {
				is.Temple, templeSet = p, true
			}
		}
	}
	for s, st := range stacks {
		s.Stacks = st // drawn row by row, so already sorted by index
	}
	m, err := world.NewMap([]*world.Island{is}, map[string][]*world.Sector{"test": list}, Speeds)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// Open returns a map of w x h grass tiles with its top-left corner at (ox, oy, 7).
func Open(t testing.TB, ox, oy, w, h int) *world.Map {
	t.Helper()
	row := make([]byte, w)
	for i := range row {
		row[i] = '.'
	}
	rows := make([]string, h)
	for i := range rows {
		rows[i] = string(row)
	}
	return Map(t, ox, oy, 7, rows...)
}
