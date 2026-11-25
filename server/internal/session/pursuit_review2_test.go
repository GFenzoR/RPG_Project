package session_test

import (
	"math"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Second review of the monster pursuit (feat/monster-pursuit): a target the monster loses
// track of, a group's damage, its own heal, what it remembers of a fight nobody gave up,
// a pack pulled by two players, and the balance's numbers of the chance.

// outOfZone is a tile out of the wolf's comfort zone and in its sight from home.
var outOfZone = pos(20+comfort+2, 20)

// Shoot and hide (review, important): damage dealt from out of the wolf's reach closes
// when it loses track of its author before it answered it, whether the author steps into a
// protection zone at the edge of the wolf's comfort zone or out of its sight: losing a
// target is giving it up, so neither is a way to wear a monster down without a fight. Once
// it got an attack round in, it was a fight: those wounds stay.
func TestPursuitShootAndHideClosesTheWounds(t *testing.T) {
	safe := pos(25, 20) // a protection zone inside the wolf's comfort zone
	for _, c := range []struct {
		name string
		hide world.Pos
	}{{"into a protection zone", safe}, {"out of sight", pos(20, 50)}} {
		t.Run(c.name, func(t *testing.T) {
			m := worldtest.Open(t, 0, 0, 64, 64)
			worldtest.SetTile(t, m, safe, worldtest.Grass, world.FlagProtection)
			h := pursuitHarness(t, m, harmlessWolf(false), content.Pursuit{RollMs: 1000, MemoryMs: 60000}, content.MonsterRegenRate{})
			_, p, wolf := engaged(t, h, "Archer", pos(24, 20))
			for cycle := range 3 { // time after time: the cycles never add up
				h.do(func(ctx *game.TickContext) {
					if wolf.TargetID() != p.ID() || chebyshev(wolf.Pos(), p.Pos()) <= 1 {
						t.Fatalf("cycle %d: the wolf at %v targets %d, want the archer at %v from afar", cycle, wolf.Pos(), wolf.TargetID(), p.Pos())
					}
					h.w.DamageMonsterForTest(ctx, wolf, p, 30)
					h.w.Teleport(p, c.hide)
				})
				h.sim.Step()
				if hp, _ := wolf.Health(); wolf.TargetID() != 0 || hp != 100 || wolf.DamageShareForTest(p.ID()) != 0 {
					t.Fatalf("cycle %d, shot and hid: the wolf targets %d with %d health remembering %d damage, want nobody, 100 and 0",
						cycle, wolf.TargetID(), hp, wolf.DamageShareForTest(p.ID()))
				}
				h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), home) <= pursuitRadius }, sim.MaxSeconds(5))
				h.do(func(*game.TickContext) { h.w.Teleport(p, pos(24, 20)) })
				h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
			}

			// The same shot, but the archer waits for the wolf: one attack round answers it.
			h.do(func(ctx *game.TickContext) {
				if wolf.TargetID() != p.ID() || chebyshev(wolf.Pos(), p.Pos()) <= 1 {
					t.Fatalf("the wolf at %v targets %d, want the archer at %v from afar", wolf.Pos(), wolf.TargetID(), p.Pos())
				}
				h.w.DamageMonsterForTest(ctx, wolf, p, 30)
			})
			h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(5))
			h.sim.RunTicks(45) // an attack round (2 s)
			h.do(func(*game.TickContext) { h.w.Teleport(p, c.hide) })
			h.sim.Step()
			if hp, _ := wolf.Health(); wolf.TargetID() != 0 || hp != 70 || wolf.DamageShareForTest(p.ID()) != 30 {
				t.Errorf("a fight it answered: the wolf targets %d with %d health remembering %d damage, want nobody, 70 and 30",
					wolf.TargetID(), hp, wolf.DamageShareForTest(p.ID()))
			}
		})
	}
}

// A group's fight (review, important): while a tank holds the wolf, the archer who hits it
// from a few tiles away never gets an attack round of its own. A round on the tank answers
// the archer's damage too, as long as the archer stands where the wolf may go: when the
// group walks off and the wolf gives up, it is still hurt and the archer keeps its share.
// An archer out of the wolf's leash area is not in that fight: its damage closes.
func TestPursuitGroupDamageIsAnswered(t *testing.T) {
	for _, c := range []struct {
		name   string
		archer world.Pos
		health int
		share  int
	}{{"archer inside its zone", pos(24, 23), 70, 30}, {"archer beyond its leash", pos(20+comfort+2, 22), 100, 0}} {
		t.Run(c.name, func(t *testing.T) {
			h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{RollMs: 1000, MemoryMs: 60000}, content.MonsterRegenRate{})
			_, tank, wolf := engaged(t, h, "Tank", pos(22, 20))
			_, archer := h.join("Archer", &c.archer)
			h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), tank.Pos()) <= 1 }, sim.MaxSeconds(3))
			h.do(func(ctx *game.TickContext) {
				if wolf.TargetID() != tank.ID() || chebyshev(wolf.Pos(), archer.Pos()) <= 1 {
					t.Fatalf("the wolf at %v targets %d, want the tank and the archer at %v out of its reach", wolf.Pos(), wolf.TargetID(), archer.Pos())
				}
				h.w.DamageMonsterForTest(ctx, wolf, archer, 30)
			})
			h.sim.RunTicks(45) // an attack round on the tank (2 s)
			if hp, _ := wolf.Health(); wolf.TargetID() != tank.ID() || hp != 70 {
				t.Fatalf("after a round: the wolf targets %d with %d health, want the tank and 70", wolf.TargetID(), hp)
			}
			// The group retreats to heal: both out of its zone.
			h.do(func(*game.TickContext) {
				h.w.Teleport(tank, outOfZone)
				h.w.Teleport(archer, pos(20+comfort+2, 22))
			})
			h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(2))
			if hp, _ := wolf.Health(); wolf.TargetID() != 0 || hp != c.health || wolf.DamageShareForTest(archer.ID()) != c.share {
				t.Errorf("the group left: the wolf targets %d with %d health remembering %d damage of the archer, want nobody, %d and %d",
					wolf.TargetID(), hp, wolf.DamageShareForTest(archer.ID()), c.health, c.share)
			}
		})
	}
}

// sniped is a wolf at 30 of 100 health that targets a tank next to it, who dealt 40 it
// answered, with 30 more from a sniper out of its leash area that it never answered.
func sniped(t *testing.T, regen content.MonsterRegenRate) (*harness, *fakeClient, *session.Monster) {
	t.Helper()
	h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{RollMs: 1000, MemoryMs: 600000}, regen)
	cl, tank, wolf := engaged(t, h, "Tank", pos(22, 20))
	_, sniper := h.join("Sniper", &outOfZone)
	h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), tank.Pos()) <= 1 }, sim.MaxSeconds(3))
	h.do(func(ctx *game.TickContext) {
		h.w.DamageMonsterForTest(ctx, wolf, tank, 40)   // next to it: a fight
		h.w.DamageMonsterForTest(ctx, wolf, sniper, 30) // from where it cannot answer
	})
	h.sim.RunTicks(45) // a round on the tank does not answer a sniper beyond its leash
	if hp, _ := wolf.Health(); wolf.TargetID() != tank.ID() || hp != 30 {
		t.Fatalf("the wolf targets %d with %d health, want the tank and 30", wolf.TargetID(), hp)
	}
	return h, cl, wolf
}

// What it regenerates comes out of the wounds it never answered (review): a wolf whose
// target left the world, that regenerated a little and then gives up, closes only what is
// left of them, not the same wounds twice.
func TestPursuitRegenAndGiveUpDoNotHealTwice(t *testing.T) {
	h, tank, wolf := sniped(t, content.MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 1})
	h.sim.Command(h.w.Leave(tank)) // no give-up: the sniper's wounds stay open
	h.sim.RunTicks(20 * 31)
	mid, _ := wolf.Health()
	if wolf.TargetID() != 0 || mid <= 30 || mid >= 40 {
		t.Fatalf("after 31 s: the wolf targets %d with %d health, want nobody and a few points over 30", wolf.TargetID(), mid)
	}
	h.do(func(ctx *game.TickContext) { h.w.GiveUpForTest(ctx, wolf) })
	if hp, _ := wolf.Health(); hp != 60 {
		t.Errorf("giving up after regenerating %d: %d health, want 60 (the 30 it never answered, once)", mid-30, hp)
	}
}

// Its own heal too (review, minor): what a monster heals itself (heal_self) comes out of
// the wounds it never answered, so giving up does not close them again.
func TestPursuitOwnHealAndGiveUpDoNotHealTwice(t *testing.T) {
	h, _, wolf := sniped(t, content.MonsterRegenRate{})
	h.do(func(ctx *game.TickContext) {
		h.w.HealMonsterForTest(wolf, 20)
		h.w.GiveUpForTest(ctx, wolf)
	})
	if hp, _ := wolf.Health(); hp != 60 {
		t.Errorf("giving up after healing itself 20: %d health, want 60 (the 30 it never answered, once)", hp)
	}
}

// The damage of a fight that ended without the monster giving anyone up is forgotten after
// memory_ms too (review, minor): its target went out of its sight, or left the world. It
// does not wait for a regeneration to full health (none here) to forget it.
func TestPursuitLostFightIsForgotten(t *testing.T) {
	for _, c := range []struct {
		name string
		lose func(h *harness, cl *fakeClient, p *session.Player)
	}{
		{"out of sight", func(h *harness, _ *fakeClient, p *session.Player) {
			h.do(func(*game.TickContext) { h.w.Teleport(p, pos(40, 55)) })
		}},
		{"left the world", func(h *harness, cl *fakeClient, _ *session.Player) { h.sim.Command(h.w.Leave(cl)) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{RollMs: 1000, MemoryMs: 60000}, content.MonsterRegenRate{})
			h.join("Far", at(20, 50)) // keeps the sector awake, out of the wolf's sight
			cl, p, wolf := engaged(t, h, "Hitter", pos(22, 20))
			h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(3))
			h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, wolf, p, 60) })
			c.lose(h, cl, p)
			h.sim.RunTicks(20 * 5)
			if wolf.TargetID() != 0 || wolf.DamageShareForTest(p.ID()) != 60 {
				t.Fatalf("5 s later: the wolf targets %d remembering %d damage, want nobody and 60", wolf.TargetID(), wolf.DamageShareForTest(p.ID()))
			}
			h.sim.RunTicks(20 * 60)
			if hp, _ := wolf.Health(); hp != 40 || wolf.DamageShareForTest(p.ID()) != 0 {
				t.Errorf("65 s later: the wolf has %d health and remembers %d damage, want 40 and 0 (memory_ms 60000)", hp, wolf.DamageShareForTest(p.ID()))
			}
		})
	}
}

// A pack pulled by two players holds one decision per target (review, minor): the wolves
// on one prey decide together whichever of them thinks first, also with a wolf on the
// other prey thinking between them (it used to overwrite the pack's decision, so the
// next wolf rolled its own).
func TestPursuitPackDecidesPerTarget(t *testing.T) {
	pur := content.Pursuit{Persistence: 0.5, MaxChaseTiles: 20, LoseSightMs: 60000, RollMs: 1000, MemoryMs: 60000}
	for odd := range 3 { // which wolf chases the other prey: one of the three thinks between the other two
		h := pursuitHarness(t, nil, harmlessWolf(false), pur, content.MonsterRegenRate{}, func(c *session.Config) {
			c.Map.Islands()[0].Spawns[0].Monsters[0].Count = 3
		})
		_, a := h.join("Prey", at(23, 20))
		_, b := h.join("Other", at(23, 22))
		h.sim.Step()
		pack := h.w.Monsters()
		if len(pack) != 3 {
			t.Fatalf("%d monsters, want a pack of 3", len(pack))
		}
		var pair []*session.Monster
		for i, m := range pack {
			if i != odd {
				pair = append(pair, m)
			}
		}
		kept, gaveUp := 0, 0
		for range 16 {
			h.do(func(*game.TickContext) {
				for i, m := range pack {
					if i == odd {
						m.SetTargetForTest(b)
					} else {
						m.SetTargetForTest(a)
					}
				}
				h.w.Teleport(a, pos(20+comfort+3, 20))
				h.w.Teleport(b, pos(20+comfort+3, 23))
			})
			h.sim.Step()
			x, y := pair[0].TargetID() == a.ID(), pair[1].TargetID() == a.ID()
			if x != y {
				t.Fatalf("odd wolf %d, tick %d: one wolf follows the prey out of the zone (%v) and the other does not (%v): want one decision per target",
					odd, h.sim.Tick(), x, y)
			}
			if x {
				kept++
			} else {
				gaveUp++
			}
			if n := h.w.PackRollsForTest(pack[0]); n > 2 {
				t.Fatalf("odd wolf %d: the spawn holds %d decisions for 2 targets", odd, n)
			}
			h.do(func(*game.TickContext) {
				h.w.Teleport(a, pos(23, 20))
				h.w.Teleport(b, pos(23, 22))
			})
			h.sim.RunTicks(25) // past roll_ms: the next try is a new roll
		}
		if kept == 0 || gaveUp == 0 {
			t.Errorf("odd wolf %d: the pair followed %d times and gave up %d: want both over 16 rolls of about 0.4", odd, kept, gaveUp)
		}
	}
}

// insist_target_hp_pct in a real chase (review: only the formula had a test): a wolf that
// all but never follows out of its comfort zone goes after a prey below that health, and
// lets a healthy one go.
func TestPursuitInsistsOnAWeakTarget(t *testing.T) {
	pur := content.Pursuit{Persistence: 1e-9, MaxChaseTiles: 20, LoseSightMs: 60000, RollMs: 1000,
		InsistTargetHpPct: 30, DistanceExponent: 2, InsistBoost: 1}
	for _, weak := range []bool{false, true} {
		h := pursuitHarness(t, nil, harmlessWolf(false), pur, content.MonsterRegenRate{})
		_, p, wolf := engaged(t, h, "Prey", pos(23, 20))
		h.do(func(*game.TickContext) {
			if weak {
				p.SetHealthForTest(20) // below 30 % of 145
			}
			h.w.Teleport(p, pos(20+comfort+3, 20))
		})
		h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 || chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(8))
		followed := wolf.TargetID() == p.ID() && wolf.PursuingForTest() && chebyshev(wolf.Pos(), home) > comfort
		if followed != weak {
			t.Errorf("weak prey %v: the wolf at %v targets %d (pursuing %v), want it to follow %v",
				weak, wolf.Pos(), wolf.TargetID(), wolf.PursuingForTest(), weak)
		}
	}
}

// A wolf chasing its target beyond its comfort zone that loses it past its chase cap turns
// on another player who hurt it and stands inside its zone (retarget), keeping its wounds
// and their shares: it does not give the fight up (review: no test had it while pursuing).
func TestPursuitRetargetsWhilePursuing(t *testing.T) {
	pur := content.Pursuit{Persistence: 1, MaxChaseTiles: 12, LoseSightMs: 60000, RollMs: 1000, MemoryMs: 60000}
	passive := harmlessWolf(false)
	passive.Behavior.Aggressive = false // it turns only on who hurt it
	h := pursuitHarness(t, nil, passive, pur, content.MonsterRegenRate{})
	_, a := h.join("Runner", at(23, 20))
	_, b := h.join("Second", at(20, 23))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.do(func(ctx *game.TickContext) {
		h.w.DamageMonsterForTest(ctx, wolf, a, 10)
		h.w.DamageMonsterForTest(ctx, wolf, b, 20)
		h.w.Teleport(a, pos(20+comfort+1, 20))
	})
	h.sim.RunTicks(2)
	if wolf.TargetID() != a.ID() || !wolf.PursuingForTest() {
		t.Fatalf("the wolf targets %d (pursuing %v), want the runner out of its zone, pursued", wolf.TargetID(), wolf.PursuingForTest())
	}
	h.do(func(*game.TickContext) { h.w.Teleport(a, pos(20+13, 20)) }) // past its chase cap
	h.sim.Step()
	if hp, _ := wolf.Health(); wolf.TargetID() != b.ID() || wolf.PursuingForTest() || hp != 70 || wolf.DamageShareForTest(b.ID()) != 20 {
		t.Errorf("its target past the cap: the wolf targets %d (pursuing %v) with %d health remembering %d of the second, want the second (%d), not pursuing, 70 and 20",
			wolf.TargetID(), wolf.PursuingForTest(), hp, wolf.DamageShareForTest(b.ID()), b.ID())
	}
}

// The balance's numbers of the chance (review, minor: they were constants in the code):
// distance_exponent 0 keeps the persistence at any distance, insist_boost is how much of
// the way to 1 a weak target takes it.
func TestPursuitChanceBalanceNumbers(t *testing.T) {
	pur := content.Pursuit{Persistence: 0.5, MaxChaseTiles: 15, RollMs: 3000, InsistTargetHpPct: 30, InsistBoost: 0.2}
	h := pursuitHarness(t, nil, harmlessWolf(false), pur, content.MonsterRegenRate{})
	_, p := h.join("Far", at(20+15, 50)) // out of the wolf's sight: it stays idle
	h.sim.Step()
	wolf := onlyMonster(t, h)
	chance := func() float64 {
		var c float64
		h.do(func(*game.TickContext) {
			h.w.Teleport(p, pos(20+15, 20))
			c = h.w.PursuitChanceForTest(wolf, p)
			h.w.Teleport(p, pos(20+15, 50))
		})
		return c
	}
	if c := chance(); math.Abs(c-0.5) > 1e-9 {
		t.Errorf("distance_exponent 0 at the chase cap: %v, want the persistence 0.5", c)
	}
	h.do(func(*game.TickContext) { p.SetHealthForTest(20) })
	if c := chance(); math.Abs(c-0.6) > 1e-9 {
		t.Errorf("insist_boost 0.2 against a weak target: %v, want 0.6", c)
	}
}
