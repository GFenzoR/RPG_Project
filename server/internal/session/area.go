package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Areas (docs/02-game-design.md "Puertas con llave"): the tiles of the map joined on foot
// (8 directions, one floor) with every locked door, every house tile and every entrance of
// stairs, a hole or a teleport as a wall (nobody stands on one: stepping onto it moves the
// player, so it joins nothing on foot), and every other door open when its tile lets
// creatures through (roomPassable). initAreas numbers them once at start: the walls never
// change, and doors only open and close. A room behind a locked door is one area
// (checkRooms keeps houses and portal ends out of rooms). The escape check of the locked
// doors (checkEscapes) works on areas, and every search for a free tile by rings stays in
// the area it starts in (areaAllows). Nothing walks the map in the tick: areaOf is one map
// lookup.

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
// (roomPassable), it is no house tile (a house is no street) and no entrance of stairs, a
// hole or a teleport (Map.MovesOnStep: whoever steps onto it is moved, so checkEscapes
// takes it for an edge, not for ground).
func (w *World) areaPassable(p world.Pos) bool {
	return w.roomPassable(p) && w.m.Flags(p)&world.FlagHouse == 0 && !w.m.MovesOnStep(p)
}

// areaOf returns the area of p (initAreas), 0 when p lies in none: a wall, a locked door,
// a house tile, the entrance of stairs, a hole or a teleport, no tile.
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

// searchFrom is where a search for a free tile by rings that starts on p may put a
// creature (areaAllows): the area of p or, when p is the entrance of stairs, a hole or a
// teleport (in no area: stepping onto it moves the player), the areas next to it, the
// only ones a player there could walk to (none is a room: checkRooms keeps portal ends
// out of rooms and initDoors refuses a portal end on a locked door). n is 0 when p lies in
// no area and is no such entrance (a house tile, a locked door) or has no area next to it.
type searchFrom struct {
	n     int
	areas [8]int32
}

// searchFrom returns where a search for a free tile by rings from p may land.
func (w *World) searchFrom(p world.Pos) searchFrom {
	var s searchFrom
	if a := w.areaOf(p); a != 0 {
		s.areas[0], s.n = a, 1
		return s
	}
	if !w.m.MovesOnStep(p) {
		return s
	}
	for e := world.North; e <= world.NorthWest; e++ {
		if q, ok := p.Step(e); ok {
			if a := w.areaOf(q); a != 0 && !slices.Contains(s.areas[:s.n], a) {
				s.areas[s.n] = a
				s.n++
			}
		}
	}
	return s
}

// areaAllows reports whether a search for a free tile by rings that started where from
// says (searchFrom) may put a creature on q: a tile of one of its areas or, from no area
// (a house tile, a locked door), a tile in no room behind a locked door. The rings do not
// follow walls: without this, a crowd next to a locked door would put someone in the room
// behind it (where it opens the door without the key), and a crowded temple or stairs
// someone in a pocket sealed by walls or on the other side of stairs.
func (w *World) areaAllows(from searchFrom, q world.Pos) bool {
	if from.n == 0 {
		return w.roomOf[q] == 0
	}
	return slices.Contains(from.areas[:from.n], w.areaOf(q))
}
