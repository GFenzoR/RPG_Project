package bot

import (
	"math/rand/v2"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

func TestNavPathsAroundWalls(t *testing.T) {
	n := newNav(worldtest.Map(t, 0, 0, 7,
		".....",
		".###.",
		".#T#.",
		".#.#.",
		".....",
	))
	from, to := Pos{X: 2, Y: 2, Z: 7}, Pos{X: 2, Y: 0, Z: 7}
	path, ok := n.Path(from, to)
	if !ok {
		t.Fatal("no path out of the walled temple")
	}
	p := from
	for _, d := range path {
		dx, dy := d.Delta()
		p = Pos{X: p.X + dx, Y: p.Y + dy, Z: p.Z}
		if !n.Walkable(p) {
			t.Fatalf("path %v steps on %v", path, p)
		}
	}
	if p != to {
		t.Fatalf("path %v ends at %v, want %v", path, p, to)
	}
	if _, ok := n.Path(from, Pos{X: 1, Y: 1, Z: 7}); ok {
		t.Fatal("path into a wall")
	}
	if n.Walkable(Pos{X: -1, Y: 0, Z: 7}) {
		t.Fatal("negative position walkable")
	}

	r := rand.New(rand.NewPCG(1, 2))
	for range 20 {
		got, path, ok := n.RandomNear(r, from, Pos{X: 2, Y: 4, Z: 7}, 2, 30)
		if !ok || got == from || len(path) == 0 || !n.Walkable(got) || chebyshev(got, Pos{X: 2, Y: 4, Z: 7}) > 2 {
			t.Fatalf("RandomNear = %v %v %v", got, path, ok)
		}
	}
}

func chebyshev(a, b Pos) int {
	return max(abs(a.X-b.X), abs(a.Y-b.Y))
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
