package session_test

import (
	"fmt"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// A monster that meets a U-shaped wall (here water: it does not block sight) between
// itself and its target, with the opening on the far side, walks around it to the target.
// Before, the greedy step from the first tile of the A* detour led straight back to the
// wall, and the next search gave that first step again: it went back and forth forever.
func TestChaseFollowsItsWayAroundAWall(t *testing.T) {
	for _, leash := range []int{0, 8} {
		t.Run(fmt.Sprintf("leash %d", leash), func(t *testing.T) {
			h, wolf, _, p := uWallHarness(t, leash)
			n := h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(8))
			t.Logf("the wolf reached its prey in %d ticks", n)
			if wolf.TargetID() != p.ID() {
				t.Errorf("wolf targets %d, want the prey", wolf.TargetID())
			}
		})
	}
}

// uWallHarness is the U-shaped wall of TestChaseFollowsItsWayAroundAWall (water: it does
// not block sight; the opening south) with a harmless wolf spawned at 5,1, the leash
// given, and the prey inside the U at 5,4, the wolf's target.
func uWallHarness(t *testing.T, leash int) (*harness, *session.Monster, *fakeClient, *session.Player) {
	t.Helper()
	m := worldtest.Map(t, 0, 0, 7,
		"...........",
		"...........",
		"...~~~~~...",
		"...~...~...",
		"...~...~...",
		"...~...~...",
		"...........",
		"...........",
	)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 5, 1, 0, 60)}
	def := wolfDef()
	def.Attacks[0].Min, def.Attacks[0].Max = 0, 0
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": def}
		c.Items = testItems()
		c.Balance.Combat.MonsterLeashTiles = leash
	})
	cl, p := h.join("Prey", at(5, 4))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(1))
	return h, wolf, cl, p
}

// The way a chasing monster follows is dropped when it no longer leads to its target
// (review of the monster abilities): the target stepped more than one tile from where it
// stood when the way was found, a creature stands on the next step, or the monster lost
// its target.
func TestChaseDropsAStaleWay(t *testing.T) {
	// wayOn runs until the wolf follows a way with at least n tiles left, standing at
	// least y0 rows down.
	wayOn := func(h *harness, wolf *session.Monster, n, y0 int) []world.Pos {
		h.t.Helper()
		var way []world.Pos
		h.sim.RunUntil(func() bool {
			way = wolf.ChaseWayForTest()
			return len(way) >= n && int(wolf.Pos().Y) >= y0
		}, sim.MaxSeconds(6))
		return way
	}
	for _, leash := range []int{0, 8} {
		t.Run(fmt.Sprintf("the target moved on, leash %d", leash), func(t *testing.T) {
			// Halfway down the side of the wall, the prey shows up north of it, where the
			// wolf started: the rest of the way would take the wolf into the U and back
			// out round the wall (some 15 steps), straight back it is 3 or 4.
			h, wolf, _, p := uWallHarness(t, leash)
			way := wayOn(h, wolf, 2, 4)
			from := wolf.Pos()
			h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(5, 0)) }))
			n := h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(3))
			t.Logf("from %v (way on %v) the wolf turned back to its prey in %d ticks", from, way, n)
		})
		t.Run(fmt.Sprintf("a creature on the next step, leash %d", leash), func(t *testing.T) {
			h, wolf, _, p := uWallHarness(t, leash)
			way := wayOn(h, wolf, 2, 0)
			_, blocker := h.join("Blocker", &way[0])
			if blocker.Pos() != way[0] {
				t.Fatalf("the blocker joined on %v, want the next step %v", blocker.Pos(), way[0])
			}
			n := h.sim.RunUntil(func() bool {
				if wolf.Pos() == blocker.Pos() {
					t.Fatalf("the wolf stepped onto the blocker at %v", wolf.Pos())
				}
				return chebyshev(wolf.Pos(), p.Pos()) <= 1
			}, sim.MaxSeconds(8))
			t.Logf("the wolf got round the blocker to its prey in %d ticks", n)
		})
	}
	t.Run("the target is lost", func(t *testing.T) {
		h, wolf, cl, _ := uWallHarness(t, 0)
		wayOn(h, wolf, 2, 0)
		h.sim.Command(h.w.Leave(cl))
		h.sim.Step()
		if wolf.TargetID() != 0 || len(wolf.ChaseWayForTest()) != 0 {
			t.Errorf("after its prey left the wolf targets %d and keeps a way of %v, want none", wolf.TargetID(), wolf.ChaseWayForTest())
		}
	})
}
