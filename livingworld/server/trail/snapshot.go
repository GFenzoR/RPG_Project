package trail

import (
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
)

// Snapshot is an immutable copy of a Map's wear, taken on the loop (a copy of 2 KiB per
// chunk) and encoded off it, by the persistence goroutine.
type Snapshot struct {
	keys  []uint64
	cells [][chunkTiles]uint16
}

// Snapshot copies the wear of every chunk.
func (m *Map) Snapshot() Snapshot {
	s := Snapshot{keys: append([]uint64(nil), m.keys...), cells: make([][chunkTiles]uint16, len(m.keys))}
	for i, k := range m.keys {
		s.cells[i] = m.chunks[k].cells
	}
	return s
}

// Tiles is how many tiles of the snapshot have some wear.
func (s Snapshot) Tiles() int {
	n := 0
	for i := range s.cells {
		for _, v := range s.cells[i] {
			if v > 0 {
				n++
			}
		}
	}
	return n
}

// The encoding (little endian): the magic "TW", the version 1, then per chunk z (1 byte),
// cx and cy (2 bytes each) and its worn cells (2 bytes), then each worn cell's index in the
// chunk and its wear (2 bytes each). A chunk is 7 + 4 x worn bytes.
var magic = [3]byte{'T', 'W', 1}

// Encode returns the bytes Restore reads (data of the trail_wear row).
func (s Snapshot) Encode() []byte {
	out := append([]byte(nil), magic[:]...)
	for i, k := range s.keys {
		cx, cy, z := split(k)
		n := 0
		for _, v := range s.cells[i] {
			if v > 0 {
				n++
			}
		}
		if n == 0 {
			continue
		}
		out = append(out, z)
		out = binary.LittleEndian.AppendUint16(out, uint16(cx))
		out = binary.LittleEndian.AppendUint16(out, uint16(cy))
		out = binary.LittleEndian.AppendUint16(out, uint16(n))
		for j, v := range s.cells[i] {
			if v > 0 {
				out = binary.LittleEndian.AppendUint16(out, uint16(j))
				out = binary.LittleEndian.AppendUint16(out, v)
			}
		}
	}
	return out
}

// ErrCorrupt reports bytes Restore cannot read.
var ErrCorrupt = errors.New("trail: corrupt wear snapshot")

// Restore replaces the Map's wear with data (Encode's bytes; empty: no wear) and applies
// the decay of elapsedMs (how long the server was down), so grass recovers during a
// downtime too. Wear above Max is capped. No change is reported: the clients get the
// levels with their map. On error the Map is left empty.
func (m *Map) Restore(data []byte, elapsedMs int64) error {
	clear(m.chunks)
	m.keys = m.keys[:0]
	m.changes = m.changes[:0]
	if len(data) == 0 {
		return nil
	}
	if len(data) < len(magic) || [3]byte(data[:3]) != magic {
		return fmt.Errorf("%w: bad header", ErrCorrupt)
	}
	r := data[3:]
	for len(r) > 0 {
		if len(r) < 7 {
			m.reset()
			return fmt.Errorf("%w: truncated chunk", ErrCorrupt)
		}
		z, cx, cy := r[0], binary.LittleEndian.Uint16(r[1:]), binary.LittleEndian.Uint16(r[3:])
		n := int(binary.LittleEndian.Uint16(r[5:]))
		r = r[7:]
		if n > chunkTiles || len(r) < 4*n || int(cx)*ChunkSize > 0xFFFF || int(cy)*ChunkSize > 0xFFFF {
			m.reset()
			return fmt.Errorf("%w: chunk (%d, %d, %d)", ErrCorrupt, cx, cy, z)
		}
		k := key(int(cx), int(cy), z)
		c := m.chunks[k]
		if c == nil {
			c = new(chunk)
			m.chunks[k] = c
		}
		for range n {
			i, v := int(binary.LittleEndian.Uint16(r)), int(binary.LittleEndian.Uint16(r[2:]))
			r = r[4:]
			if i >= chunkTiles {
				m.reset()
				return fmt.Errorf("%w: cell %d", ErrCorrupt, i)
			}
			v = min(v, m.cfg.Max)
			if c.cells[i] == 0 && v > 0 {
				c.worn++
			}
			c.cells[i] = uint16(v)
		}
	}
	for k, c := range m.chunks {
		if c.worn == 0 {
			delete(m.chunks, k)
			continue
		}
		m.keys = append(m.keys, k)
	}
	slices.Sort(m.keys)
	if passes := max(elapsedMs, 0) / int64(m.cfg.DecayEveryMs); passes > 0 {
		m.decay(int(min(passes*int64(m.cfg.Decay), int64(m.cfg.Max))), false)
	}
	return nil
}

func (m *Map) reset() {
	clear(m.chunks)
	m.keys = m.keys[:0]
}
