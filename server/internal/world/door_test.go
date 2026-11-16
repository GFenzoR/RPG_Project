package world

import "testing"

// A door swaps its item and its blocking flags in place (docs/02 "Puertas con llave"):
// walking, pathfinding and line of sight see the change at once, zone flags stay, and a
// copy of the sector keeps its own stack.
func TestReplaceItem(t *testing.T) {
	m := asciiMap(t, 0, 0, 7,
		"..#..",
		"..#..",
		"..#..",
	)
	door := pt(2, 1)
	s := m.SectorAt(door)
	idx := uint16(1*SectorSize + 2)
	s.Stacks = []TileStack{{Index: idx - 1, Items: []uint16{7}}, {Index: idx, Items: []uint16{9, 20}}}
	s.Flags[idx] |= FlagProtection
	copied := *s
	pf := NewPathfinder(m, 0)
	if _, ok := pf.Find(pt(0, 1), pt(4, 1), nil); ok || m.LineOfSight(pt(0, 1), pt(4, 1)) {
		t.Fatal("the closed door lets through")
	}

	if !m.ReplaceItem(door, 1, 21, 0) {
		t.Fatal("ReplaceItem refused the door")
	}
	if got := m.Stack(door); len(got) != 2 || got[0] != 9 || got[1] != 21 {
		t.Fatalf("stack after opening: %v", got)
	}
	if !m.Walkable(door) || m.Flags(door)&FlagProtection == 0 {
		t.Fatalf("flags after opening: %b", m.Flags(door))
	}
	if path, ok := pf.Find(pt(0, 1), pt(4, 1), nil); !ok || len(path) != 4 || !m.LineOfSight(pt(0, 1), pt(4, 1)) {
		t.Fatalf("through the open door: path %v %v", path, ok)
	}
	if got := copied.Stack(2, 1); got[1] != 20 {
		t.Fatalf("the copied sector changed: %v", got)
	}

	if !m.ReplaceItem(door, 1, 20, FlagBlocksMovement|FlagBlocksSight|FlagNoLogout) {
		t.Fatal("ReplaceItem refused to close")
	}
	if m.Walkable(door) || m.Flags(door)&FlagNoLogout != 0 || m.Flags(door)&FlagProtection == 0 {
		t.Fatalf("flags after closing: %b", m.Flags(door))
	}
	// No such item, or no tile.
	if m.ReplaceItem(door, 2, 21, 0) || m.ReplaceItem(pt(0, 1), 0, 21, 0) || m.ReplaceItem(pt(9, 9), 0, 21, 0) {
		t.Fatal("ReplaceItem changed a missing item")
	}
}
