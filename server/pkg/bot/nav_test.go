package bot

import (
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Bots keep to their floor: a path goes around a teleport (stairs, holes alike), and its
// tile is no place to walk to.
func TestNavPathsAroundPortals(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		".....",
		".....",
		"#####",
	)
	m = worldtest.WithPortals(t, m, world.Portal{ID: "gate", Kind: world.PortalTeleport,
		From: world.Pos{X: 2, Y: 1, Z: 7}, To: world.Pos{X: 4, Y: 0, Z: 7}})
	n := newNav(m)
	from, to := Pos{X: 0, Y: 1, Z: 7}, Pos{X: 4, Y: 1, Z: 7}
	path, ok := n.Path(from, to)
	if !ok {
		t.Fatal("no path past the teleport")
	}
	p := from
	for _, d := range path {
		dx, dy := d.Delta()
		p = Pos{X: p.X + dx, Y: p.Y + dy, Z: p.Z}
		if p == (Pos{X: 2, Y: 1, Z: 7}) {
			t.Fatalf("path %v steps on the teleport", path)
		}
	}
	if n.Walkable(Pos{X: 2, Y: 1, Z: 7}) {
		t.Fatal("the teleport is a place to walk to")
	}
}

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

// A bot's paths weigh a diagonal as balance.yaml says, like the server's: around a tile of
// mud, two diagonals over grass are shorter at √2 (2.83 against 3) and longer at 2 (4).
func TestNavDiagonalCostFromBalance(t *testing.T) {
	n := newNav(worldtest.Map(t, 0, 0, 7,
		"...",
		".m.",
	))
	from, to := Pos{X: 0, Y: 1, Z: 7}, Pos{X: 2, Y: 1, Z: 7}
	if path, ok := n.Path(from, to); !ok || !slices.Equal(path, []Direction{NorthEast, SouthEast}) {
		t.Fatalf("default cost: path %v (ok %v), want the two diagonals", path, ok)
	}

	repo := filepath.Join("..", "..", "..", "data")
	if err := n.UseBalance(repo); err != nil {
		t.Fatalf("UseBalance(repo data): %v", err)
	}
	if path, _ := n.Path(from, to); !slices.Equal(path, []Direction{NorthEast, SouthEast}) {
		t.Fatalf("repo balance (√2): path %v, want the two diagonals", path)
	}

	raw, err := os.ReadFile(filepath.Join(repo, "balance.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	const line = "diagonal_cost: 1.414"
	if !strings.Contains(string(raw), line) {
		t.Fatalf("balance.yaml has no %q", line)
	}
	dir := t.TempDir()
	dear := strings.Replace(string(raw), line, "diagonal_cost: 2", 1)
	if err := os.WriteFile(filepath.Join(dir, "balance.yaml"), []byte(dear), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := n.UseBalance(dir); err != nil {
		t.Fatalf("UseBalance: %v", err)
	}
	if path, _ := n.Path(from, to); !slices.Equal(path, []Direction{East, East}) {
		t.Fatalf("diagonal_cost 2: path %v, want straight through the mud", path)
	}
	if err := n.UseBalance(t.TempDir()); err == nil {
		t.Fatal("no balance.yaml: want an error")
	}
}
