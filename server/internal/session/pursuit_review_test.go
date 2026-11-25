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

// Review of the monster pursuit (feat/monster-pursuit): what a monster keeps of a fight it
// gives up, when its regeneration starts, its pack's roll and its strays.

// No safe spot wears a monster down (review, blocking): a ranger across the water, inside
// the wolf's leash area, shoots it while it looks for a way (stuckFor), and when the wolf
// gives that tile up hops to the next one along the far shore, which costs the wolf
// stuckFor again. The wolf never got to answer one of those arrows: each time it gives up
// they close, so the hops never add up to a kill.
func TestPursuitUnreachableHopsDoNotWearItDown(t *testing.T) {
	h, wolf := waterHarness(t)
	cl, p := ranger(t, h, pos(20, 23), 60)
	for x := 20; x <= 24; x++ {
		h.do(func(*game.TickContext) { h.w.Teleport(p, pos(x, 23)) })
		h.input(cl, setTarget(wolf.ID()))
		arrows := h.w.CountItem(p, "test_arrow")
		h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(4))
		if wolf.TargetID() != p.ID() {
			t.Fatalf("ranger on %v: the wolf targets %d, want the ranger", p.Pos(), wolf.TargetID())
		}
		h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(8))
		if wolf.TargetID() != 0 {
			t.Fatalf("ranger on %v: the wolf still holds it after 8 s", p.Pos())
		}
		if h.w.CountItem(p, "test_arrow") == arrows {
			t.Fatalf("ranger on %v: no arrow shot, the scenario tests nothing", p.Pos())
		}
		if hp, maxHP := wolf.Health(); hp != maxHP || wolf.DamageShareForTest(p.ID()) != 0 {
			t.Fatalf("ranger on %v: the wolf gave up at %d/%d health remembering %d damage, want full and 0 (it never answered an arrow)",
				p.Pos(), hp, maxHP, wolf.DamageShareForTest(p.ID()))
		}
	}
}

// Hit and step out (review): damage dealt from out of the reach of the monster's attacks
// closes if it gives up before it answered it, so shooting a leashed monster while it
// walks up and stepping out of its area as it arrives is no way to wear it down. Once it
// got an attack round on that player it was a fight: those wounds stay.
func TestPursuitHitAndStepOutClosesTheWounds(t *testing.T) {
	h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{RollMs: 1000, MemoryMs: 60000}, content.MonsterRegenRate{})
	out := pos(20+comfort+2, 20) // out of its zone, in its sight
	_, p, wolf := engaged(t, h, "Archer", pos(24, 20))
	h.do(func(ctx *game.TickContext) {
		if chebyshev(wolf.Pos(), p.Pos()) <= 1 {
			t.Fatalf("the wolf at %v is next to the archer at %v already", wolf.Pos(), p.Pos())
		}
		h.w.DamageMonsterForTest(ctx, wolf, p, 30)
		h.w.Teleport(p, out)
	})
	h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(2))
	if hp, _ := wolf.Health(); wolf.TargetID() != 0 || hp != 100 || wolf.DamageShareForTest(p.ID()) != 0 {
		t.Fatalf("hit and step out: the wolf targets %d with %d health remembering %d damage, want given up, 100 and 0",
			wolf.TargetID(), hp, wolf.DamageShareForTest(p.ID()))
	}

	// The same shot, but the archer waits for the wolf: one attack round answers it.
	h.do(func(*game.TickContext) { h.w.Teleport(p, pos(24, 20)) })
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
	h.do(func(ctx *game.TickContext) {
		if wolf.TargetID() != p.ID() || chebyshev(wolf.Pos(), p.Pos()) <= 1 {
			t.Fatalf("the wolf at %v targets %d, want the archer at %v from afar", wolf.Pos(), wolf.TargetID(), p.Pos())
		}
		h.w.DamageMonsterForTest(ctx, wolf, p, 30)
	})
	h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(5))
	h.sim.RunTicks(45) // an attack round (2 s)
	h.do(func(*game.TickContext) { h.w.Teleport(p, out) })
	h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(2))
	if hp, _ := wolf.Health(); wolf.TargetID() != 0 || hp != 70 || wolf.DamageShareForTest(p.ID()) != 30 {
		t.Errorf("a fight it answered: the wolf targets %d with %d health remembering %d damage, want given up, 70 and 30",
			wolf.TargetID(), hp, wolf.DamageShareForTest(p.ID()))
	}
}

// Regeneration counts from the end of the fight, not from the last hit (review): a wolf
// that flees its target for a minute without anyone landing a hit does not get that
// minute of regeneration at once when the target goes; it starts delay_ms later.
func TestPursuitRegenStartsWhenTheFightEnds(t *testing.T) {
	regen := content.MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 1}
	def := harmlessWolf(false)
	def.Behavior.FleeAtHealthPct = 100 // it always flees: no attack round renews calmAt
	h := pursuitHarness(t, nil, def, content.Pursuit{}, regen)
	_, p, wolf := engaged(t, h, "Scare", pos(22, 20))
	h.do(func(ctx *game.TickContext) {
		wolf.SetHealth(50)
		wolf.CalmForTest(ctx)
	})
	const second = 20
	h.sim.RunTicks(60 * second)
	if hp, _ := wolf.Health(); wolf.TargetID() != p.ID() || hp != 50 {
		t.Fatalf("after a minute fleeing: the wolf targets %d with %d health, want the player and 50", wolf.TargetID(), hp)
	}
	h.do(func(*game.TickContext) { h.w.Teleport(p, pos(20, 50)) }) // out of its sight: lost at once
	h.sim.RunTicks(2)
	if hp, _ := wolf.Health(); wolf.TargetID() != 0 || hp != 50 {
		t.Fatalf("right after the fight: the wolf targets %d with %d health, want nobody and 50 (no regeneration owed)", wolf.TargetID(), hp)
	}
	h.sim.RunTicks(15*second - 6)
	if hp, _ := wolf.Health(); hp != 50 {
		t.Fatalf("health %d just before 15 s without a fight, want 50", hp)
	}
	h.sim.RunTicks(8)
	if hp, _ := wolf.Health(); hp != 51 {
		t.Errorf("health %d 15 s after the fight, want 51", hp)
	}
}

// Giving up keeps the damage of a fight the monster answered for memory_ms after the last
// hit (review: whoever wore it down is not robbed of the kill by who finishes it after it
// gave up); past the memory, or without one, the next fight starts afresh.
func TestPursuitGiveUpKeepsTheDamageShares(t *testing.T) {
	for _, c := range []struct {
		name   string
		memory int
		wait   int // ticks between the give-up and the kill
		shared bool
	}{{"within memory", 60000, 20 * 5, true}, {"past memory", 60000, 20 * 65, false}, {"no memory", 0, 20 * 5, false}} {
		t.Run(c.name, func(t *testing.T) {
			h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{RollMs: 1000, MemoryMs: c.memory}, content.MonsterRegenRate{})
			_, a, wolf := engaged(t, h, "First", pos(22, 20))
			h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), a.Pos()) <= 1 }, sim.MaxSeconds(3))
			h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, wolf, a, 60) })
			h.do(func(*game.TickContext) { h.w.Teleport(a, pos(20+comfort+2, 20)) })
			h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(2))
			want := 0
			if c.memory > 0 {
				want = 60
			}
			if hp, _ := wolf.Health(); wolf.TargetID() != 0 || hp != 40 || wolf.DamageShareForTest(a.ID()) != want {
				t.Fatalf("given up: the wolf targets %d with %d health remembering %d damage, want nobody, 40 and %d",
					wolf.TargetID(), hp, wolf.DamageShareForTest(a.ID()), want)
			}
			h.sim.RunTicks(c.wait)
			_, b := h.join("Second", at(20, 23))
			h.sim.RunTicks(10) // the wolf looks around (and forgets whose memory ran out)
			h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, wolf, b, 40) })
			if len(h.w.Monsters()) != 0 {
				t.Fatalf("the wolf survived the second player's 40")
			}
			t.Logf("experience: first %d, second %d", a.Experience(), b.Experience())
			if shared := a.Experience() > 0 && b.Experience() < 28; shared != c.shared || b.Experience() == 0 {
				t.Errorf("experience: first %d, second %d of 28; want shared %v", a.Experience(), b.Experience(), c.shared)
			}
		})
	}
}

// A monster's own persistence or regeneration needs the balance's roll_ms / interval_ms
// (review): without them it would roll, or heal, every tick, so the world does not start.
func TestPursuitNeedsTheBalanceIntervals(t *testing.T) {
	start := func(def *content.Monster, pur content.Pursuit, regen content.MonsterRegenRate) error {
		m := worldtest.Open(t, 0, 0, 64, 64)
		m.Islands()[0].Spawns = []world.Spawn{spawnAt(def.ID, 20, 20, 1, 60)}
		b := testBalance()
		b.Combat.MonsterPursuit, b.Combat.MonsterRegen = pur, regen
		_, err := session.New(session.Config{Map: m, Balance: b, Vocations: testVocations, Items: testItems(),
			Monsters: content.Monsters{def.ID: def}, Save: func(session.Snapshot) bool { return true }})
		return err
	}
	half, one := 0.5, 1.0
	stubborn := wolfDef()
	stubborn.Pursuit = &content.MonsterPursuit{Persistence: &half}
	if err := start(stubborn, content.Pursuit{}, content.MonsterRegenRate{}); err == nil || !strings.Contains(err.Error(), "roll_ms") {
		t.Errorf("a monster's persistence without the balance's roll_ms: %v, want an error about roll_ms", err)
	}
	if err := start(stubborn, content.Pursuit{RollMs: 1000}, content.MonsterRegenRate{}); err != nil {
		t.Errorf("a monster's persistence with the balance's roll_ms: %v", err)
	}
	healer := wolfDef()
	healer.Regen = &content.MonsterRegen{Pct: &one}
	if err := start(healer, content.Pursuit{}, content.MonsterRegenRate{}); err == nil || !strings.Contains(err.Error(), "interval_ms") {
		t.Errorf("a monster's regeneration without the balance's interval_ms: %v, want an error about interval_ms", err)
	}
}

// packHarness is pursuitHarness with two wolves in the spawn; it joins a player next to
// their home and returns them once both target it.
func packHarness(t *testing.T, pur content.Pursuit) (*harness, *session.Player, [2]*session.Monster) {
	t.Helper()
	h := pursuitHarness(t, nil, harmlessWolf(false), pur, content.MonsterRegenRate{}, func(c *session.Config) {
		c.Map.Islands()[0].Spawns[0].Monsters[0].Count = 2
	})
	_, p := h.join("Prey", at(23, 20))
	h.sim.Step()
	ms := h.w.Monsters()
	if len(ms) != 2 {
		t.Fatalf("%d monsters, want a pack of 2", len(ms))
	}
	pack := [2]*session.Monster{ms[0], ms[1]}
	packTargets(t, h, p, pack)
	return h, p, pack
}

// packTargets runs until both wolves of pack target p.
func packTargets(t *testing.T, h *harness, p *session.Player, pack [2]*session.Monster) {
	t.Helper()
	both := func() bool { return pack[0].TargetID() == p.ID() && pack[1].TargetID() == p.ID() }
	h.sim.RunUntil(both, sim.MaxSeconds(5))
	if !both() {
		t.Fatalf("the pack targets %d and %d, want the prey twice", pack[0].TargetID(), pack[1].TargetID())
	}
}

// One roll for the pack: the two wolves of a spawn take the same decision on a target
// that steps out of their comfort zone, time after time (two rolls of their own would
// differ about every other time), and over the tries they both follow and both give up.
func TestPursuitPackSharesOneRoll(t *testing.T) {
	pur := content.Pursuit{Persistence: 0.5, MaxChaseTiles: 20, LoseSightMs: 60000, RollMs: 1000, MemoryMs: 60000}
	h, p, pack := packHarness(t, pur)
	kept, gaveUp := 0, 0
	for range 16 {
		h.do(func(*game.TickContext) { h.w.Teleport(p, pos(20+comfort+3, 20)) })
		h.sim.Step() // both think: one decision
		a, b := pack[0].TargetID() == p.ID(), pack[1].TargetID() == p.ID()
		if a != b {
			t.Fatalf("tick %d: one wolf follows the prey out of the zone (%v) and the other does not (%v): want one decision for the pack",
				h.sim.Tick(), a, b)
		}
		if a {
			kept++
		} else {
			gaveUp++
		}
		h.do(func(*game.TickContext) { h.w.Teleport(p, pos(23, 20)) })
		h.sim.RunTicks(25) // past roll_ms: the next try is a new roll
		packTargets(t, h, p, pack)
	}
	t.Logf("the pack followed %d times and gave up %d", kept, gaveUp)
	if kept == 0 || gaveUp == 0 {
		t.Errorf("the pack followed %d times and gave up %d: want both over 16 rolls of about 0.4", kept, gaveUp)
	}
}

// A coward turns back alone (review): a wolf below its give_up_below_hp_pct does not
// follow its pack out of the comfort zone, and its giving up is not the pack's decision:
// the healthy one goes on. Whichever of the two thinks first.
func TestPursuitCowardLeavesItsPack(t *testing.T) {
	pur := content.Pursuit{Persistence: 1, MaxChaseTiles: 20, LoseSightMs: 60000, RollMs: 3000, GiveUpBelowHpPct: 50}
	for coward := range 2 {
		h, p, pack := packHarness(t, pur)
		h.do(func(*game.TickContext) {
			pack[coward].SetHealth(40)
			h.w.Teleport(p, pos(20+comfort+3, 20))
		})
		h.sim.RunTicks(3)
		if c, brave := pack[coward], pack[1-coward]; c.TargetID() != 0 || brave.TargetID() != p.ID() || !brave.PursuingForTest() {
			t.Errorf("coward %d: it targets %d (want nobody), the healthy wolf %d (pursuing %v; want the prey %d, pursuing)",
				coward, c.TargetID(), brave.TargetID(), brave.PursuingForTest(), p.ID())
		}
	}
}

// A stray never goes back to its spawn under a player's eyes (review): one who has it on
// screen (the wide view, wider than the classic window monsters notice players in) keeps
// it there; once that player is gone, it goes.
func TestPursuitStrayStaysWhileOnScreen(t *testing.T) {
	rows := make([]string, 64)
	for y := range rows {
		row := []byte(strings.Repeat(".", 64))
		row[30] = '~'
		rows[y] = string(row)
	}
	h := pursuitHarness(t, worldtest.Map(t, 0, 0, 7, rows...), harmlessWolf(false), content.Pursuit{}, content.MonsterRegenRate{},
		func(c *session.Config) { c.Balance.Combat.MonsterStrayMs = 10000 })
	cl, _ := h.join("Watcher", at(44, 20)) // the stray walks to the water (31,20): 13 tiles west, on screen, out of the classic window
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.do(func(*game.TickContext) { h.w.MoveMonsterForTest(wolf, pos(40, 20)) })
	h.sim.RunTicks(20 * 12)
	if got := h.w.Monsters(); len(got) != 1 || got[0] != wolf {
		t.Fatalf("after 12 s: %d monsters, want the stray still there, on the watcher's screen", len(got))
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.RunTicks(3)
	if got := h.w.Monsters(); len(got) != 0 {
		t.Errorf("with nobody watching: %d monsters, want the stray gone back to its spawn", len(got))
	}
}

// A monster is a stray from the tick it steps out of its home area (review: noted after
// its step, not before), and one chasing a target is not on its way to be retired: the
// time it spent out with a target does not count for monster_stray_ms.
func TestPursuitStrayFromItsFirstStepOut(t *testing.T) {
	pur := content.Pursuit{Persistence: 1, MaxChaseTiles: 20, LoseSightMs: 60000, RollMs: 1000}
	h := pursuitHarness(t, nil, harmlessWolf(true), pur, content.MonsterRegenRate{},
		func(c *session.Config) { c.Balance.Combat.MonsterStrayMs = 2000 })
	cl, p, wolf := engaged(t, h, "Lure", pos(22, 20))
	h.input(cl, east(14))
	out := 0 // ticks the wolf spent out of its home area
	h.sim.RunUntil(func() bool {
		if chebyshev(wolf.Pos(), home) > pursuitRadius {
			out++
			if h.w.StraysForTest() != 1 {
				t.Fatalf("tick %d: the wolf at %v is out of its home area and %d strays are listed, want it", h.sim.Tick(), wolf.Pos(), h.w.StraysForTest())
			}
		}
		return !p.Walking() && chebyshev(wolf.Pos(), p.Pos()) <= 1
	}, sim.MaxSeconds(20))
	if out < 3*20 || chebyshev(wolf.Pos(), home) <= comfort {
		t.Fatalf("the wolf at %v spent %d ticks out of its home area: want it lured out for more than 3 s", wolf.Pos(), out)
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.RunTicks(10)
	if got := h.w.Monsters(); len(got) != 1 || got[0] != wolf {
		t.Fatalf("right after its target left: %d monsters, want the wolf walking home (its chase is no time astray)", len(got))
	}
}
