package trail

import (
	"slices"
)

// ChunkSize is the side of a wear chunk in tiles (the map's chunks and sectors: 32).
const ChunkSize = 32

const chunkTiles = ChunkSize * ChunkSize

// Pos is a tile position (the server's world.Pos, copied by the glue).
type Pos struct {
	X, Y uint16
	Z    uint8
}

// Walker is who took a step.
type Walker uint8

// Walkers.
const (
	WalkerPlayer Walker = iota + 1
	WalkerMonster
)

// Change is a tile whose level changed (Level 0: it recovered).
type Change struct {
	Pos   Pos
	Level uint8
}

// chunk is the wear of a ChunkSize x ChunkSize square of one floor: 2 KiB, only for a
// square with a worn tile (docs/07).
type chunk struct {
	cells [chunkTiles]uint16
	// worn counts the cells above 0: at 0 the chunk is dropped.
	worn int
}

// Map is the trail wear of the whole world, sparse by chunk. The game loop owns it.
type Map struct {
	cfg        Config
	decayTicks int64
	saveTicks  int64
	chunks     map[uint64]*chunk
	// keys are the keys of chunks, sorted: decay and Snapshot walk them in a fixed order
	// (deterministic changes and bytes).
	keys      []uint64
	changes   []Change
	nextDecay int64
	nextSave  int64
}

// New returns an empty Map; tickMs is the loop's tick (50 ms).
func New(cfg Config, tickMs int) *Map {
	tickMs = max(tickMs, 1)
	return &Map{
		cfg:        cfg,
		decayTicks: int64(max((cfg.DecayEveryMs+tickMs-1)/tickMs, 1)),
		saveTicks:  int64(max((cfg.SaveEveryMs+tickMs-1)/tickMs, 1)),
		chunks:     map[uint64]*chunk{},
		nextDecay:  -1,
		nextSave:   -1,
	}
}

// Config returns the Map's config.
func (m *Map) Config() Config { return m.cfg }

func key(cx, cy int, z uint8) uint64 {
	return uint64(z)<<32 | uint64(cx)<<16 | uint64(cy)
}

func split(k uint64) (cx, cy int, z uint8) {
	return int(k >> 16 & 0xFFFF), int(k & 0xFFFF), uint8(k >> 32)
}

func cellOf(p Pos) (uint64, int) {
	return key(int(p.X)/ChunkSize, int(p.Y)/ChunkSize, p.Z), int(p.Y)%ChunkSize*ChunkSize + int(p.X)%ChunkSize
}

// Wear returns the wear points of p.
func (m *Map) Wear(p Pos) int {
	k, i := cellOf(p)
	if c := m.chunks[k]; c != nil {
		return int(c.cells[i])
	}
	return 0
}

// Level returns the level of p (0..3).
func (m *Map) Level(p Pos) uint8 { return m.cfg.Level(m.Wear(p)) }

// Tiles is how many tiles have some wear.
func (m *Map) Tiles() int {
	n := 0
	for _, c := range m.chunks {
		n += c.worn
	}
	return n
}

// Chunks is how many chunks hold wear (2 KiB each).
func (m *Map) Chunks() int { return len(m.chunks) }

// OnStep counts a step of walker onto p, whose ground surface is surface. A surface that
// does not wear, or a walker whose steps weigh nothing, changes nothing.
func (m *Map) OnStep(p Pos, surface string, walker Walker) {
	gain := m.cfg.PlayerStep
	if walker != WalkerPlayer {
		gain = 0
		if walker == WalkerMonster {
			gain = m.cfg.MonsterStep
		}
	}
	if gain <= 0 || !m.cfg.Wears(surface) {
		return
	}
	k, i := cellOf(p)
	c := m.chunks[k]
	if c == nil {
		c = new(chunk)
		m.chunks[k] = c
		at, _ := slices.BinarySearch(m.keys, k)
		m.keys = slices.Insert(m.keys, at, k)
	}
	old := int(c.cells[i])
	v := min(old+gain, m.cfg.Max)
	if v == old {
		return
	}
	if old == 0 {
		c.worn++
	}
	c.cells[i] = uint16(v)
	if l := m.cfg.Level(v); l != m.cfg.Level(old) {
		m.changes = append(m.changes, Change{Pos: p, Level: l})
	}
}

// OnTick runs the decay when it is due and reports whether a Snapshot is due for
// persistence. The first call only schedules both.
func (m *Map) OnTick(tick int64) (save bool) {
	if m.nextDecay < 0 {
		m.nextDecay, m.nextSave = tick+m.decayTicks, tick+m.saveTicks
		return false
	}
	if tick >= m.nextDecay {
		m.nextDecay = tick + m.decayTicks
		m.decay(m.cfg.Decay, true)
	}
	if tick >= m.nextSave {
		m.nextSave = tick + m.saveTicks
		return true
	}
	return false
}

// decay takes points off every worn tile, dropping the chunks left without wear; with
// report, the level changes go to the changes.
func (m *Map) decay(points int, report bool) {
	kept := m.keys[:0]
	for _, k := range m.keys {
		c := m.chunks[k]
		for i, v := range c.cells {
			if v == 0 {
				continue
			}
			nv := max(int(v)-points, 0)
			c.cells[i] = uint16(nv)
			if nv == 0 {
				c.worn--
			}
			if l := m.cfg.Level(nv); report && l != m.cfg.Level(int(v)) {
				cx, cy, z := split(k)
				m.changes = append(m.changes, Change{Level: l, Pos: Pos{
					X: uint16(cx*ChunkSize + i%ChunkSize), Y: uint16(cy*ChunkSize + i/ChunkSize), Z: z}})
			}
		}
		if c.worn > 0 {
			kept = append(kept, k)
		} else {
			delete(m.chunks, k)
		}
	}
	m.keys = kept
}

// TakeChanges appends the level changes since the last call to dst and forgets them. A
// tile changed twice appears twice, the last one current.
func (m *Map) TakeChanges(dst []Change) []Change {
	dst = append(dst, m.changes...)
	m.changes = m.changes[:0]
	return dst
}

// EachInRect calls fn for every tile of [x0, x1] x [y0, y1] on floor z with a level
// above 0, row by row.
func (m *Map) EachInRect(x0, y0, x1, y1 int, z uint8, fn func(p Pos, level uint8)) {
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, 0xFFFF), min(y1, 0xFFFF)
	if x0 > x1 || y0 > y1 || len(m.chunks) == 0 {
		return
	}
	for y := y0; y <= y1; y++ {
		for cx := x0 / ChunkSize; cx <= x1/ChunkSize; cx++ {
			c := m.chunks[key(cx, y/ChunkSize, z)]
			if c == nil {
				continue
			}
			from, to := max(x0, cx*ChunkSize), min(x1, cx*ChunkSize+ChunkSize-1)
			row := y % ChunkSize * ChunkSize
			for x := from; x <= to; x++ {
				if l := m.cfg.Level(int(c.cells[row+x%ChunkSize])); l > 0 {
					fn(Pos{X: uint16(x), Y: uint16(y), Z: z}, l)
				}
			}
		}
	}
}
