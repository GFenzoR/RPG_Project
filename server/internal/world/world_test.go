package world

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
)

// Ground IDs and speeds used by the ASCII test maps.
const (
	tGrass = 1 // speed 150
	tRoad  = 2 // speed 50
	tFloor = 3 // no speed: DefaultGroundSpeed
)

var testSpeeds = []uint16{0, 150, 50, 0}

// asciiMap builds a one-island map whose top-left tile is (ox, oy, z) from rows of:
//
//	.  grass        =  road        _  floor (default speed)
//	#  wall (blocks movement and sight)
//	|  blocks sight only    ~  blocks movement only (water)
//	   (space) no tile
//
// The island rect is the smallest sector-aligned rect that holds the drawing.
func asciiMap(t testing.TB, ox, oy int, z uint8, rows ...string) *Map {
	t.Helper()
	w := 0
	for _, r := range rows {
		w = max(w, len(r))
	}
	x0, y0 := ox/SectorSize*SectorSize, oy/SectorSize*SectorSize
	x1 := (ox + w + SectorSize - 1) / SectorSize * SectorSize
	y1 := (oy + len(rows) + SectorSize - 1) / SectorSize * SectorSize
	is := &Island{
		ID:     "test",
		Rect:   Rect{X: uint32(x0), Y: uint32(y0), W: uint32(x1 - x0), H: uint32(y1 - y0)},
		Floors: []uint8{z},
		Temple: Pos{X: uint16(ox), Y: uint16(oy), Z: z},
	}
	byKey := map[[2]int]*Sector{}
	var list []*Sector
	for y, row := range rows {
		for x, c := range row {
			gx, gy := ox+x, oy+y
			key := [2]int{gx / SectorSize, gy / SectorSize}
			s := byKey[key]
			if s == nil {
				s = &Sector{CX: uint16(key[0]), CY: uint16(key[1]), Z: z}
				for i := range s.Flags {
					s.Flags[i] = FlagBlocksMovement
				}
				byKey[key] = s
				list = append(list, s)
			}
			i := (gy%SectorSize)*SectorSize + gx%SectorSize
			var g uint16
			var f Flags
			switch c {
			case '.':
				g = tGrass
			case '=':
				g = tRoad
			case '_':
				g = tFloor
			case '#':
				g, f = tGrass, FlagBlocksMovement|FlagBlocksSight
			case '|':
				g, f = tGrass, FlagBlocksSight
			case '~':
				g, f = tFloor, FlagBlocksMovement
			case ' ':
				f = FlagBlocksMovement
			default:
				t.Fatalf("unknown map char %q", c)
			}
			s.Ground[i], s.Flags[i] = g, f
		}
	}
	m, err := NewMap([]*Island{is}, map[string][]*Sector{"test": list}, testSpeeds)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func pt(x, y int) Pos { return Pos{X: uint16(x), Y: uint16(y), Z: 7} }

// walk applies a path and fails if a step is not walkable; it returns the end position.
func walk(t testing.TB, m *Map, from Pos, path []Direction) Pos {
	t.Helper()
	p := from
	for i, d := range path {
		next, ok := p.Step(d)
		if !ok || !m.Walkable(next) {
			t.Fatalf("step %d (%v) from %v enters a blocked tile %v", i, d, p, next)
		}
		p = next
	}
	return p
}

// pathCost is the cost of a path in Pathfinder units (2×speed straight, 3×speed diagonal).
func pathCost(m *Map, from Pos, path []Direction) int32 {
	var c int32
	p := from
	for _, d := range path {
		p, _ = p.Step(d)
		g, _, _ := m.Tile(p)
		if d.Diagonal() {
			c += 3 * m.speed(g)
		} else {
			c += 2 * m.speed(g)
		}
	}
	return c
}

func TestTileLookup(t *testing.T) {
	m := asciiMap(t, 30, 30, 7,
		"..#",
		"| ~",
	)
	cases := []struct {
		p      Pos
		ground uint16
		flags  Flags
		walk   bool
	}{
		{pt(30, 30), tGrass, 0, true},
		{pt(32, 30), tGrass, FlagBlocksMovement | FlagBlocksSight, false},
		{pt(30, 31), tGrass, FlagBlocksSight, true},
		{pt(31, 31), 0, FlagBlocksMovement, false},
		{pt(32, 31), tFloor, FlagBlocksMovement, false},
		{pt(29, 29), 0, FlagBlocksMovement, false},              // in the island, outside the drawing
		{pt(500, 500), 0, FlagBlocksMovement, false},            // outside every island
		{Pos{X: 30, Y: 30, Z: 6}, 0, FlagBlocksMovement, false}, // floor not loaded
	}
	for _, c := range cases {
		g, f, _ := m.Tile(c.p)
		if g != c.ground || f != c.flags || m.Walkable(c.p) != c.walk {
			t.Errorf("%v: ground %d flags %b walkable %v, want %d %b %v", c.p, g, f, m.Walkable(c.p), c.ground, c.flags, c.walk)
		}
	}
	// The drawing spans sectors (0,0) and (1,0).
	if s := m.SectorAt(pt(32, 30)); s == nil || s.CX != 1 || s.CY != 0 {
		t.Errorf("SectorAt(32,30) = %+v", s)
	}
}

func TestSectorStack(t *testing.T) {
	s := &Sector{Stacks: []TileStack{{Index: 3, Items: []uint16{7}}, {Index: 40, Items: []uint16{8, 9}}, {Index: 1023, Items: []uint16{1}}}}
	if got := s.Stack(3, 0); !reflect.DeepEqual(got, []uint16{7}) {
		t.Errorf("Stack(3,0) = %v", got)
	}
	if got := s.Stack(8, 1); !reflect.DeepEqual(got, []uint16{8, 9}) {
		t.Errorf("Stack(8,1) = %v", got)
	}
	if got := s.Stack(31, 31); !reflect.DeepEqual(got, []uint16{1}) {
		t.Errorf("Stack(31,31) = %v", got)
	}
	if got := s.Stack(4, 0); got != nil {
		t.Errorf("Stack(4,0) = %v, want nil", got)
	}
}

func TestNewMapErrors(t *testing.T) {
	sec := func(cx, cy uint16, z uint8) *Sector { return &Sector{CX: cx, CY: cy, Z: z} }
	cases := []struct {
		name    string
		islands []*Island
		sectors map[string][]*Sector
		want    string
	}{
		{"unaligned", []*Island{{ID: "a", Rect: Rect{X: 0, Y: 0, W: 40, H: 32}, Floors: []uint8{7}}}, nil, "not aligned"},
		{"empty", []*Island{{ID: "a", Rect: Rect{X: 0, Y: 0, W: 0, H: 32}, Floors: []uint8{7}}}, nil, "not aligned"},
		{"leaves world", []*Island{{ID: "a", Rect: Rect{X: 65504, Y: 0, W: 64, H: 32}, Floors: []uint8{7}}}, nil, "leaves the world"},
		{"overlap", []*Island{
			{ID: "a", Rect: Rect{X: 0, Y: 0, W: 64, H: 64}, Floors: []uint8{7}},
			{ID: "b", Rect: Rect{X: 32, Y: 32, W: 64, H: 64}, Floors: []uint8{7}},
		}, nil, "overlaps"},
		{"floor", []*Island{{ID: "a", Rect: Rect{X: 0, Y: 0, W: 32, H: 32}, Floors: []uint8{7}}},
			map[string][]*Sector{"a": {sec(0, 0, 8)}}, "floor 8"},
		{"outside", []*Island{{ID: "a", Rect: Rect{X: 0, Y: 0, W: 32, H: 32}, Floors: []uint8{7}}},
			map[string][]*Sector{"a": {sec(1, 0, 7)}}, "outside"},
		{"twice", []*Island{{ID: "a", Rect: Rect{X: 0, Y: 0, W: 32, H: 32}, Floors: []uint8{7}}},
			map[string][]*Sector{"a": {sec(0, 0, 7), sec(0, 0, 7)}}, "twice"},
	}
	for _, c := range cases {
		if _, err := NewMap(c.islands, c.sectors, nil); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
}

func TestBinaryRoundTrip(t *testing.T) {
	m := asciiMap(t, 30, 30, 7,
		"..#...",
		"| ~===",
	)
	s := m.SectorAt(pt(30, 30))
	s.Stacks = []TileStack{{Index: 5, Items: []uint16{4, 5}}, {Index: 900, Items: []uint16{6}}}
	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	back, err := Decode(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, m) {
		t.Fatal("decoded map differs")
	}
	var again bytes.Buffer
	if err := Encode(&again, back); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf.Bytes(), again.Bytes()) {
		t.Fatal("re-encoding changed the bytes")
	}
}

func TestDecodeRejectsBadInput(t *testing.T) {
	m := asciiMap(t, 0, 0, 7, "...")
	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	good := buf.Bytes()
	corrupt := func(f func([]byte) []byte) []byte { return f(append([]byte(nil), good...)) }
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"empty", nil, "too short"},
		{"flipped byte", corrupt(func(b []byte) []byte { b[20] ^= 1; return b }), "checksum"},
		{"truncated", corrupt(func(b []byte) []byte { return b[:len(b)-100] }), "checksum"},
		{"bad magic", reseal(corrupt(func(b []byte) []byte { b[0] = 'X'; return b })), "not a world.bin"},
		{"bad version", reseal(corrupt(func(b []byte) []byte { b[8] = 99; return b })), "version 99"},
		{"short body", reseal(corrupt(func(b []byte) []byte { return append(b[:len(b)-200], 0, 0, 0, 0) })), "unexpected EOF"},
		{"trailing", reseal(corrupt(func(b []byte) []byte { return append(b[:len(b)-4], 1, 2, 0, 0, 0, 0) })), "trailing"},
	}
	for _, c := range cases {
		if _, err := Decode(c.data); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
}

// reseal recomputes the trailing checksum so the decoder looks past it.
func reseal(b []byte) []byte {
	body := b[:len(b)-4]
	return binary.LittleEndian.AppendUint32(body, crc32.ChecksumIEEE(body))
}

func TestFindPath(t *testing.T) {
	m := asciiMap(t, 0, 0, 7,
		"..........",
		"....#.....",
		"....#.....",
		"....#.....",
		"....#.....",
		"..........",
		"~~~~~~~~~.",
		"         .",
	)
	pf := NewPathfinder(m, 0)
	cases := []struct {
		name     string
		from, to Pos
		ok       bool
		steps    int
	}{
		{"same tile", pt(0, 0), pt(0, 0), true, 0},
		{"straight", pt(0, 0), pt(3, 0), true, 3},
		{"diagonal", pt(0, 0), pt(3, 3), true, 3},
		{"around the wall", pt(3, 2), pt(5, 2), true, 4},
		{"goal blocked", pt(0, 0), pt(4, 2), false, 0},
		{"goal without tile", pt(0, 0), pt(0, 7), false, 0},
		{"behind water", pt(0, 0), pt(9, 7), true, -1},
		{"other floor", pt(0, 0), Pos{X: 1, Y: 0, Z: 8}, false, 0},
		{"start may be blocked", pt(4, 2), pt(5, 2), true, 1},
	}
	for _, c := range cases {
		path, ok := pf.Find(c.from, c.to, nil)
		if ok != c.ok || (c.steps >= 0 && len(path) != c.steps) {
			t.Errorf("%s: ok=%v steps=%d (%v), want ok=%v steps=%d", c.name, ok, len(path), path, c.ok, c.steps)
			continue
		}
		if ok {
			if end := walk(t, m, c.from, path); end != c.to {
				t.Errorf("%s: path ends at %v, want %v", c.name, end, c.to)
			}
		}
	}
}

func TestFindPathPrefersCheapTerrain(t *testing.T) {
	// Straight across grass costs 6 × 2 × 150 = 1800. Best: a diagonal onto the road, 5 road
	// steps and one step back up onto grass: 3·50 + 5·2·50 + 2·150 = 950.
	m := asciiMap(t, 0, 0, 7,
		".......",
		"=======",
	)
	pf := NewPathfinder(m, 0)
	path, ok := pf.Find(pt(0, 0), pt(6, 0), nil)
	if !ok {
		t.Fatal("no path")
	}
	if got := pathCost(m, pt(0, 0), path); got != 950 {
		t.Fatalf("path %v costs %d, want 950 (via the road)", path, got)
	}
	// Default speed applies to grounds without one: floor costs 100 per straight step.
	m = asciiMap(t, 0, 0, 7, "____")
	path, _ = NewPathfinder(m, 0).Find(pt(0, 0), pt(3, 0), nil)
	if got := pathCost(m, pt(0, 0), path); got != 600 {
		t.Fatalf("floor path costs %d, want 600", got)
	}
}

func TestFindPathLimits(t *testing.T) {
	row := strings.Repeat(".", 160)
	m := asciiMap(t, 0, 0, 7, row, row)
	pf := NewPathfinder(m, 0)
	if _, ok := pf.Find(pt(0, 0), pt(MaxPathLength, 0), nil); !ok {
		t.Error("a 100-step path must be found")
	}
	if _, ok := pf.Find(pt(0, 0), pt(MaxPathLength+1, 0), nil); ok {
		t.Error("a 101-step path must be rejected")
	}
	// A detour longer than MaxPathLength steps is rejected even when the goal is close.
	maze := []string{
		"." + strings.Repeat("#", 60),
		"." + strings.Repeat("#", 59) + ".",
		strings.Repeat(".", 61),
	}
	mz := asciiMap(t, 0, 0, 7, maze...)
	if _, ok := NewPathfinder(mz, 0).Find(pt(0, 0), pt(60, 1), nil); !ok {
		t.Error("a 61-step detour must be found")
	}
	small := NewPathfinder(mz, 10)
	if _, ok := small.Find(pt(0, 0), pt(60, 1), nil); ok {
		t.Error("node limit of 10 must stop the search")
	}
	// The goal is 51 tiles away, but the only way there goes 55 tiles down and back up.
	var snake []string
	for range 56 {
		snake = append(snake, "."+strings.Repeat("#", 50)+".")
	}
	snake = append(snake, strings.Repeat(".", 52))
	ms := asciiMap(t, 0, 0, 7, snake...)
	if _, ok := NewPathfinder(ms, 0).Find(pt(0, 0), pt(51, 0), nil); ok {
		t.Error("the only path is longer than MaxPathLength and must be rejected")
	}
	if _, ok := NewPathfinder(ms, 0).Find(pt(0, 40), pt(51, 40), nil); !ok {
		t.Error("a snake path under MaxPathLength steps must be found")
	}
}

// TestFindPathOptimal compares A* with a plain Dijkstra on random maps.
func TestFindPathOptimal(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 7))
	chars := []byte("....====__#~ |")
	for trial := range 200 {
		rows := make([]string, 20)
		for y := range rows {
			b := make([]byte, 20)
			for x := range b {
				b[x] = chars[r.IntN(len(chars))]
			}
			rows[y] = string(b)
		}
		m := asciiMap(t, 40, 40, 7, rows...)
		pf := NewPathfinder(m, 0)
		for range 10 {
			from := pt(40+r.IntN(20), 40+r.IntN(20))
			to := pt(40+r.IntN(20), 40+r.IntN(20))
			path, ok := pf.Find(from, to, nil)
			want, reachable := dijkstra(m, from, to)
			if ok != reachable {
				t.Fatalf("trial %d %v→%v: found=%v, dijkstra reachable=%v\n%s", trial, from, to, ok, reachable, strings.Join(rows, "\n"))
			}
			if !ok {
				continue
			}
			if end := walk(t, m, from, path); end != to {
				t.Fatalf("trial %d: path ends at %v, want %v", trial, end, to)
			}
			if got := pathCost(m, from, path); got != want {
				t.Fatalf("trial %d %v→%v: cost %d, dijkstra %d", trial, from, to, got, want)
			}
		}
	}
}

func dijkstra(m *Map, from, to Pos) (int32, bool) {
	if !m.Walkable(to) {
		return 0, false
	}
	dist := map[Pos]int32{from: 0}
	done := map[Pos]bool{}
	for {
		var cur Pos
		best := int32(-1)
		for p, d := range dist {
			if !done[p] && (best < 0 || d < best) {
				cur, best = p, d
			}
		}
		if best < 0 {
			return 0, false
		}
		if cur == to {
			return best, true
		}
		done[cur] = true
		for d := range Direction(8) {
			n, ok := cur.Step(d)
			if !ok || !m.Walkable(n) {
				continue
			}
			g, _, _ := m.Tile(n)
			c := 2 * m.speed(g)
			if d.Diagonal() {
				c = 3 * m.speed(g)
			}
			if old, seen := dist[n]; !seen || best+c < old {
				dist[n] = best + c
			}
		}
	}
}

func TestFindPathDeterministicAndAllocFree(t *testing.T) {
	m := asciiMap(t, 0, 0, 7,
		"..........",
		"..#####...",
		"......#...",
		"..###.#...",
		"......#...",
	)
	pf := NewPathfinder(m, 0)
	first, _ := pf.Find(pt(0, 2), pt(9, 4), nil)
	buf := make([]Direction, 0, MaxPathLength)
	for range 20 {
		again, ok := pf.Find(pt(0, 2), pt(9, 4), buf)
		if !ok || !reflect.DeepEqual(again, first) {
			t.Fatalf("path changed: %v vs %v", again, first)
		}
	}
	allocs := testing.AllocsPerRun(100, func() { buf, _ = pf.Find(pt(0, 2), pt(9, 4), buf) })
	if allocs != 0 {
		t.Errorf("Find allocates %.1f times per call, want 0", allocs)
	}
}

func TestLineOfSight(t *testing.T) {
	m := asciiMap(t, 0, 0, 7,
		"..........",
		"....|.....",
		"....#.....",
		"..........",
		"~~~~~~~~~~",
		"..... ....",
	)
	cases := []struct {
		name string
		a, b Pos
		want bool
	}{
		{"same tile", pt(0, 0), pt(0, 0), true},
		{"adjacent to the wall", pt(3, 2), pt(4, 2), true},
		{"through the wall", pt(3, 2), pt(5, 2), false},
		{"through sight blocker", pt(2, 1), pt(7, 1), false},
		{"over the top", pt(0, 0), pt(9, 0), true},
		{"over water", pt(2, 3), pt(2, 5), true},
		{"over a hole", pt(4, 5), pt(6, 5), true},
		{"diagonal past the wall", pt(3, 3), pt(5, 1), false},
		{"other floor", pt(0, 0), Pos{X: 0, Y: 0, Z: 8}, false},
	}
	for _, c := range cases {
		if got := m.LineOfSight(c.a, c.b); got != c.want {
			t.Errorf("%s: LineOfSight(%v, %v) = %v, want %v", c.name, c.a, c.b, got, c.want)
		}
	}
}

func TestLineOfSightSymmetric(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 3))
	rows := make([]string, 30)
	for y := range rows {
		b := make([]byte, 30)
		for x := range b {
			b[x] = ".....#|"[r.IntN(7)]
		}
		rows[y] = string(b)
	}
	m := asciiMap(t, 0, 0, 7, rows...)
	for range 5000 {
		a, b := pt(r.IntN(30), r.IntN(30)), pt(r.IntN(30), r.IntN(30))
		if m.LineOfSight(a, b) != m.LineOfSight(b, a) {
			t.Fatalf("LineOfSight not symmetric for %v, %v", a, b)
		}
	}
}

func TestPosStep(t *testing.T) {
	if _, ok := (Pos{X: 0, Y: 5}).Step(West); ok {
		t.Error("stepping west from x=0 must fail")
	}
	if _, ok := (Pos{X: 65535, Y: 5}).Step(East); ok {
		t.Error("stepping east from x=65535 must fail")
	}
	if p, ok := (Pos{X: 5, Y: 5, Z: 3}).Step(SouthWest); !ok || p != (Pos{X: 4, Y: 6, Z: 3}) {
		t.Errorf("SouthWest step = %v", p)
	}
}
