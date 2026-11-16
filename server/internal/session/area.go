package session

import "github.com/GFenzoR/RPG_Project/server/internal/world"

// Areas (docs/02-game-design.md "Puertas con llave"): the tiles of the map joined on foot
// (8 directions, one floor) with every locked door and every house tile as a wall and
// every other door open when its tile lets creatures through (roomPassable). initAreas
// numbers them once at start: the walls never change, and doors only open and close. A
// room behind a locked door is one area (checkRooms keeps houses out of rooms). The escape
// check of the locked doors (checkEscapes) works on areas. Nothing walks the map in the
// tick: areaOf is one map lookup.

// areaTiles is the area of each tile of one sector (0: none), indexed like world.Sector.
type areaTiles [world.SectorTiles]int32

// initAreas numbers the areas of the map, sector by sector in map order (islands, then z,
// cy, cx), each with a walk from its first tile. Only the sectors that hold a tile of an
// area take memory (4 KiB each; docs/07).
func (w *World) initAreas() {
	w.areas = map[uint64]*areaTiles{}
	w.areaCount = 0
	var stack []world.Pos
	for _, is := range w.m.Islands() {
		for _, s := range is.Sectors() {
			for i := range world.SectorTiles {
				p := world.Pos{
					X: s.CX*world.SectorSize + uint16(i%world.SectorSize),
					Y: s.CY*world.SectorSize + uint16(i/world.SectorSize),
					Z: s.Z,
				}
				if w.areaOf(p) != 0 || !w.areaPassable(p) {
					continue
				}
				w.areaCount++
				w.setArea(p, w.areaCount)
				stack = append(stack[:0], p)
				for len(stack) > 0 {
					t := stack[len(stack)-1]
					stack = stack[:len(stack)-1]
					for e := world.North; e <= world.NorthWest; e++ {
						if q, ok := t.Step(e); ok && w.areaOf(q) == 0 && w.areaPassable(q) {
							w.setArea(q, w.areaCount)
							stack = append(stack, q)
						}
					}
				}
			}
		}
	}
}

// areaPassable reports whether p belongs to an area: the walks of the rooms go through it
// (roomPassable) and it is no house tile (a house is no street).
func (w *World) areaPassable(p world.Pos) bool {
	return w.roomPassable(p) && w.m.Flags(p)&world.FlagHouse == 0
}

// areaOf returns the area of p (initAreas), 0 when p lies in none: a wall, a locked door,
// a house tile, no tile.
func (w *World) areaOf(p world.Pos) int32 {
	if a := w.areas[sectorKey(int(p.X), int(p.Y), p.Z)]; a != nil {
		return a[int(p.Y)%world.SectorSize*world.SectorSize+int(p.X)%world.SectorSize]
	}
	return 0
}

// setArea puts p in area id.
func (w *World) setArea(p world.Pos, id int32) {
	k := sectorKey(int(p.X), int(p.Y), p.Z)
	a := w.areas[k]
	if a == nil {
		a = new(areaTiles)
		w.areas[k] = a
	}
	a[int(p.Y)%world.SectorSize*world.SectorSize+int(p.X)%world.SectorSize] = id
}
