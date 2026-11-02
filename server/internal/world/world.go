// Package world is the server's in-memory map: tiles grouped in 32x32 sectors per floor,
// with flags precomputed by cmd/mapcompile (docs/03-world-and-maps.md,
// docs/01-architecture.md). It also answers the spatial questions the game loop asks:
// can a creature stand here, which path leads there, is there line of sight.
//
// A Map is immutable after loading and is only read by the game loop goroutine.
package world

import "fmt"

// SectorSize is the side of a sector in tiles. It equals the chunk size of world/ JSON.
const SectorSize = 32

// SectorTiles is the number of tiles in a sector.
const SectorTiles = SectorSize * SectorSize

// MaxFloor is the deepest floor; floors go from 0 (highest) to 15. 7 is sea level.
const MaxFloor = 15

// DefaultGroundSpeed is the terrain cost (percent) of ground items without `ground.speed`.
const DefaultGroundSpeed = 100

// Pos is a tile position in the global coordinate space.
type Pos struct {
	X, Y uint16
	Z    uint8
}

func (p Pos) String() string { return fmt.Sprintf("%d,%d,%d", p.X, p.Y, p.Z) }

// Rect is an axis-aligned rectangle of tiles. W and H can reach 65536.
type Rect struct {
	X, Y, W, H uint32
}

// Contains reports whether the tile (x, y) lies inside r.
func (r Rect) Contains(x, y int) bool {
	return x >= int(r.X) && y >= int(r.Y) && x < int(r.X)+int(r.W) && y < int(r.Y)+int(r.H)
}

// Flags are per-tile properties precomputed at compile time.
type Flags uint8

// Tile flags. A tile with no ground, with non-walkable ground or with an item that blocks
// movement has FlagBlocksMovement. Zone flags come from zones.yaml.
const (
	FlagBlocksMovement Flags = 1 << iota
	FlagBlocksSight
	FlagProtection
	FlagNoLogout
	FlagPvP
	FlagNoPvP
)

// TileStack is the item stack of one tile, bottom to top, as numeric item IDs.
type TileStack struct {
	// Index is the tile index inside its sector: y*SectorSize + x.
	Index uint16
	Items []uint16
}

// Sector is one 32x32 area of a floor. Arrays are indexed by y*SectorSize + x.
type Sector struct {
	CX, CY uint16
	Z      uint8
	// Ground holds the numeric ground item ID of each tile; 0 means no tile.
	Ground [SectorTiles]uint16
	Flags  [SectorTiles]Flags
	// Stacks is sparse and sorted by Index.
	Stacks []TileStack
}

// Stack returns the item stack of the tile at local (lx, ly), or nil.
func (s *Sector) Stack(lx, ly int) []uint16 {
	idx := uint16(ly*SectorSize + lx)
	lo, hi := 0, len(s.Stacks)
	for lo < hi {
		mid := (lo + hi) / 2
		if s.Stacks[mid].Index < idx {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(s.Stacks) && s.Stacks[lo].Index == idx {
		return s.Stacks[lo].Items
	}
	return nil
}

// Island is a rectangle of the world with its own sectors. Its rect is aligned to sectors.
type Island struct {
	ID     string
	Rect   Rect
	Floors []uint8
	Temple Pos
	// Spawns are the island's monster spawns (world/islands/<id>/spawns.yaml).
	Spawns []Spawn
	// NPCs are the NPCs placed on the island (world/islands/<id>/npcs.yaml), in file
	// order. Each data/npcs id appears once in the whole world.
	NPCs []NPCPlacement

	cx0, cy0 int                // first sector column/row
	cw, ch   int                // sectors per row/column
	layer    [MaxFloor + 1]int8 // floor → layer in sectors (ascending z), -1 if not listed
	sectors  []*Sector
}

// sectorSlot returns the index in is.sectors of a sector inside the rect, or -1 when the
// island does not list floor z.
func (is *Island) sectorSlot(z, cx, cy int) int {
	l := int(is.layer[z])
	if l < 0 {
		return -1
	}
	return (l*is.ch+(cy-is.cy0))*is.cw + (cx - is.cx0)
}

// Sectors returns the island's sectors that have tiles, ordered by z, cy, cx.
func (is *Island) Sectors() []*Sector {
	var out []*Sector
	for _, s := range is.sectors {
		if s != nil {
			out = append(out, s)
		}
	}
	return out
}

// Spawn is a monster spawn: Monsters appear on free walkable tiles within Radius
// (Chebyshev) of Center and come back RespawnSeconds after they die.
type Spawn struct {
	ID             string
	Center         Pos
	Radius         uint8
	RespawnSeconds uint32
	Monsters       []SpawnMonster
}

// Limits of the spawns of one island: a typo or a crafted world.bin must not make the
// server create millions of monsters.
const (
	MaxSpawnMonsters  = 100   // monsters one spawn keeps
	MaxIslandMonsters = 20000 // monsters all the spawns of an island keep
)

// NPCPlacement is an NPC (data/npcs id) standing on a tile.
type NPCPlacement struct {
	NPC string
	Pos Pos
}

// SpawnMonster is how many monsters of one kind (data/monsters id) a spawn keeps.
type SpawnMonster struct {
	Monster string
	Count   uint16
}

// Map is the whole loaded world.
type Map struct {
	islands []*Island
	// groundSpeed is indexed by numeric item ID; 0 means DefaultGroundSpeed.
	groundSpeed []uint16
	minSpeed    int32
}

// NewMap builds a Map. Island IDs must be unique, rects aligned to SectorSize and disjoint,
// floors strictly ascending in 0..MaxFloor, the temple inside the island, and every sector inside its island
// on one of its floors. groundSpeed is indexed by
// numeric item ID (0 = DefaultGroundSpeed).
func NewMap(islands []*Island, sectors map[string][]*Sector, groundSpeed []uint16) (*Map, error) {
	m := &Map{groundSpeed: groundSpeed}
	npcs := map[string]bool{}
	for i, is := range islands {
		if err := checkIsland(is); err != nil {
			return nil, err
		}
		for _, n := range is.NPCs {
			if npcs[n.NPC] {
				return nil, fmt.Errorf("island %q: NPC %q is placed twice", is.ID, n.NPC)
			}
			npcs[n.NPC] = true
		}
		r := is.Rect
		for _, other := range islands[:i] {
			if other.ID == is.ID {
				return nil, fmt.Errorf("island %q is listed twice", is.ID)
			}
			o := other.Rect
			if r.X < o.X+o.W && o.X < r.X+r.W && r.Y < o.Y+o.H && o.Y < r.Y+r.H {
				return nil, fmt.Errorf("island %q overlaps island %q", is.ID, other.ID)
			}
		}
		is.cx0, is.cy0 = int(r.X/SectorSize), int(r.Y/SectorSize)
		is.cw, is.ch = int(r.W/SectorSize), int(r.H/SectorSize)
		layers := 0
		for z := range is.layer {
			is.layer[z] = -1
			if is.hasFloor(uint8(z)) {
				is.layer[z] = int8(layers)
				layers++
			}
		}
		is.sectors = make([]*Sector, layers*is.cw*is.ch)
		for _, s := range sectors[is.ID] {
			if !is.hasFloor(s.Z) {
				return nil, fmt.Errorf("island %q: sector %d,%d on floor %d, which the island does not list", is.ID, s.CX, s.CY, s.Z)
			}
			cx, cy := int(s.CX), int(s.CY)
			if cx < is.cx0 || cy < is.cy0 || cx >= is.cx0+is.cw || cy >= is.cy0+is.ch {
				return nil, fmt.Errorf("island %q: sector %d,%d,%d lies outside the island", is.ID, s.CX, s.CY, s.Z)
			}
			slot := is.sectorSlot(int(s.Z), cx, cy)
			if is.sectors[slot] != nil {
				return nil, fmt.Errorf("island %q: sector %d,%d,%d appears twice", is.ID, s.CX, s.CY, s.Z)
			}
			is.sectors[slot] = s
		}
		m.islands = append(m.islands, is)
	}
	m.minSpeed = m.slowestCost()
	return m, nil
}

// slowestCost is the lowest terrain cost among the walkable tiles of the map (the A*
// heuristic must not exceed it), or DefaultGroundSpeed for a map without walkable tiles.
func (m *Map) slowestCost() int32 {
	var seen [1 << 16]bool
	best := int32(0)
	for _, is := range m.islands {
		for _, s := range is.sectors {
			if s == nil {
				continue
			}
			for i, g := range s.Ground {
				if g == 0 || seen[g] || s.Flags[i]&FlagBlocksMovement != 0 {
					continue
				}
				seen[g] = true
				if c := m.speed(g); best == 0 || c < best {
					best = c
				}
			}
		}
	}
	if best == 0 {
		return DefaultGroundSpeed
	}
	return best
}

// checkIsland validates an island's metadata so that later arithmetic cannot overflow or
// index out of range, whatever the input.
func checkIsland(is *Island) error {
	r := is.Rect
	if r.X%SectorSize != 0 || r.Y%SectorSize != 0 || r.W%SectorSize != 0 || r.H%SectorSize != 0 || r.W == 0 || r.H == 0 {
		return fmt.Errorf("island %q: rect %+v is not aligned to %d-tile sectors", is.ID, r, SectorSize)
	}
	if uint64(r.X)+uint64(r.W) > 65536 || uint64(r.Y)+uint64(r.H) > 65536 {
		return fmt.Errorf("island %q: rect %+v leaves the world", is.ID, r)
	}
	if len(is.Floors) == 0 {
		return fmt.Errorf("island %q: no floors", is.ID)
	}
	// Strictly ascending in 0..MaxFloor, like island.yaml (packages/map-format): this also
	// rules out duplicates and lists longer than MaxFloor+1.
	for i, f := range is.Floors {
		if f > MaxFloor {
			return fmt.Errorf("island %q: floor %d outside 0..%d", is.ID, f, MaxFloor)
		}
		if i > 0 && f <= is.Floors[i-1] {
			return fmt.Errorf("island %q: floors %v must be strictly ascending", is.ID, is.Floors)
		}
	}
	t := is.Temple
	if !r.Contains(int(t.X), int(t.Y)) || !is.hasFloor(t.Z) {
		return fmt.Errorf("island %q: temple %v is outside the island or on a floor it does not list", is.ID, t)
	}
	total := 0
	for _, sp := range is.Spawns {
		c := sp.Center
		if !r.Contains(int(c.X), int(c.Y)) || !is.hasFloor(c.Z) {
			return fmt.Errorf("island %q: spawn %q center %v is outside the island or on a floor it does not list", is.ID, sp.ID, c)
		}
		if sp.ID == "" || sp.RespawnSeconds == 0 || len(sp.Monsters) == 0 {
			return fmt.Errorf("island %q: spawn %q needs an id, respawn_seconds > 0 and monsters", is.ID, sp.ID)
		}
		n := 0
		for _, m := range sp.Monsters {
			if m.Monster == "" || m.Count == 0 {
				return fmt.Errorf("island %q: spawn %q: empty monster id or zero count", is.ID, sp.ID)
			}
			n += int(m.Count)
		}
		if n > MaxSpawnMonsters {
			return fmt.Errorf("island %q: spawn %q keeps %d monsters, at most %d", is.ID, sp.ID, n, MaxSpawnMonsters)
		}
		if total += n; total > MaxIslandMonsters {
			return fmt.Errorf("island %q: spawns keep more than %d monsters", is.ID, MaxIslandMonsters)
		}
	}
	for _, n := range is.NPCs {
		if n.NPC == "" || !r.Contains(int(n.Pos.X), int(n.Pos.Y)) || !is.hasFloor(n.Pos.Z) {
			return fmt.Errorf("island %q: NPC %q at %v needs an id and a tile inside the island", is.ID, n.NPC, n.Pos)
		}
	}
	return nil
}

func (is *Island) hasFloor(z uint8) bool {
	for _, f := range is.Floors {
		if f == z {
			return true
		}
	}
	return false
}

// Islands returns the islands in load order.
func (m *Map) Islands() []*Island { return m.islands }

// Island returns the island with the given ID, or nil.
func (m *Map) Island(id string) *Island {
	for _, is := range m.islands {
		if is.ID == id {
			return is
		}
	}
	return nil
}

// GroundSpeeds returns the terrain cost table indexed by numeric item ID (0 = default).
func (m *Map) GroundSpeeds() []uint16 { return m.groundSpeed }

// sectorAt returns the sector holding tile (x, y, z) and the tile index inside it.
// Coordinates outside the world are accepted and simply have no sector.
func (m *Map) sectorAt(x, y, z int) (*Sector, int) {
	if x < 0 || y < 0 || z < 0 || z > MaxFloor {
		return nil, 0
	}
	for _, is := range m.islands {
		if !is.Rect.Contains(x, y) {
			continue
		}
		slot := is.sectorSlot(z, x/SectorSize, y/SectorSize)
		if slot < 0 || is.sectors[slot] == nil {
			return nil, 0
		}
		return is.sectors[slot], (y%SectorSize)*SectorSize + x%SectorSize
	}
	return nil, 0
}

// SectorAt returns the sector containing p, or nil when there are no tiles there.
func (m *Map) SectorAt(p Pos) *Sector {
	s, _ := m.sectorAt(int(p.X), int(p.Y), int(p.Z))
	return s
}

// Tile returns the ground item ID and flags of p. ok is false when p has no tile.
func (m *Map) Tile(p Pos) (ground uint16, flags Flags, ok bool) {
	return m.tile(int(p.X), int(p.Y), int(p.Z))
}

func (m *Map) tile(x, y, z int) (uint16, Flags, bool) {
	s, i := m.sectorAt(x, y, z)
	if s == nil || s.Ground[i] == 0 {
		return 0, FlagBlocksMovement, false
	}
	return s.Ground[i], s.Flags[i], true
}

// Flags returns the flags of p. Positions without a tile block movement.
func (m *Map) Flags(p Pos) Flags {
	_, f, _ := m.Tile(p)
	return f
}

// Walkable reports whether a creature can stand on p (ignoring creatures).
func (m *Map) Walkable(p Pos) bool {
	return m.Flags(p)&FlagBlocksMovement == 0
}

// Stack returns the item stack of p, bottom to top, or nil.
func (m *Map) Stack(p Pos) []uint16 {
	s, i := m.sectorAt(int(p.X), int(p.Y), int(p.Z))
	if s == nil {
		return nil
	}
	return s.Stack(i%SectorSize, i/SectorSize)
}

// speed returns the terrain cost (percent) of entering a tile with the given ground.
func (m *Map) speed(ground uint16) int32 {
	if int(ground) < len(m.groundSpeed) {
		if s := m.groundSpeed[ground]; s != 0 {
			return int32(s)
		}
	}
	return DefaultGroundSpeed
}
