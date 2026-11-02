package world

import (
	"bytes"
	"math/rand/v2"
	"testing"
)

// benchIsland builds a 512x512 island with 3 floors (the size of an official island,
// docs/01-architecture.md) where 1 tile in `blockEvery` blocks movement and sight.
func benchIsland(b *testing.B, blockEvery int) *Map {
	b.Helper()
	r := rand.New(rand.NewPCG(42, 42))
	const side = 512
	is := &Island{ID: "bench", Rect: Rect{X: 4096, Y: 4096, W: side, H: side}, Floors: []uint8{6, 7, 8}, Temple: Pos{X: 4352, Y: 4352, Z: 7}}
	var sectors []*Sector
	for _, z := range is.Floors {
		for cy := 4096 / SectorSize; cy < (4096+side)/SectorSize; cy++ {
			for cx := 4096 / SectorSize; cx < (4096+side)/SectorSize; cx++ {
				s := &Sector{CX: uint16(cx), CY: uint16(cy), Z: z}
				for i := range s.Ground {
					s.Ground[i] = uint16(1 + r.IntN(3))
					if blockEvery > 0 && r.IntN(blockEvery) == 0 {
						s.Flags[i] = FlagBlocksMovement | FlagBlocksSight
						s.Stacks = append(s.Stacks, TileStack{Index: uint16(i), Items: []uint16{5}})
					}
				}
				sectors = append(sectors, s)
			}
		}
	}
	// Terrain speeds like data/items/ground.yaml (100–170).
	m, err := NewMap([]*Island{is}, map[string][]*Sector{"bench": sectors}, []uint16{0, 150, 100, 170})
	if err != nil {
		b.Fatal(err)
	}
	return m
}

func bp(x, y int) Pos { return Pos{X: uint16(4096 + x), Y: uint16(4096 + y), Z: 7} }

// BenchmarkFindPathOpen: a 90-tile click-to-walk across mixed terrain with few obstacles.
func BenchmarkFindPathOpen(b *testing.B) {
	m := benchIsland(b, 20)
	pf := NewPathfinder(m, 0)
	buf := make([]Direction, 0, MaxPathLength)
	from, to := bp(100, 100), bp(190, 160)
	if _, ok := pf.Find(from, to, buf); !ok {
		b.Fatal("no path")
	}
	b.ReportAllocs()
	for b.Loop() {
		buf, _ = pf.Find(from, to, buf)
	}
}

// BenchmarkFindPathShort: the common case, a monster chasing a player 8 tiles away.
func BenchmarkFindPathShort(b *testing.B) {
	m := benchIsland(b, 6)
	pf := NewPathfinder(m, 0)
	buf := make([]Direction, 0, MaxPathLength)
	from, to := bp(200, 200), bp(208, 203)
	for !m.Walkable(to) {
		to.X++
	}
	if _, ok := pf.Find(from, to, buf); !ok {
		b.Fatal("no path")
	}
	b.ReportAllocs()
	for b.Loop() {
		buf, _ = pf.Find(from, to, buf)
	}
}

// BenchmarkFindPathUnreachable: worst case, the goal is walled in and the search runs
// until the node limit.
func BenchmarkFindPathUnreachable(b *testing.B) {
	m := benchIsland(b, 20)
	goal := bp(300, 300)
	for d := range Direction(8) {
		n, _ := goal.Step(d)
		s := m.SectorAt(n)
		s.Flags[(int(n.Y)%SectorSize)*SectorSize+int(n.X)%SectorSize] = FlagBlocksMovement
	}
	s := m.SectorAt(goal)
	s.Flags[(int(goal.Y)%SectorSize)*SectorSize+int(goal.X)%SectorSize] = 0
	pf := NewPathfinder(m, 0)
	buf := make([]Direction, 0, MaxPathLength)
	b.ReportAllocs()
	for b.Loop() {
		buf, _ = pf.Find(bp(250, 250), goal, buf)
	}
}

func BenchmarkLineOfSight(b *testing.B) {
	m := benchIsland(b, 20)
	r := rand.New(rand.NewPCG(1, 1))
	pairs := make([][2]Pos, 1024)
	for i := range pairs {
		a := bp(100+r.IntN(300), 100+r.IntN(300))
		pairs[i] = [2]Pos{a, {X: a.X + uint16(r.IntN(15)) - 7, Y: a.Y + uint16(r.IntN(11)) - 5, Z: 7}}
	}
	b.ReportAllocs()
	i := 0
	for b.Loop() {
		p := pairs[i&1023]
		m.LineOfSight(p[0], p[1])
		i++
	}
}

func BenchmarkWalkable(b *testing.B) {
	m := benchIsland(b, 20)
	b.ReportAllocs()
	i := 0
	for b.Loop() {
		m.Walkable(bp(i&511, (i>>9)&511))
		i++
	}
}

// BenchmarkDecode measures loading world.bin for a 512x512x3 island (startup budget: < 10 s).
func BenchmarkDecode(b *testing.B) {
	m := benchIsland(b, 20)
	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(buf.Len()))
	b.ReportAllocs()
	for b.Loop() {
		if _, err := Decode(buf.Bytes()); err != nil {
			b.Fatal(err)
		}
	}
}
