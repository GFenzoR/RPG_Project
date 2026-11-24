package bot

import (
	"fmt"
	"math/rand/v2"
	"sync"
	"sync/atomic"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// navMaxNodes bounds one bot path search (the server's own quota is per tick; bots run
// outside the server and only need a generous fixed bound).
const navMaxNodes = 40000

// Nav plans walks on the compiled map (world.bin), like a client that knows the map.
// It is safe for concurrent use.
type Nav struct {
	m    *world.Map
	pool sync.Pool
	// diag is the diagonal step cost in thousandths (balance.yaml movement.diagonal_cost):
	// every search weighs a diagonal with it, as the server's paths and step timer do.
	diag atomic.Int64
}

// LoadNav loads a compiled map for path planning.
func LoadNav(path string) (*Nav, error) {
	m, err := world.Load(path)
	if err != nil {
		return nil, fmt.Errorf("nav: %w", err)
	}
	return newNav(m), nil
}

func newNav(m *world.Map) *Nav {
	n := &Nav{m: m}
	n.diag.Store(int64(world.DefaultDiagonalCost * 1000))
	n.pool.New = func() any { return world.NewPathfinder(m, navMaxNodes) }
	return n
}

// UseBalance makes the paths weigh a diagonal step as dataDir's balance.yaml says
// (movement.diagonal_cost), like the server that loads the same file. Without it a Nav
// uses world.DefaultDiagonalCost.
func (n *Nav) UseBalance(dataDir string) error {
	b, err := content.LoadBalance(dataDir)
	if err != nil {
		return fmt.Errorf("nav: %w", err)
	}
	n.diag.Store(int64(b.Movement.DiagonalCost*1000 + 0.5))
	return nil
}

func wpos(p Pos) world.Pos { return world.Pos{X: uint16(p.X), Y: uint16(p.Y), Z: uint8(p.Z)} }

// Walkable reports whether p can be stood on (creatures not considered). The tile of
// stairs, a hole or a teleport is not: stepping onto it moves the player elsewhere.
func (n *Nav) Walkable(p Pos) bool {
	if p.X < 0 || p.Y < 0 || p.X > 0xffff || p.Y > 0xffff || p.Z < 0 || p.Z > 15 {
		return false
	}
	return n.m.Walkable(wpos(p)) && !n.m.MovesOnStep(wpos(p))
}

// Path returns the steps from `from` to `to` (at most 100, the server's WalkPath limit),
// or ok false if there is none. It goes around stairs, holes and teleports, like the
// client's paths: a bot stays on its floor.
func (n *Nav) Path(from, to Pos) ([]Direction, bool) {
	if !n.Walkable(to) {
		return nil, false
	}
	pf := n.pool.Get().(*world.Pathfinder)
	defer n.pool.Put(pf)
	pf.SetDiagonalCost(float64(n.diag.Load()) / 1000)
	path, ok := pf.FindAvoiding(wpos(from), wpos(to), nil, n.m.MovesOnStep)
	if !ok {
		return nil, false
	}
	out := make([]Direction, len(path))
	for i, d := range path {
		out[i] = Direction(d)
	}
	return out, true
}

// RandomNear returns a random walkable tile within radius of center that a path from
// `from` reaches, trying up to tries times.
func (n *Nav) RandomNear(r *rand.Rand, from, center Pos, radius, tries int) (Pos, []Direction, bool) {
	for range tries {
		p := Pos{X: center.X + r.IntN(2*radius+1) - radius, Y: center.Y + r.IntN(2*radius+1) - radius, Z: center.Z}
		if p == from {
			continue
		}
		if path, ok := n.Path(from, p); ok && len(path) > 0 {
			return p, path, true
		}
	}
	return Pos{}, nil, false
}
