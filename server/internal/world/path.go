package world

// Direction is one of the 8 steps a creature can take.
type Direction uint8

// Directions, clockwise from north. Y grows southwards.
const (
	North Direction = iota
	NorthEast
	East
	SouthEast
	South
	SouthWest
	West
	NorthWest
)

var dirDX = [8]int{0, 1, 1, 1, 0, -1, -1, -1}
var dirDY = [8]int{-1, -1, 0, 1, 1, 1, 0, -1}

// Delta returns the x and y offsets of one step in direction d.
func (d Direction) Delta() (dx, dy int) { return dirDX[d&7], dirDY[d&7] }

// Diagonal reports whether d is a diagonal step.
func (d Direction) Diagonal() bool { return d&1 == 1 }

// Step returns p moved one tile in direction d. ok is false when it would leave the world.
func (p Pos) Step(d Direction) (Pos, bool) {
	dx, dy := d.Delta()
	x, y := int(p.X)+dx, int(p.Y)+dy
	if x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
		return p, false
	}
	return Pos{X: uint16(x), Y: uint16(y), Z: p.Z}, true
}

// MaxPathLength is the longest path, in steps, the server computes for click-to-walk
// (docs/02-game-design.md).
const MaxPathLength = 100

// DefaultMaxNodes bounds how many tiles one search pass may expand. Find runs at most two
// passes (by cost, then by steps if the first was cut short), so an unreachable goal costs
// at most 2 × DefaultMaxNodes expansions (about 3 ms in BenchmarkFindPathUnreachable).
const DefaultMaxNodes = 6000

// pathWindow is the side of the square of tiles a search can visit, centred on the start.
const pathWindow = 2*MaxPathLength + 1

// Pathfinder runs A* searches over a Map. It reuses its buffers between searches, so a
// search does not allocate once the pathfinder is warm. It is not safe for concurrent use:
// the game loop owns one.
//
// Movement rules (docs/02-game-design.md): 8 directions, entering a tile costs its ground
// speed (terrain percent, 100 = normal) and a diagonal step costs 1.5 times as much.
// Diagonals may pass between two blocked tiles, as on foot.
type Pathfinder struct {
	m        *Map
	maxNodes int

	gen    uint32
	seen   []uint32 // generation at which the slot was first reached
	closed []uint32 // generation at which the slot was expanded
	cost   []int32  // g, in half-percent units (orthogonal = 2*speed, diagonal = 3*speed)
	f, h   []int32  // g + heuristic, and heuristic
	depth  []uint8  // steps from the start
	from   []uint8  // direction taken to reach the slot
	heapAt []int32  // index in open while the slot is queued
	open   []int32  // min-heap of slots

	expanded int  // nodes expanded by the last Find
	bySteps  bool // the current pass minimises steps instead of cost
	// incomplete: the current pass stopped at the node limit or dropped a tile at
	// MaxPathLength steps, so a failure does not prove the goal unreachable.
	incomplete bool
}

// Expanded returns how many tiles the last search expanded (for metrics and tuning).
func (pf *Pathfinder) Expanded() int { return pf.expanded }

// NewPathfinder returns a pathfinder that expands at most maxNodes tiles per search
// (DefaultMaxNodes if maxNodes <= 0).
func NewPathfinder(m *Map, maxNodes int) *Pathfinder {
	if maxNodes <= 0 {
		maxNodes = DefaultMaxNodes
	}
	n := pathWindow * pathWindow
	return &Pathfinder{
		m:        m,
		maxNodes: maxNodes,
		seen:     make([]uint32, n),
		closed:   make([]uint32, n),
		cost:     make([]int32, n),
		f:        make([]int32, n),
		h:        make([]int32, n),
		heapAt:   make([]int32, n),
		open:     make([]int32, 0, n),
		depth:    make([]uint8, n),
		from:     make([]uint8, n),
	}
}

// pathHeap is a binary min-heap of window slots ordered by (f, h, slot), with
// decrease-key: every slot is in the heap at most once, at index pf.heapAt[slot].
// Ordering by slot last keeps ties deterministic.
func (pf *Pathfinder) less(a, b int32) bool {
	if pf.f[a] != pf.f[b] {
		return pf.f[a] < pf.f[b]
	}
	if pf.h[a] != pf.h[b] {
		return pf.h[a] < pf.h[b]
	}
	return a < b
}

func (pf *Pathfinder) heapSet(i int, slot int32) {
	pf.open[i] = slot
	pf.heapAt[slot] = int32(i)
}

func (pf *Pathfinder) siftUp(i int) {
	slot := pf.open[i]
	for i > 0 {
		p := (i - 1) / 2
		if !pf.less(slot, pf.open[p]) {
			break
		}
		pf.heapSet(i, pf.open[p])
		i = p
	}
	pf.heapSet(i, slot)
}

func (pf *Pathfinder) pop() int32 {
	top := pf.open[0]
	last := len(pf.open) - 1
	slot := pf.open[last]
	pf.open = pf.open[:last]
	if last > 0 {
		i := 0
		for {
			l := 2*i + 1
			if l >= last {
				break
			}
			c := l
			if r := l + 1; r < last && pf.less(pf.open[r], pf.open[l]) {
				c = r
			}
			if !pf.less(pf.open[c], slot) {
				break
			}
			pf.heapSet(i, pf.open[c])
			i = c
		}
		pf.heapSet(i, slot)
	}
	return top
}

// heuristic never overestimates the remaining cost, so A* returns a cheapest path.
// By cost: the octile distance at the cheapest terrain speed, in Pathfinder.cost units.
// By steps: the Chebyshev distance.
func (pf *Pathfinder) heuristic(dx, dy int) int32 {
	if dx < 0 {
		dx = -dx
	}
	if dy < 0 {
		dy = -dy
	}
	lo, hi := dx, dy
	if lo > hi {
		lo, hi = hi, lo
	}
	if pf.bySteps {
		return int32(hi)
	}
	return pf.m.minSpeed * int32(2*(hi-lo)+3*lo)
}

// Find returns a walking path from `from` to `to` as a list of directions, appended to
// dst[:0]: the cheapest one (terrain and diagonal cost) if it has at most MaxPathLength
// steps, otherwise the one with fewest steps. The start tile does not need to be walkable
// (a creature stands on it); the goal does. ok is false when the floors differ, the goal is
// not walkable or farther than MaxPathLength, or no path of at most MaxPathLength steps was
// found within the node limit. Creatures are not considered.
func (pf *Pathfinder) Find(from, to Pos, dst []Direction) (path []Direction, ok bool) {
	dst = dst[:0]
	pf.expanded = 0
	if from.Z != to.Z || !pf.m.Walkable(to) {
		return dst, false
	}
	gdx, gdy := int(to.X)-int(from.X), int(to.Y)-int(from.Y)
	if gdx < -MaxPathLength || gdx > MaxPathLength || gdy < -MaxPathLength || gdy > MaxPathLength {
		return dst, false
	}
	if gdx == 0 && gdy == 0 {
		return dst, true
	}
	pf.bySteps = false
	path, ok = pf.search(from, gdx, gdy, dst)
	if ok || !pf.incomplete {
		return path, ok
	}
	// The cost pass ran out of nodes, or its cheapest routes were longer than
	// MaxPathLength. A pass by steps, with its own node budget, finds a path of at most
	// MaxPathLength steps whenever one exists within that budget: cost and depth agree, and
	// the Chebyshev heuristic is exact on open ground, so it expands few tiles.
	spent := pf.expanded
	pf.bySteps = true
	path, ok = pf.search(from, gdx, gdy, dst)
	pf.expanded += spent
	return path, ok
}

// search runs one A* pass of at most maxNodes expansions and sets pf.incomplete.
func (pf *Pathfinder) search(from Pos, gdx, gdy int, dst []Direction) ([]Direction, bool) {
	pf.incomplete = false
	pf.gen++
	if pf.gen == 0 { // wrapped: clear stamps so stale generations cannot match
		clear(pf.seen)
		clear(pf.closed)
		pf.gen = 1
	}
	pf.open = pf.open[:0]
	ox, oy := int(from.X)-MaxPathLength, int(from.Y)-MaxPathLength
	z := int(from.Z)
	slotOf := func(dx, dy int) int32 { return int32((dy+MaxPathLength)*pathWindow + dx + MaxPathLength) }
	start := slotOf(0, 0)
	goal := slotOf(gdx, gdy)
	pf.seen[start] = pf.gen
	pf.cost[start] = 0
	pf.depth[start] = 0
	pf.h[start] = pf.heuristic(gdx, gdy)
	pf.f[start] = pf.h[start]
	pf.open = append(pf.open, start)
	pf.siftUp(0)

	pf.expanded = 0
	for len(pf.open) > 0 {
		cur := pf.pop()
		if cur == goal {
			return pf.build(goal, start, dst), true
		}
		pf.closed[cur] = pf.gen
		pf.expanded++
		if pf.expanded > pf.maxNodes {
			pf.incomplete = true
			return dst, false
		}
		d := pf.depth[cur]
		if d >= MaxPathLength {
			pf.incomplete = true
			continue
		}
		wx, wy := int(cur)%pathWindow, int(cur)/pathWindow
		g := pf.cost[cur]
		for dir := range Direction(8) {
			nx, ny := wx+dirDX[dir], wy+dirDY[dir]
			if nx < 0 || ny < 0 || nx >= pathWindow || ny >= pathWindow {
				continue
			}
			slot := int32(ny*pathWindow + nx)
			if pf.closed[slot] == pf.gen {
				continue
			}
			ground, flags, exists := pf.m.tile(ox+nx, oy+ny, z)
			if !exists || flags&FlagBlocksMovement != 0 {
				continue
			}
			var step int32
			switch {
			case pf.bySteps:
				step = 1
			case dir.Diagonal():
				step = 3 * pf.m.speed(ground)
			default:
				step = 2 * pf.m.speed(ground)
			}
			ng := g + step
			queued := pf.seen[slot] == pf.gen
			if queued && pf.cost[slot] <= ng {
				continue
			}
			if !queued {
				pf.seen[slot] = pf.gen
				pf.h[slot] = pf.heuristic(gdx-(nx-MaxPathLength), gdy-(ny-MaxPathLength))
				pf.heapAt[slot] = int32(len(pf.open))
				pf.open = append(pf.open, slot)
			}
			pf.cost[slot] = ng
			pf.f[slot] = ng + pf.h[slot]
			pf.depth[slot] = d + 1
			pf.from[slot] = uint8(dir)
			pf.siftUp(int(pf.heapAt[slot]))
		}
	}
	return dst, false
}

func (pf *Pathfinder) build(goal, start int32, dst []Direction) []Direction {
	n := int(pf.depth[goal])
	for range n {
		dst = append(dst, 0)
	}
	slot := goal
	for i := n - 1; slot != start; i-- {
		dir := Direction(pf.from[slot])
		dst[i] = dir
		x, y := int(slot)%pathWindow-dirDX[dir], int(slot)/pathWindow-dirDY[dir]
		slot = int32(y*pathWindow + x)
	}
	return dst
}
