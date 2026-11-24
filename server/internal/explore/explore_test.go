package explore

import (
	"testing"
)

func TestRevealSetsExactlyTheRectangle(t *testing.T) {
	m := New()
	// Crosses four sectors: x 20..50, y 25..40 on floor 7.
	if n := m.Reveal(20, 25, 50, 40, 7); n != 4 {
		t.Fatalf("sectors changed = %d, want 4", n)
	}
	for y := 0; y < 80; y++ {
		for x := 0; x < 80; x++ {
			want := x >= 20 && x <= 50 && y >= 25 && y <= 40
			if got := m.Has(x, y, 7); got != want {
				t.Fatalf("Has(%d,%d) = %v, want %v", x, y, got, want)
			}
		}
	}
	if m.Has(30, 30, 6) {
		t.Fatal("another floor is explored")
	}
	if n := m.Reveal(21, 26, 49, 39, 7); n != 0 {
		t.Fatalf("revealing explored tiles changed %d sectors", n)
	}
}

func TestRevealClipsAtTheMapEdge(t *testing.T) {
	m := New()
	m.Reveal(-10, -10, 3, 3, 0)
	if !m.Has(0, 0, 0) || !m.Has(3, 3, 0) || m.Has(4, 0, 0) {
		t.Fatal("clipped reveal is wrong")
	}
	m.Reveal(65530, 65530, 70000, 70000, 0)
	if !m.Has(65535, 65535, 0) {
		t.Fatal("the last tile of the map is not explored")
	}
	if m.Reveal(0, 0, 5, 5, MaxFloor+1) != 0 {
		t.Fatal("a floor under the map was explored")
	}
}

func TestPendingAndTouched(t *testing.T) {
	saved := New()
	saved.Reveal(0, 0, 31, 31, 7)
	m := Load(saved.All())
	if len(m.Touched()) != 0 || len(m.TakePending()) != 0 {
		t.Fatal("loaded sectors are pending or touched")
	}
	m.Reveal(0, 0, 31, 31, 7) // nothing new
	if len(m.TakePending()) != 0 {
		t.Fatal("an explored sector became pending")
	}
	m.Reveal(30, 30, 33, 33, 7)
	p := m.TakePending()
	if len(p) != 3 { // (0,1), (1,0), (1,1): (0,0) had it all
		t.Fatalf("pending = %v", p)
	}
	if len(m.TakePending()) != 0 {
		t.Fatal("pending not cleared")
	}
	if got := m.TouchedKeys(); len(got) != 3 {
		t.Fatalf("touched = %v", got)
	}
	// Touched stays (a dropped snapshot costs nothing).
	if len(m.Touched()) != 3 {
		t.Fatal("touched cleared by a read")
	}
}

func TestMergeOrsAndTouches(t *testing.T) {
	a := New()
	a.Reveal(0, 0, 3, 3, 7)
	b := New()
	b.Reveal(2, 2, 5, 5, 7)
	m := Load(a.All())
	m.Merge(b.All())
	for _, p := range [][2]int{{0, 0}, {3, 3}, {5, 5}} {
		if !m.Has(p[0], p[1], 7) {
			t.Fatalf("%v lost in the merge", p)
		}
	}
	if len(m.TouchedKeys()) != 1 {
		t.Fatal("merged sector not touched")
	}
	m.Merge(b.All()) // nothing new: stays as it was
	if len(m.TouchedKeys()) != 1 {
		t.Fatal("touched changed")
	}
}

func TestKeysAndWire(t *testing.T) {
	k := KeyOf(3100, 6300, 7)
	if k.SX() != 96 || k.SY() != 196 || k.Z() != 7 {
		t.Fatalf("key parts %d %d %d", k.SX(), k.SY(), k.Z())
	}
	back, ok := FromWire(7, k.Wire())
	if !ok || back != k {
		t.Fatalf("wire round trip: %v %v", back, ok)
	}
	if _, ok := FromWire(7, 5000<<16); ok {
		t.Fatal("a sector past the map was accepted")
	}
	if _, ok := FromWire(16, 0); ok {
		t.Fatal("a floor past the map was accepted")
	}
}

func TestMaxSectorsBoundsMemory(t *testing.T) {
	m := New()
	for i := 0; i < MaxSectors+10; i++ {
		m.Reveal((i%2000)*32, (i/2000)*32, (i%2000)*32, (i/2000)*32, 7)
	}
	if m.Len() != MaxSectors {
		t.Fatalf("len = %d, want %d", m.Len(), MaxSectors)
	}
	// Explored sectors still grow.
	if m.Reveal(1, 0, 1, 0, 7) != 1 {
		t.Fatal("a kept sector stopped growing")
	}
}

func TestSectorBitOrder(t *testing.T) {
	m := New()
	m.Reveal(9, 2, 9, 2, 0)
	s := m.Sector(KeyOf(9, 2, 0))
	// Tile (9,2): index 2*32+9 = 73: byte 9, bit 1.
	if s[9] != 1<<1 {
		t.Fatalf("byte 9 = %08b", s[9])
	}
}

func TestNilMapCopiesNothing(t *testing.T) {
	var m *Map
	if m.Touched() != nil || m.All() != nil {
		t.Fatal("a nil map copied sectors")
	}
}
