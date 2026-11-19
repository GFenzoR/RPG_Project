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
	rows := []string{
		"...........",
		"...........",
		"...~~~~~...",
		"...~...~...",
		"...~...~...",
		"...~...~...",
		"...........",
		"...........",
	}
	for _, leash := range []int{0, 8} {
		t.Run(fmt.Sprintf("leash %d", leash), func(t *testing.T) {
			m := worldtest.Map(t, 0, 0, 7, rows...)
			m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 5, 1, 0, 60)}
			def := wolfDef()
			def.Attacks[0].Min, def.Attacks[0].Max = 0, 0
			h := newHarness(t, m, func(c *session.Config) {
				c.Monsters = content.Monsters{"wolf": def}
				c.Items = testItems()
				c.Balance.Combat.MonsterLeashTiles = leash
			})
			_, p := h.join("Prey", at(5, 4))
			h.sim.Step()
			wolf := onlyMonster(t, h)
			n := h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(8))
			t.Logf("the wolf reached its prey in %d ticks", n)
			if wolf.TargetID() != p.ID() {
				t.Errorf("wolf targets %d, want the prey", wolf.TargetID())
			}
		})
	}
}
