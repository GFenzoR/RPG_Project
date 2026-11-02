package world

import "testing"

func TestFindAvoiding(t *testing.T) {
	m := asciiMap(t, 0, 0, 7,
		".....",
		".....",
		".....",
	)
	pf := NewPathfinder(m, 0)
	// A creature on the straight line forces a detour of the same length (diagonals).
	calls := map[Pos]int{}
	avoid := func(p Pos) bool { calls[p]++; return p == pt(2, 1) }
	path, ok := pf.FindAvoiding(pt(0, 1), pt(4, 1), nil, avoid)
	if !ok || len(path) != 4 {
		t.Fatalf("path %v ok %v", path, ok)
	}
	p := pt(0, 1)
	for _, d := range path {
		p, _ = p.Step(d)
		if p == pt(2, 1) {
			t.Fatalf("path %v crosses the avoided tile", path)
		}
	}
	for q, n := range calls {
		if n > 1 {
			t.Errorf("avoid(%v) called %d times", q, n)
		}
	}
	// A wall of creatures makes the goal unreachable; Find (no avoid) still finds it.
	wall := func(p Pos) bool { return p.X == 2 }
	if _, ok := pf.FindAvoiding(pt(0, 1), pt(4, 1), nil, wall); ok {
		t.Fatal("found a path through a wall of creatures")
	}
	if _, ok := pf.Find(pt(0, 1), pt(4, 1), nil); !ok {
		t.Fatal("Find must not keep the avoid func")
	}
	// An occupied goal is unreachable.
	if _, ok := pf.FindAvoiding(pt(0, 1), pt(4, 1), nil, func(p Pos) bool { return p == pt(4, 1) }); ok {
		t.Fatal("reached an occupied goal")
	}
}
