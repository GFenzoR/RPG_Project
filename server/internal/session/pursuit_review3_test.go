package session_test

import (
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Third review of the pursuit (pursuit.go): a monster with a target thinks even where no
// player keeps its sector awake, a condition's author on another floor is out of its
// reach, a small monster regenerates at the balance's rate, and what it regenerates comes
// out of the damage shares.

// openFloors is an open 64x64 map with floors 6 and 7.
func openFloors(t *testing.T) *world.Map {
	t.Helper()
	open := make([]string, 64)
	for i := range open {
		open[i] = strings.Repeat(".", 64)
	}
	return worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 6, Rows: open}, worldtest.Layer{Z: 7, Rows: open})
}

// A player alone with a monster who changes floor leaves its sector asleep: the monster
// still gives it up at once (it thinks while it has a target), so its fight ends there and
// the time its target spends away counts for its regeneration. Before, it kept its target
// in its sleep and went on with the fight, unhealed, when the player came back.
func TestPursuitFloorChangeAlone(t *testing.T) {
	pur := content.Pursuit{Persistence: 1, MaxChaseTiles: 30, LoseSightMs: 60000, RollMs: 1000, MemoryMs: 600000}
	regen := content.MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 1}
	h := pursuitHarness(t, openFloors(t), harmlessWolf(false), pur, regen)
	_, p, wolf := engaged(t, h, "Climber", pos(22, 20))
	h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(3))
	h.do(func(ctx *game.TickContext) {
		h.w.DamageMonsterForTest(ctx, wolf, p, 60)
		h.w.Teleport(p, world.Pos{X: 22, Y: 20, Z: 6})
	})
	h.sim.RunTicks(2)
	if wolf.TargetID() != 0 {
		t.Fatalf("the wolf targets %d with its only target a floor up, want nobody", wolf.TargetID())
	}
	if n := h.w.StraysForTest(); n != 0 {
		t.Errorf("%d monsters kept awake once the wolf is idle at home, want 0", n)
	}
	h.sim.RunTicks(20 * 60)
	h.do(func(*game.TickContext) { h.w.Teleport(p, pos(22, 20)) })
	h.sim.RunTicks(2)
	// 60 s after the give-up: 10 s of delay, then 1 point every 5 s.
	if hp, _ := wolf.Health(); hp != 50 {
		t.Errorf("health %d once its target is back after a minute, want 50 (40 + 10 regenerated)", hp)
	}
}

// A burn whose author went to another floor ends without hurting, even with the author
// right above the monster (within its leash area on the plan) and someone else holding
// its fight: nobody kills from where the monster cannot hit back.
func TestPursuitBurnFromAnotherFloorEnds(t *testing.T) {
	h := pursuitHarness(t, openFloors(t), harmlessWolf(false), content.Pursuit{RollMs: 1000}, content.MonsterRegenRate{},
		func(c *session.Config) { c.Balance.Conditions = testConditions() })
	_, above := h.join("Above", &world.Pos{X: 21, Y: 20, Z: 6})
	_, hunter, wolf := engaged(t, h, "Hunter", pos(22, 20))
	h.do(func(ctx *game.TickContext) {
		h.w.ApplyConditionForTest(ctx, nil, wolf, &content.ConditionApply{ID: "burning", Ticks: 4, Damage: 4}, above.ID())
	})
	h.sim.RunTicks(20 * 6)
	if hp, _ := wolf.Health(); hp != 100 || wolf.DamageShareForTest(above.ID()) != 0 || wolf.TargetID() != hunter.ID() {
		t.Errorf("after a burn from the floor above: health %d (want 100), its author's share %d (want 0), target %d (want the hunter %d)",
			hp, wolf.DamageShareForTest(above.ID()), wolf.TargetID(), hunter.ID())
	}
}

// A monster of little health regenerates at the balance's rate too: 1 % of 15 every 5 s is
// a point every 7 intervals (the fraction carries over), not a point per interval.
func TestPursuitRegenCarriesTheFraction(t *testing.T) {
	rat := harmlessWolf(false)
	rat.Health = 15
	regen := content.MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 1}
	h := pursuitHarness(t, nil, rat, content.Pursuit{}, regen)
	h.join("Far", at(20, 50)) // keeps the sector awake, out of its sight
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.do(func(ctx *game.TickContext) {
		wolf.SetHealth(5)
		wolf.CalmForTest(ctx)
	})
	h.sim.RunTicks(20 * 44) // 10 s of delay + 6 intervals, and almost the 7th
	if hp, _ := wolf.Health(); hp != 5 {
		t.Fatalf("health %d after 44 s, want 5 (6 intervals of 0.15)", hp)
	}
	h.sim.RunTicks(20 * 2)
	if hp, _ := wolf.Health(); hp != 6 {
		t.Errorf("health %d after 46 s, want 6 (7 intervals of 0.15)", hp)
	}
}

// What a monster regenerates comes out of the damage it remembers: who wounds it, lets it
// heal and comes back holds a share of the wounds it still has, not of all it ever dealt.
func TestPursuitRegenTakesFromTheShares(t *testing.T) {
	pur := content.Pursuit{RollMs: 1000, MemoryMs: 600000}
	regen := content.MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 1}
	passive := harmlessWolf(false)
	passive.Behavior.Aggressive = false
	h := pursuitHarness(t, nil, passive, pur, regen)
	_, a := h.join("First", at(22, 20))
	_, b := h.join("Other", at(20+comfort+3, 20)) // out of its zone: keeps the sector awake
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, wolf, a, 60) })
	h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), a.Pos()) <= 1 && wolf.TargetID() == a.ID() }, sim.MaxSeconds(3))
	h.sim.RunTicks(20 * 3) // a round of the wolf answers the hit
	h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, wolf, b, 20) })
	h.do(func(*game.TickContext) { h.w.Teleport(a, pos(20+comfort+2, 20)) })
	h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(2))
	hp, _ := wolf.Health()
	sa, sb := wolf.DamageShareForTest(a.ID()), wolf.DamageShareForTest(b.ID())
	if wolf.TargetID() != 0 || hp+sa+sb != 100 || sa != 60 {
		t.Fatalf("given up: target %d, health %d, shares %d and %d; want nobody, the first's 60 kept and shares that add up to its wounds",
			wolf.TargetID(), hp, sa, sb)
	}
	missing := 100 - hp
	h.sim.RunTicks(20 * (10 + 5*20)) // 20 points back
	hp2, _ := wolf.Health()
	sa2, sb2 := wolf.DamageShareForTest(a.ID()), wolf.DamageShareForTest(b.ID())
	if hp2 != hp+20 || sa2+sb2 > 100-hp2 || sa2 != sa*(missing-20)/missing {
		t.Errorf("after regenerating 20: health %d (was %d), shares %d and %d (were %d and %d); want them cut to the %d wounds left, in proportion",
			hp2, hp, sa2, sb2, sa, sb, 100-hp2)
	}
}
