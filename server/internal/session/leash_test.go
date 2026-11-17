package session_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Leash (balance combat.monster_leash_tiles, docs/02-game-design.md, monsters section): a
// monster's home area is its spawn's radius and its leash area that radius plus the leash.

// leashHarness is monsterHarness with combat.monster_leash_tiles = leash.
func leashHarness(t *testing.T, leash int, defs []*content.Monster, spawns ...world.Spawn) *harness {
	t.Helper()
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = spawns
	ms := content.Monsters{}
	for _, d := range defs {
		ms[d.ID] = d
	}
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = ms
		c.Items = testItems()
		c.Balance.Combat.MonsterLeashTiles = leash
	})
}

// east is n steps east.
func east(n int) *pb.ClientMessage {
	steps := make([]pb.Direction, n)
	for i := range steps {
		steps[i] = E
	}
	return walkPath(steps...)
}

// runLeashed runs the sim until done, at most seconds of game time, and fails the test
// as soon as m stands more than area tiles from center.
func runLeashed(t *testing.T, h *harness, m *session.Monster, center world.Pos, area int, seconds float64, done func() bool) int {
	t.Helper()
	return h.sim.RunUntil(func() bool {
		if d := chebyshev(m.Pos(), center); d > area {
			t.Fatalf("tick %d: %s at %v is %d tiles from %v, leash area %d", h.sim.Tick(), m.Kind(), m.Pos(), d, center, area)
		}
		return done()
	}, sim.MaxSeconds(seconds))
}

// A wolf chases a player who walks away beyond its leash: it never leaves its leash
// area, gives up (back to full health, which who sees it is told), walks into its home
// area and forgot who hurt it: the player who later kills it alone gets all the
// experience.
func TestLeashWolfGivesUpHealsAndForgets(t *testing.T) {
	const leash, radius = 4, 1
	center := pos(20, 20)
	h := leashHarness(t, leash, []*content.Monster{wolfDef()}, spawnAt("wolf", 20, 20, radius, 60))
	cl, runner := h.join("Runner", at(22, 20))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, false))
	h.input(cl, setTarget(wolf.ID()))
	runLeashed(t, h, wolf, center, radius+leash, 60, func() bool {
		hp, maxHP := wolf.Health()
		return hp < maxHP && wolf.TargetID() == runner.ID()
	})

	// The runner stops punching and walks 14 tiles east: the wolf follows, never out of
	// its leash area, and gives up once the runner is out of it and of its bite.
	h.input(cl, setTarget(0))
	h.input(cl, east(14))
	cl.take()
	runLeashed(t, h, wolf, center, radius+leash, 20, func() bool { return wolf.TargetID() == 0 })
	if hp, maxHP := wolf.Health(); hp != maxHP {
		t.Errorf("wolf gave up with %d/%d health, want full", hp, maxHP)
	}
	h.sim.Step() // flush
	var last uint32
	for _, ch := range find(cl.take(), (*pb.ServerMessage).GetCreatureHealth) {
		if ch.GetId() == wolf.ID() {
			last = ch.GetHealthPercent()
		}
	}
	if last != 100 {
		t.Errorf("the runner last saw the wolf at %d %% health, want 100", last)
	}
	n := runLeashed(t, h, wolf, center, radius+leash, 10, func() bool { return chebyshev(wolf.Pos(), center) <= radius })
	t.Logf("the wolf walked home in %d ticks", n)
	if wolf.TargetID() != 0 || chebyshev(runner.Pos(), center) <= radius+leash {
		t.Fatalf("wolf targets %d, runner at %v", wolf.TargetID(), runner.Pos())
	}

	clF, finisher := h.join("Finisher", at(23, 21))
	h.input(clF, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	h.input(clF, setTarget(wolf.ID()))
	h.sim.RunUntil(func() bool { return len(h.w.Monsters()) == 0 }, sim.MaxSeconds(120))
	if finisher.Experience() != 28 || runner.Experience() != 0 {
		t.Errorf("experience: finisher %d (want 28), runner %d (want 0)", finisher.Experience(), runner.Experience())
	}
}

// A wolf that lost its target (the player left the world) out of its home area walks
// back at its speed, without healing, much faster than the idle drift; with radius 0 it
// reaches the spawn's center itself.
func TestLeashLostTargetWalksHome(t *testing.T) {
	const leash = 6
	for _, radius := range []int{0, 2} {
		t.Run(fmt.Sprintf("radius %d", radius), func(t *testing.T) {
			center := pos(20, 20)
			h := leashHarness(t, leash, []*content.Monster{wolfDef()}, spawnAt("wolf", 20, 20, uint8(radius), 60))
			h.join("Far", at(50, 50)) // keeps the sector awake, out of view and of the leash
			cl, lure := h.join("Lure", at(20+radius+leash, 20))
			h.sim.Step()
			wolf := onlyMonster(t, h)
			runLeashed(t, h, wolf, center, radius+leash, 20, func() bool {
				return wolf.TargetID() == lure.ID() && chebyshev(wolf.Pos(), lure.Pos()) <= 1
			})
			h.sim.Command(gameFunc(func() { wolf.SetHealth(20) }))
			h.sim.Command(h.w.Leave(cl))
			h.sim.Step()
			from := wolf.Pos()
			if wolf.TargetID() != 0 || chebyshev(from, center) < radius+4 {
				t.Fatalf("after the lure left: wolf at %v targets %d", from, wolf.TargetID())
			}
			n := runLeashed(t, h, wolf, center, radius+leash, 5, func() bool { return chebyshev(wolf.Pos(), center) <= radius })
			t.Logf("from %v home (%v) in %d ticks", from, wolf.Pos(), n)
			if hp, _ := wolf.Health(); hp != 20 {
				t.Errorf("health %d after walking home, want 20 (a lost target does not heal)", hp)
			}
		})
	}
}

// Without a leash (testBalance) the old behaviour holds: a wolf follows its target far
// out of its spawn.
func TestNoLeashWolfFollowsFar(t *testing.T) {
	center := pos(20, 20)
	h := monsterHarness(t, []*content.Monster{wolfDef()}, spawnAt("wolf", 20, 20, 1, 60))
	cl, _ := h.join("Runner", at(22, 20))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.input(cl, east(14))
	h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), center) > 1+4+2 }, sim.MaxSeconds(20))
}

// A player out of the leash area is not picked as a target, even in plain view; one step
// into the area, it is.
func TestLeashIgnoresPlayersOutside(t *testing.T) {
	h := leashHarness(t, 2, []*content.Monster{wolfDef()}, spawnAt("wolf", 20, 20, 0, 60))
	cl, p := h.join("Watcher", at(24, 20))
	h.sim.RunFor(3e9)
	wolf := onlyMonster(t, h)
	if wolf.TargetID() != 0 {
		t.Fatalf("wolf targets the player 4 tiles from its spawn with a leash area of 2")
	}
	h.input(cl, walkPath(W, W))
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(5))
}

// A fleeing wolf runs only to the edge of its leash area.
func TestLeashFleeingWolfStaysInside(t *testing.T) {
	const leash = 3
	center := pos(30, 30)
	def := wolfDef()
	def.Behavior.FleeAtHealthPct = 40
	h := leashHarness(t, leash, []*content.Monster{def}, spawnAt("wolf", 30, 30, 0, 60))
	_, p := h.join("Bait", at(29, 30))
	h.sim.RunTicks(3)
	wolf := onlyMonster(t, h)
	if wolf.TargetID() != p.ID() {
		t.Fatalf("wolf targets %d, want %d", wolf.TargetID(), p.ID())
	}
	h.sim.Command(gameFunc(func() { wolf.SetHealth(5) }))
	end := h.sim.Tick() + 100 // 5 s
	runLeashed(t, h, wolf, center, leash, 6, func() bool { return h.sim.Tick() >= end })
	if wolf.State() != session.StateFlee || wolf.TargetID() != p.ID() || chebyshev(wolf.Pos(), center) != leash {
		t.Errorf("wolf at %v (%v, target %d), want fleeing at the edge, %d tiles from %v", wolf.Pos(), wolf.State(),
			wolf.TargetID(), leash, center)
	}
}

// A monster keeps fighting a target out of its leash area while it is within its
// attacks' reach (it shoots from inside), and gives up once it is not.
func TestLeashRangedKeepsShootingWithinReach(t *testing.T) {
	const leash = 1
	center := pos(20, 20)
	archer := &content.Monster{ID: "archer", Health: 1000, Speed: 100,
		Behavior: content.MonsterBehavior{Aggressive: true, TargetDistance: 1},
		Attacks:  []content.MonsterAttack{{Type: "distance", Element: "earth", Min: 2, Max: 2, IntervalMs: 1000, Chance: 1, Range: 4}},
	}
	h := leashHarness(t, leash, []*content.Monster{archer}, spawnAt("archer", 20, 20, 0, 60))
	cl, p := h.join("Target", at(21, 20))
	h.sim.Step()
	m := onlyMonster(t, h)
	runLeashed(t, h, m, center, leash, 5, func() bool { return m.TargetID() == p.ID() })

	// Three tiles east: out of the leash area, within reach of the arrows.
	h.input(cl, east(3))
	runLeashed(t, h, m, center, leash, 5, func() bool { return p.Pos() == pos(24, 20) && !p.Walking() })
	hp, _ := p.Health()
	end := h.sim.Tick() + 80 // 4 s
	runLeashed(t, h, m, center, leash, 5, func() bool {
		if m.TargetID() != p.ID() {
			t.Fatalf("tick %d: the archer at %v dropped its target at %v, within its reach", h.sim.Tick(), m.Pos(), p.Pos())
		}
		return h.sim.Tick() >= end
	})
	if now, _ := p.Health(); now >= hp {
		t.Errorf("health %d -> %d: the archer did not shoot from its leash area", hp, now)
	}

	// Out of reach too: it gives up and goes home.
	h.input(cl, east(3))
	runLeashed(t, h, m, center, leash, 5, func() bool { return m.TargetID() == 0 })
	runLeashed(t, h, m, center, leash, 5, func() bool { return m.Pos() == center })
}

// A wolf lured south past a row of water walks home around it: at the water the greedy
// step finds nothing, so it follows the whole A* detour (the greedy step from the first
// tile of the detour led straight back to the water, and it went back and forth there for
// good).
func TestLeashWalksHomeAroundWater(t *testing.T) {
	rows := make([]string, 64)
	for y := range rows {
		row := []byte(strings.Repeat(".", 64))
		if y == 23 {
			for x := 15; x <= 25; x++ {
				row[x] = '~'
			}
		}
		rows[y] = string(row)
	}
	m := worldtest.Map(t, 0, 0, 7, rows...)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 20, 20, 0, 60)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolfDef()}
		c.Items = testItems()
		c.Balance.Combat.MonsterLeashTiles = 6
	})
	h.join("Far", at(50, 50)) // keeps the sector awake
	cl, lure := h.join("Lure", at(26, 21))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.sim.RunUntil(func() bool { return wolf.TargetID() == lure.ID() && chebyshev(wolf.Pos(), lure.Pos()) <= 1 }, sim.MaxSeconds(30))
	h.input(cl, walkPath(S, S, S, S, W, W)) // round the end of the water, to its south side
	h.sim.RunUntil(func() bool {
		return lure.Pos() == pos(24, 25) && !lure.Walking() && chebyshev(wolf.Pos(), lure.Pos()) <= 1
	}, sim.MaxSeconds(30))
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	if wolf.Pos().Y <= 23 {
		t.Fatalf("the wolf is at %v, not south of the water", wolf.Pos())
	}
	from := wolf.Pos()
	n := h.sim.RunUntil(func() bool { return wolf.Pos() == pos(20, 20) }, sim.MaxSeconds(20))
	if n == 0 {
		t.Fatalf("the wolf did not get home from %v around the water in 20 s: at %v", from, wolf.Pos())
	}
}

// A burn whose caster stands beyond the leash and the reach of the monster ends without
// hurting it: it cannot be burnt to death from out of its leash, and nobody earns
// experience.
func TestLeashBurnFromOutsideEnds(t *testing.T) {
	const leash, radius = 4, 1
	def := wolfDef()
	def.Health = 15
	def.Behavior.FleeAtHealthPct = 0
	def.Behavior.Aggressive = false
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 20, 20, radius, 60)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": def}
		c.Items = testItems()
		c.Balance.Combat.MonsterLeashTiles = leash
		c.Balance.Conditions = testConditions()
	})
	_, caster := h.join("Caster", at(20+radius+leash+2, 20))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) {
		h.w.ApplyConditionForTest(ctx, nil, wolf, &content.ConditionApply{ID: "burning", Ticks: 4, Damage: 4}, caster.ID())
	}))
	h.sim.RunFor(6e9)
	if len(h.w.Monsters()) != 1 || caster.Experience() != 0 {
		t.Fatalf("burnt from out of its leash: %d monsters, caster experience %d", len(h.w.Monsters()), caster.Experience())
	}
	if hp, maxHP := wolf.Health(); hp != maxHP {
		t.Errorf("health %d/%d: the burn from outside hurt it", hp, maxHP)
	}
}

// That burn ends only itself: a monster that a player is killing inside its leash keeps
// its fight, its wounds and that player's damage (a third player out of the leash cannot
// reset it with a burn).
func TestLeashBurnFromOutsideDoesNotResetAFight(t *testing.T) {
	const leash, radius = 4, 1
	def := wolfDef()
	def.Health = 500
	def.Behavior.FleeAtHealthPct = 0
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 20, 20, radius, 60)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": def}
		c.Items = testItems()
		c.Balance.Combat.MonsterLeashTiles = leash
		c.Balance.Conditions = testConditions()
	})
	_, hunter := h.join("Hunter", at(22, 20))
	_, other := h.join("Other", at(20+radius+leash+2, 20))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.sim.RunUntil(func() bool { return wolf.TargetID() == hunter.ID() }, sim.MaxSeconds(5))
	h.sim.Command(gameFunc(func() { wolf.SetHealth(100) }))
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) {
		h.w.ApplyConditionForTest(ctx, nil, wolf, &content.ConditionApply{ID: "burning", Ticks: 4, Damage: 4}, other.ID())
	}))
	h.sim.RunFor(3e9)
	if hp, _ := wolf.Health(); hp > 100 || wolf.TargetID() != hunter.ID() {
		t.Errorf("after a burn from outside: health %d (was 100), target %d (want the hunter %d)", hp, wolf.TargetID(), hunter.ID())
	}
}

// A monster held by its leash is no training dummy: a ranger shooting it from beyond its
// leash and its reach trains distance as against a target that does not fight back
// (skills.afk.factor, 0.25 in testBalance): 4 shots, 1 try.
func TestLeashNoTrainingDummy(t *testing.T) {
	m := worldtest.Open(t, 0, 0, 32, 32)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("dummy", 14, 10, 0, 60)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"dummy": targetDummyDef()}
		c.Items = testItems()
		c.Spells = rangerSpells()
		c.Balance.Skills.Base["distance"] = content.SkillBase{StartLevel: 10, BaseTries: 1000}
		c.Balance.Combat.MonsterLeashTiles = 2
	})
	cl, p := ranger(t, h, pos(10, 10), 10) // 4 tiles from the dummy's spawn: beyond its leash
	d := h.dummy()
	h.input(cl, setTarget(d.ID()))
	h.sim.RunTicks(121) // shots at ticks 0, 40, 80, 120
	if got := h.w.CountItem(p, "test_arrow"); got != 6 {
		t.Fatalf("%d arrows left, want 6 after 4 shots", got)
	}
	if got := h.w.Skill(p, "distance").Tries; got != 1 {
		t.Errorf("distance tries %d after 4 shots from beyond the leash, want 1", got)
	}
}
