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
	// FishWater is water with fish (blocks movement), for gathering tests (T1.12).
	FishWater = 5
	Wall      = 10 // item on top of grass that blocks movement and sight
	// Vein is an ore vein on top of grass that blocks movement (T1.12).
	Vein = 11
)

// Speeds is the terrain cost table of the drawings, indexed by item id.
var Speeds = []uint16{0, 0, 50, 200, 0, 0}

// Map builds a one-island map ("test") whose top-left drawn tile is (ox, oy, z):
//
//	.  grass    =  road    m  mud    _  floor    #  wall (grass + Wall item)
//	~  water (blocks movement only)    T  grass, and the island's temple
//	f  water with fish (FishWater)     v  vein (grass + Vein item, blocks movement)
//	   (space) no tile
//
// The island rect is the smallest sector-aligned rect holding the drawing. Without a T
// the temple is the first walkable tile.
func Map(t testing.TB, ox, oy int, z uint8, rows ...string) *world.Map {
	t.Helper()
	return Floors(t, ox, oy, Layer{Z: z, Rows: rows})
}

// Layer is the drawing of one floor for Floors.
type Layer struct {
	Z    uint8
	Rows []string
}

// Floors builds a one-island map with several floors, each drawn like Map with its
// top-left tile at (ox, oy). The temple is on the first layer.
func Floors(t testing.TB, ox, oy int, layers ...Layer) *world.Map {
	t.Helper()
	w, h := 0, 0
	floors := make([]uint8, 0, len(layers))
	for _, l := range layers {
		for _, r := range l.Rows {
			w = max(w, len(r))
		}
		h = max(h, len(l.Rows))
		floors = append(floors, l.Z)
	}
	const ss = world.SectorSize
	x0, y0 := ox/ss*ss, oy/ss*ss
	x1 := (ox + w + ss - 1) / ss * ss
	y1 := (oy + h + ss - 1) / ss * ss
	is := &world.Island{
		ID:     "test",
		Rect:   world.Rect{X: uint32(x0), Y: uint32(y0), W: uint32(x1 - x0), H: uint32(y1 - y0)},
		Floors: floors,
	}
	templeSet := false
	byKey := map[[3]int]*world.Sector{}
	var list []*world.Sector
	stacks := map[*world.Sector][]world.TileStack{}
	for _, l := range layers {
		z := l.Z
		for y, row := range l.Rows {
			for x, c := range row {
				gx, gy := ox+x, oy+y
				key := [3]int{gx / ss, gy / ss, int(z)}
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
				case 'f':
					g, f = FishWater, world.FlagBlocksMovement
				case 'v':
					g, f = Grass, world.FlagBlocksMovement
					stacks[s] = append(stacks[s], world.TileStack{Index: uint16(i), Items: []uint16{Vein}})
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

// Join puts the islands of maps (each built by this package, so each has one island)
// in one map, renaming them to ids in order. The maps must not overlap.
func Join(t testing.TB, ids []string, maps ...*world.Map) *world.Map {
	t.Helper()
	var islands []*world.Island
	sectors := map[string][]*world.Sector{}
	for i, m := range maps {
		src := m.Islands()[0]
		is := *src
		is.ID = ids[i]
		islands = append(islands, &is)
		r := is.Rect
		for _, z := range is.Floors {
			for y := r.Y; y < r.Y+r.H; y += world.SectorSize {
				for x := r.X; x < r.X+r.W; x += world.SectorSize {
					if s := m.SectorAt(world.Pos{X: uint16(x), Y: uint16(y), Z: z}); s != nil {
						sectors[is.ID] = append(sectors[is.ID], s)
					}
				}
			}
		}
	}
	m, err := world.NewMap(islands, sectors, Speeds)
	if err != nil {
		t.Fatal(err)
	}
	return m
}
