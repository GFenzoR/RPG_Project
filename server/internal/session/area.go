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
// doors (checkEscapes) works on areas, and every search for a free tile by rings stays
// where a player at its origin could walk (searchFrom, areaAllows). Nothing walks the map
// in the tick: areaOf is one map lookup.
//
// The tiles of a house are numbered apart, as house areas: the tiles of one house joined
// on foot inside it (the same walls and doors). They are no area (a house is no street:
// the escape check takes them for a wall), only the place a search that starts in a house
// may stay in.

// areaTiles is the area of each tile of one sector, indexed like world.Sector: an area id
// (> 0), minus the id of a house area (< 0), or 0 for none.
type areaTiles [world.SectorTiles]int32

// initAreas numbers the areas and the house areas of the map, sector by sector in map
// order (islands, then z, cy, cx), each with a walk from its first tile. Only the sectors
// that hold a tile of one take memory (4 KiB each; docs/07): house areas share them.
func (w *World) initAreas() {
	w.areas = map[uint64]*areaTiles{}
	w.areaCount, w.houseAreaCount = 0, 0
	var stack []world.Pos
	for _, is := range w.m.Islands() {
		for _, s := range is.Sectors() {
			for i := range world.SectorTiles {
				p := world.Pos{
					X: s.CX*world.SectorSize + uint16(i%world.SectorSize),
					Y: s.CY*world.SectorSize + uint16(i/world.SectorSize),
					Z: s.Z,
				}
				if w.tileArea(p) != 0 {
					continue
				}
				var id int32
				var joins func(world.Pos) bool
				switch {
				case w.areaPassable(p):
					w.areaCount++
					id, joins = w.areaCount, w.areaPassable
				case w.housePassable(p):
					w.houseAreaCount++
					h := w.m.HouseAt(p)
					id = -w.houseAreaCount
					joins = func(q world.Pos) bool { return w.housePassable(q) && w.m.HouseAt(q) == h }
				default:
					continue
				}
				w.setArea(p, id)
				stack = append(stack[:0], p)
				for len(stack) > 0 {
					t := stack[len(stack)-1]
					stack = stack[:len(stack)-1]
					for e := world.North; e <= world.NorthWest; e++ {
						if q, ok := t.Step(e); ok && w.tileArea(q) == 0 && joins(q) {
							w.setArea(q, id)
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

// housePassable reports whether p belongs to a house area: a house tile the walks of the
// rooms go through (no portal end lies in a house: world.NewMap).
func (w *World) housePassable(p world.Pos) bool {
	return w.m.Flags(p)&world.FlagHouse != 0 && w.roomPassable(p) && !w.m.MovesOnStep(p)
}

// tileArea returns the entry of p in the areas: an area (> 0), minus a house area (< 0),
// or 0 when p lies in neither (a wall, a locked door, the entrance of stairs, a hole or a
// teleport, no tile).
func (w *World) tileArea(p world.Pos) int32 {
	if a := w.areas[sectorKey(int(p.X), int(p.Y), p.Z)]; a != nil {
		return a[int(p.Y)%world.SectorSize*world.SectorSize+int(p.X)%world.SectorSize]
	}
	return 0
}

// areaOf returns the area of p (initAreas), 0 when p lies in none: a wall, a locked door,
// a house tile, the entrance of stairs, a hole or a teleport, no tile.
func (w *World) areaOf(p world.Pos) int32 { return max(w.tileArea(p), 0) }

// setArea puts p in area id (minus a house area).
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
// creature (areaAllows): the entries of the areas (tileArea) a player on p could walk to.
//   - A tile of an area: that area.
//   - A house tile (logging in where one logged out, a /tp of the staff): its house area
//     and where the exit of its house leads (the street a player inside walks out to).
//   - The entrance of stairs, a hole or a teleport (stepping onto it moves the player):
//     the areas next to it, the only ones a player there could walk to (none is a room:
//     checkRooms keeps portal ends out of rooms and initDoors refuses a portal end on a
//     locked door).
//   - A locked door (a player logged out in its doorway, a /tp of the staff): the areas
//     next to it but its room, its outside. Whoever stood there came from the outside or
//     from the room, which the door opens onto the outside without the key; the room needs
//     the key, so a search never ends there.
//   - Anything else (a wall, no tile): nowhere. The search finds nothing and its caller
//     falls back (the temple, the exit, a refusal) rather than guess.
type searchFrom struct {
	n     int
	areas [9]int32
}

// add puts entry a (an area, or minus a house area) in s, once.
func (s *searchFrom) add(a int32) {
	if a != 0 && s.n < len(s.areas) && !slices.Contains(s.areas[:s.n], a) {
		s.areas[s.n] = a
		s.n++
	}
}

// searchFrom returns where a search for a free tile by rings from p may land.
func (w *World) searchFrom(p world.Pos) searchFrom {
	var s searchFrom
	if a := w.tileArea(p); a < 0 {
		s.add(a)
		if h := w.m.HouseAt(p); h != nil {
			w.streetFrom(h.Exit, &s)
		}
		return s
	}
	w.streetFrom(p, &s)
	return s
}

// streetFrom adds to s the areas a player on p, no house tile, walks to (searchFrom).
func (w *World) streetFrom(p world.Pos, s *searchFrom) {
	if a := w.areaOf(p); a != 0 {
		s.add(a)
		return
	}
	d := w.doors[p]
	locked := d != nil && d.lock != ""
	if !locked && !w.m.MovesOnStep(p) {
		return
	}
	for e := world.North; e <= world.NorthWest; e++ {
		if q, ok := p.Step(e); ok && (!locked || !d.inRoom(w.roomOf[q])) {
			s.add(w.areaOf(q))
		}
	}
}

// areaAllows reports whether a search for a free tile by rings that started where from
// says (searchFrom) may put a creature on q: a tile of one of its areas or house areas.
// The rings do not follow walls: without this, a crowd next to a locked door would put
// someone in the room behind it (where it opens the door without the key), and a crowded
// temple, stairs or house someone in a pocket sealed by walls, on the other side of stairs
// or in another house.
func (w *World) areaAllows(from searchFrom, q world.Pos) bool {
	return slices.Contains(from.areas[:from.n], w.tileArea(q))
}
