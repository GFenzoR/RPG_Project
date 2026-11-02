package world

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// world.bin, format version 3. Little endian throughout:
//
//	magic        "RPGWORLD"
//	version      u16
//	speedCount   u32, then speedCount × u16   terrain cost by numeric item ID (0 = default)
//	islandCount  u16, then per island:
//	  id         u8 length + bytes
//	  rect       4 × u32 (x, y, w, h)
//	  floors     u8 count + bytes
//	  temple     u16 x, u16 y, u8 z
//	  spawns     u16 count, then per spawn:
//	    id u8 length + bytes, center u16 x, u16 y, u8 z, radius u8, respawn u32 seconds,
//	    monsters u8 count, then per monster: id u8 length + bytes, count u16
//	  npcs       u16 count, then per NPC: id u8 length + bytes, u16 x, u16 y, u8 z
//	  sectors    u32 count, then per sector (ordered by z, cy, cx):
//	    z u8, cx u16, cy u16
//	    ground   1024 × u16
//	    flags    1024 × u8
//	    stacks   u16 count, then per stack: u16 index, u8 n, n × u16
//	crc32        u32 (IEEE) of every byte before it
//
// Encoding the same Map always produces the same bytes.

// BinaryVersion is the world.bin format version this package reads and writes.
const BinaryVersion = 3

var binaryMagic = [8]byte{'R', 'P', 'G', 'W', 'O', 'R', 'L', 'D'}

// maxStackItems is the largest stack world.bin can hold (u8 count).
const maxStackItems = 255

type binWriter struct {
	w   *bufio.Writer
	buf [8]byte
	err error
}

func (b *binWriter) bytes(p []byte) {
	if b.err == nil {
		_, b.err = b.w.Write(p)
	}
}
func (b *binWriter) u8(v uint8) { b.bytes([]byte{v}) }
func (b *binWriter) u16(v uint16) {
	binary.LittleEndian.PutUint16(b.buf[:2], v)
	b.bytes(b.buf[:2])
}
func (b *binWriter) u32(v uint32) {
	binary.LittleEndian.PutUint32(b.buf[:4], v)
	b.bytes(b.buf[:4])
}

// checkEncodable reports what world.bin cannot represent, before anything is written.
func checkEncodable(m *Map) error {
	if len(m.islands) > 0xFFFF {
		return fmt.Errorf("%d islands do not fit", len(m.islands))
	}
	for _, is := range m.islands {
		if len(is.ID) > 0xFF || len(is.Floors) > MaxFloor+1 {
			return fmt.Errorf("island %q: id or floor list too long", is.ID)
		}
		if len(is.Spawns) > 0xFFFF {
			return fmt.Errorf("island %q: %d spawns do not fit", is.ID, len(is.Spawns))
		}
		for _, sp := range is.Spawns {
			if len(sp.ID) > 0xFF || len(sp.Monsters) > 0xFF {
				return fmt.Errorf("island %q: spawn %q: id or monster list too long", is.ID, sp.ID)
			}
			for _, m := range sp.Monsters {
				if len(m.Monster) > 0xFF {
					return fmt.Errorf("island %q: spawn %q: monster id too long", is.ID, sp.ID)
				}
			}
		}
		if len(is.NPCs) > 0xFFFF {
			return fmt.Errorf("island %q: %d NPCs do not fit", is.ID, len(is.NPCs))
		}
		for _, n := range is.NPCs {
			if len(n.NPC) > 0xFF {
				return fmt.Errorf("island %q: NPC id %q too long", is.ID, n.NPC)
			}
		}
		for _, s := range is.Sectors() {
			if len(s.Stacks) > SectorTiles {
				return fmt.Errorf("sector %d,%d,%d: %d stacks", s.CX, s.CY, s.Z, len(s.Stacks))
			}
			for _, st := range s.Stacks {
				if len(st.Items) > maxStackItems {
					return fmt.Errorf("sector %d,%d,%d: stack of %d items is too tall", s.CX, s.CY, s.Z, len(st.Items))
				}
			}
		}
	}
	return nil
}

// Encode writes m in world.bin format. Nothing is written if m cannot be encoded.
func Encode(w io.Writer, m *Map) error {
	if err := checkEncodable(m); err != nil {
		return fmt.Errorf("encode world: %w", err)
	}
	h := crc32.NewIEEE()
	bw := bufio.NewWriter(io.MultiWriter(w, h))
	b := &binWriter{w: bw}
	b.bytes(binaryMagic[:])
	b.u16(BinaryVersion)
	b.u32(uint32(len(m.groundSpeed)))
	for _, s := range m.groundSpeed {
		b.u16(s)
	}
	b.u16(uint16(len(m.islands)))
	for _, is := range m.islands {
		b.u8(uint8(len(is.ID)))
		b.bytes([]byte(is.ID))
		b.u32(is.Rect.X)
		b.u32(is.Rect.Y)
		b.u32(is.Rect.W)
		b.u32(is.Rect.H)
		b.u8(uint8(len(is.Floors)))
		b.bytes(is.Floors)
		b.u16(is.Temple.X)
		b.u16(is.Temple.Y)
		b.u8(is.Temple.Z)
		b.u16(uint16(len(is.Spawns)))
		for _, sp := range is.Spawns {
			b.u8(uint8(len(sp.ID)))
			b.bytes([]byte(sp.ID))
			b.u16(sp.Center.X)
			b.u16(sp.Center.Y)
			b.u8(sp.Center.Z)
			b.u8(sp.Radius)
			b.u32(sp.RespawnSeconds)
			b.u8(uint8(len(sp.Monsters)))
			for _, m := range sp.Monsters {
				b.u8(uint8(len(m.Monster)))
				b.bytes([]byte(m.Monster))
				b.u16(m.Count)
			}
		}
		b.u16(uint16(len(is.NPCs)))
		for _, n := range is.NPCs {
			b.u8(uint8(len(n.NPC)))
			b.bytes([]byte(n.NPC))
			b.u16(n.Pos.X)
			b.u16(n.Pos.Y)
			b.u8(n.Pos.Z)
		}
		sectors := is.Sectors()
		b.u32(uint32(len(sectors)))
		for _, s := range sectors {
			b.u8(s.Z)
			b.u16(s.CX)
			b.u16(s.CY)
			for _, g := range s.Ground {
				b.u16(g)
			}
			for _, f := range s.Flags {
				b.u8(uint8(f))
			}
			b.u16(uint16(len(s.Stacks)))
			for _, st := range s.Stacks {
				b.u16(st.Index)
				b.u8(uint8(len(st.Items)))
				for _, it := range st.Items {
					b.u16(it)
				}
			}
		}
	}
	if b.err != nil {
		return fmt.Errorf("encode world: %w", b.err)
	}
	if err := bw.Flush(); err != nil {
		return fmt.Errorf("encode world: %w", err)
	}
	var sum [4]byte
	binary.LittleEndian.PutUint32(sum[:], h.Sum32())
	if _, err := w.Write(sum[:]); err != nil {
		return fmt.Errorf("encode world: %w", err)
	}
	return nil
}

type binReader struct {
	data []byte
	off  int
	err  error
}

func (b *binReader) take(n int) []byte {
	if b.err != nil {
		return nil
	}
	if n < 0 || len(b.data)-b.off < n {
		b.err = io.ErrUnexpectedEOF
		return nil
	}
	p := b.data[b.off : b.off+n]
	b.off += n
	return p
}

func (b *binReader) u8() uint8 {
	if p := b.take(1); p != nil {
		return p[0]
	}
	return 0
}

func (b *binReader) u16() uint16 {
	if p := b.take(2); p != nil {
		return binary.LittleEndian.Uint16(p)
	}
	return 0
}

func (b *binReader) u32() uint32 {
	if p := b.take(4); p != nil {
		return binary.LittleEndian.Uint32(p)
	}
	return 0
}

// Decode parses world.bin bytes into a Map.
func Decode(data []byte) (*Map, error) {
	if len(data) < len(binaryMagic)+4 {
		return nil, errors.New("decode world: file too short")
	}
	body := data[:len(data)-4]
	if want, got := binary.LittleEndian.Uint32(data[len(data)-4:]), crc32.ChecksumIEEE(body); want != got {
		return nil, fmt.Errorf("decode world: checksum mismatch (file says %08x, content is %08x)", want, got)
	}
	b := &binReader{data: body}
	if string(b.take(len(binaryMagic))) != string(binaryMagic[:]) {
		return nil, errors.New("decode world: not a world.bin file")
	}
	if v := b.u16(); v != BinaryVersion {
		return nil, fmt.Errorf("decode world: format version %d, this server reads %d", v, BinaryVersion)
	}
	n := int(b.u32())
	if n > len(body) {
		return nil, fmt.Errorf("decode world: %w", io.ErrUnexpectedEOF)
	}
	speeds := make([]uint16, n)
	for i := range speeds {
		speeds[i] = b.u16()
	}
	islandCount := int(b.u16())
	islands := make([]*Island, 0, islandCount)
	sectors := make(map[string][]*Sector, islandCount)
	for range islandCount {
		is := &Island{ID: string(b.take(int(b.u8())))}
		is.Rect = Rect{X: b.u32(), Y: b.u32(), W: b.u32(), H: b.u32()}
		is.Floors = append([]uint8(nil), b.take(int(b.u8()))...)
		is.Temple = Pos{X: b.u16(), Y: b.u16(), Z: b.u8()}
		spawns := int(b.u16())
		for range spawns {
			if b.err != nil {
				break
			}
			sp := Spawn{ID: string(b.take(int(b.u8())))}
			sp.Center = Pos{X: b.u16(), Y: b.u16(), Z: b.u8()}
			sp.Radius = b.u8()
			sp.RespawnSeconds = b.u32()
			n := int(b.u8())
			for range n {
				sp.Monsters = append(sp.Monsters, SpawnMonster{Monster: string(b.take(int(b.u8()))), Count: b.u16()})
			}
			is.Spawns = append(is.Spawns, sp)
		}
		npcs := int(b.u16())
		for range npcs {
			if b.err != nil {
				break
			}
			n := NPCPlacement{NPC: string(b.take(int(b.u8())))}
			n.Pos = Pos{X: b.u16(), Y: b.u16(), Z: b.u8()}
			is.NPCs = append(is.NPCs, n)
		}
		count := int(b.u32())
		const minSectorBytes = 5 + SectorTiles*3 + 2
		if b.err == nil && count > (len(body)-b.off)/minSectorBytes {
			return nil, fmt.Errorf("decode world: island %q: %w", is.ID, io.ErrUnexpectedEOF)
		}
		list := make([]*Sector, 0, count)
		for range count {
			s := &Sector{Z: b.u8(), CX: b.u16(), CY: b.u16()}
			for i := range s.Ground {
				s.Ground[i] = b.u16()
			}
			flags := b.take(SectorTiles)
			for i := range flags {
				s.Flags[i] = Flags(flags[i])
			}
			stacks := int(b.u16())
			if stacks > 0 {
				s.Stacks = make([]TileStack, 0, stacks)
			}
			prev := -1
			for range stacks {
				st := TileStack{Index: b.u16()}
				if int(st.Index) <= prev || st.Index >= SectorTiles {
					if b.err == nil {
						b.err = fmt.Errorf("sector %d,%d,%d: stack index %d out of order", s.CX, s.CY, s.Z, st.Index)
					}
				}
				prev = int(st.Index)
				items := int(b.u8())
				st.Items = make([]uint16, items)
				for i := range st.Items {
					st.Items[i] = b.u16()
				}
				s.Stacks = append(s.Stacks, st)
			}
			if b.err != nil {
				break
			}
			list = append(list, s)
		}
		if b.err != nil {
			return nil, fmt.Errorf("decode world: %w", b.err)
		}
		islands = append(islands, is)
		sectors[is.ID] = list
	}
	if b.err != nil {
		return nil, fmt.Errorf("decode world: %w", b.err)
	}
	if b.off != len(body) {
		return nil, fmt.Errorf("decode world: %d trailing bytes", len(body)-b.off)
	}
	m, err := NewMap(islands, sectors, speeds)
	if err != nil {
		return nil, fmt.Errorf("decode world: %w", err)
	}
	return m, nil
}

// Load reads and decodes a world.bin file.
func Load(path string) (*Map, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("load world: %w", err)
	}
	m, err := Decode(data)
	if err != nil {
		return nil, fmt.Errorf("load world %s: %w", path, err)
	}
	return m, nil
}
