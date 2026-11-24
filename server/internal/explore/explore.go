// Package explore keeps what a character has explored of the map, for the minimap's fog
// (docs/02 "Minimapa", docs/05 "Minimapa"): one bit per tile, a 128-byte bitset per sector
// of 32x32 tiles of one floor, only for the sectors the character has seen part of.
//
// A Map belongs to the game loop (one per online player); nothing in it locks. Bits are
// only ever set, never cleared, so any later copy of a sector is a superset of an earlier
// one: the persistence side may overwrite a saved sector with a newer copy, and two copies
// merge with OR.
package explore

import (
	"cmp"
	"maps"
	"slices"
)

// SectorSize is the side of a sector in tiles (world.SectorSize, the chunk of world/).
const SectorSize = 32

// SectorBytes is the size of a sector's bitset: one bit per tile, row by row (y, then x),
// bit x%8 of byte (y*32+x)/8.
const SectorBytes = SectorSize * SectorSize / 8

// MaxSectors bounds the sectors one character keeps (128 bytes each, 512 KB at most). The
// whole world is far smaller (docs/07 "Minimapa"); past it, new sectors are not explored.
const MaxSectors = 4096

// MaxFloor is the deepest floor (world.MaxFloor).
const MaxFloor = 15

// Key names one sector: its floor and its column and row of sectors (x/32, y/32).
type Key uint32

// KeyOf is the key of the sector holding tile x, y on floor z.
func KeyOf(x, y int, z uint8) Key {
	return Key(uint32(z)<<24 | uint32(x/SectorSize)<<12 | uint32(y/SectorSize))
}

// MakeKey builds a key from a floor and sector coordinates (sx, sy < 4096).
func MakeKey(z uint8, sx, sy int) Key {
	return Key(uint32(z)<<24 | uint32(sx&0xFFF)<<12 | uint32(sy&0xFFF))
}

// Z is the key's floor.
func (k Key) Z() uint8 { return uint8(k >> 24) }

// SX is the key's sector column (x / 32).
func (k Key) SX() int { return int(k>>12) & 0xFFF }

// SY is the key's sector row (y / 32).
func (k Key) SY() int { return int(k) & 0xFFF }

// Wire is the key as the protocol sends it within one floor: sx<<16 | sy (docs/05).
func (k Key) Wire() uint32 { return uint32(k.SX())<<16 | uint32(k.SY()) }

// FromWire is the key of a protocol sector id on floor z; ok is false for one outside the
// map (sx or sy of 4096 or more).
func FromWire(z uint8, id uint32) (Key, bool) {
	sx, sy := int(id>>16), int(id&0xFFFF)
	if sx >= 1<<12 || sy >= 1<<12 || z > MaxFloor {
		return 0, false
	}
	return MakeKey(z, sx, sy), true
}

// Sector is one sector's bitset.
type Sector [SectorBytes]byte

// Has reports whether local tile lx, ly (0..31) is explored.
func (s *Sector) Has(lx, ly int) bool {
	i := ly*SectorSize + lx
	return s[i>>3]&(1<<(i&7)) != 0
}

// Empty reports whether no tile of s is explored.
func (s *Sector) Empty() bool { return *s == Sector{} }

// SectorState is one sector with its bits, as saved and loaded.
type SectorState struct {
	Key  Key
	Bits Sector
}

// Map is a character's explored tiles.
type Map struct {
	sectors map[Key]*Sector
	// touched: the sectors that gained bits since the Map was made (or were marked with
	// Touch): what a snapshot of this login writes. Never cleared: a dropped snapshot
	// costs nothing, the next one carries them again.
	touched map[Key]struct{}
	// pending: the sectors that gained bits since the last TakePending (the client's
	// deltas).
	pending map[Key]struct{}
}

// New returns an empty Map.
func New() *Map {
	return &Map{sectors: map[Key]*Sector{}, touched: map[Key]struct{}{}, pending: map[Key]struct{}{}}
}

// Load returns a Map with the saved sectors (merged with OR when one repeats). Sectors on
// no floor of the map, empty ones and those past MaxSectors are dropped. Loaded sectors
// are not touched.
func Load(saved []SectorState) *Map {
	m := New()
	for _, s := range saved {
		m.merge(s)
	}
	return m
}

func (m *Map) merge(s SectorState) bool {
	if s.Key.Z() > MaxFloor || s.Bits.Empty() {
		return false
	}
	cur := m.sectors[s.Key]
	if cur == nil {
		if len(m.sectors) >= MaxSectors {
			return false
		}
		b := s.Bits
		m.sectors[s.Key] = &b
		return true
	}
	changed := false
	for i, v := range s.Bits {
		if cur[i]|v != cur[i] {
			cur[i] |= v
			changed = true
		}
	}
	return changed
}

// Merge ORs sectors into m and marks the ones that gained bits as touched (a state carried
// over from a login whose last save may not be written yet).
func (m *Map) Merge(sectors []SectorState) {
	for _, s := range sectors {
		if m.merge(s) {
			m.touched[s.Key] = struct{}{}
		}
	}
}

// Touch marks keys as touched (written by the next snapshot), if m has them.
func (m *Map) Touch(keys []Key) {
	for _, k := range keys {
		if m.sectors[k] != nil {
			m.touched[k] = struct{}{}
		}
	}
}

// Len is the number of sectors with an explored tile.
func (m *Map) Len() int { return len(m.sectors) }

// Has reports whether tile x, y on floor z is explored.
func (m *Map) Has(x, y int, z uint8) bool {
	if x < 0 || y < 0 {
		return false
	}
	s := m.sectors[KeyOf(x, y, z)]
	return s != nil && s.Has(x%SectorSize, y%SectorSize)
}

// Sector returns the bitset of sector k, or nil when nothing of it is explored. The caller
// must not change it.
func (m *Map) Sector(k Key) *Sector { return m.sectors[k] }

// Reveal explores the tiles of the rectangle x0..x1, y0..y1 (inclusive, clipped to the
// map's 0..65535) on floor z. It returns how many sectors gained a bit. Cost: one OR per
// row and sector the rectangle crosses (21 rows of two or three sectors for the view).
func (m *Map) Reveal(x0, y0, x1, y1 int, z uint8) int {
	x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, 0xFFFF), min(y1, 0xFFFF)
	if x0 > x1 || y0 > y1 || z > MaxFloor {
		return 0
	}
	n := 0
	for sy := y0 / SectorSize; sy <= y1/SectorSize; sy++ {
		ly0, ly1 := max(y0-sy*SectorSize, 0), min(y1-sy*SectorSize, SectorSize-1)
		for sx := x0 / SectorSize; sx <= x1/SectorSize; sx++ {
			lx0, lx1 := max(x0-sx*SectorSize, 0), min(x1-sx*SectorSize, SectorSize-1)
			if m.revealIn(MakeKey(z, sx, sy), lx0, ly0, lx1, ly1) {
				n++
			}
		}
	}
	return n
}

// rowMask is the 32-bit mask of columns lx0..lx1 of a row.
func rowMask(lx0, lx1 int) uint32 {
	return uint32((uint64(1)<<(lx1+1) - 1) &^ (uint64(1)<<lx0 - 1))
}

func (m *Map) revealIn(k Key, lx0, ly0, lx1, ly1 int) bool {
	s := m.sectors[k]
	if s == nil {
		if len(m.sectors) >= MaxSectors {
			return false
		}
		s = &Sector{}
	}
	mask := rowMask(lx0, lx1)
	changed := false
	for ly := ly0; ly <= ly1; ly++ {
		o := ly * 4 // a row is 4 bytes, little-endian bit order
		for b := range 4 {
			v := byte(mask >> (8 * b))
			if s[o+b]|v != s[o+b] {
				s[o+b] |= v
				changed = true
			}
		}
	}
	if changed {
		m.sectors[k] = s
		m.touched[k] = struct{}{}
		m.pending[k] = struct{}{}
	}
	return changed
}

// Keys returns the sectors of floor z with an explored tile, sorted.
func (m *Map) Keys(z uint8) []Key {
	var out []Key
	for k := range m.sectors {
		if k.Z() == z {
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return out
}

// Floors returns the floors with an explored tile, ascending.
func (m *Map) Floors() []uint8 {
	var seen [MaxFloor + 1]bool
	for k := range m.sectors {
		seen[k.Z()] = true
	}
	var out []uint8
	for z, ok := range seen {
		if ok {
			out = append(out, uint8(z))
		}
	}
	return out
}

// TakePending returns the sectors that gained bits since the last call, sorted, and
// forgets them.
func (m *Map) TakePending() []Key {
	if len(m.pending) == 0 {
		return nil
	}
	out := slices.Sorted(maps.Keys(m.pending))
	clear(m.pending)
	return out
}

// Touched returns a copy of every touched sector, sorted by key: what a snapshot writes.
// A nil Map has none.
func (m *Map) Touched() []SectorState {
	if m == nil {
		return nil
	}
	return m.states(m.touched)
}

// TouchedKeys returns the touched sectors' keys, sorted.
func (m *Map) TouchedKeys() []Key { return slices.Sorted(maps.Keys(m.touched)) }

// All returns a copy of every sector, sorted by key (none for a nil Map).
func (m *Map) All() []SectorState {
	if m == nil {
		return nil
	}
	out := make([]SectorState, 0, len(m.sectors))
	for k, s := range m.sectors {
		out = append(out, SectorState{Key: k, Bits: *s})
	}
	slices.SortFunc(out, func(a, b SectorState) int { return cmp.Compare(a.Key, b.Key) })
	return out
}

func (m *Map) states(keys map[Key]struct{}) []SectorState {
	if len(keys) == 0 {
		return nil
	}
	out := make([]SectorState, 0, len(keys))
	for _, k := range slices.Sorted(maps.Keys(keys)) {
		if s := m.sectors[k]; s != nil {
			out = append(out, SectorState{Key: k, Bits: *s})
		}
	}
	return out
}
