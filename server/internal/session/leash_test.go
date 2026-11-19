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

// waterHarness is a leash harness (combat.monster_leash_tiles 6) with a wolf of 1000
// health that never flees, spawned at 20,20 with radius 0 (leash area x and y 14-26), and
// a row of water at y 22 from x 0 to 30: its way round, x 31, is out of the leash area, so
// no way within it reaches the south shore. Each change, if any, edits the wolf's
// definition before the world starts.
func waterHarness(t *testing.T, change ...func(*content.Monster)) (*harness, *session.Monster) {
	t.Helper()
	rows := make([]string, 64)
	for y := range rows {
		row := []byte(strings.Repeat(".", 64))
		if y == 22 {
			for x := 0; x <= 30; x++ {
				row[x] = '~'
			}
		}
		rows[y] = string(row)
	}
	m := worldtest.Map(t, 0, 0, 7, rows...)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 20, 20, 0, 60)}
	def := wolfDef()
	def.Health, def.Behavior.FleeAtHealthPct = 1000, 0
	for _, f := range change {
		f(def)
	}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": def}
		c.Items = testItems()
		c.Spells = rangerSpells()
		c.Balance.Skills.Base["distance"] = content.SkillBase{StartLevel: 10, BaseTries: 1000}
		c.Balance.Combat.MonsterLeashTiles = 6
	})
	h.sim.Step()
	return h, onlyMonster(t, h)
}

// An attack held back for low health (below_hp_pct) is no reach before (review of the
// monster abilities): a wolf with a 4-tile spell it casts only below 10 % gives up the
// ranger across the water as a plain wolf does. Counted at full health, it made the wolf
// "reach" the ranger: no check of the way, never beyond its leash, so the ranger shot it
// for 20 s at the full training rate and it never answered. Below 10 % the spell is in
// use, so is its reach: the wolf holds the ranger and burns it from across the water.
func TestLeashCountsOnlyTheAttacksInUse(t *testing.T) {
	spell := func(def *content.Monster) {
		def.Attacks = append(def.Attacks, content.MonsterAttack{Type: content.AttackSpell, Element: "fire",
			Min: 5, Max: 5, IntervalMs: 1000, Chance: 1, Range: 4, BelowHealthPct: 10})
	}
	t.Run("above its below_hp_pct", func(t *testing.T) {
		h, wolf := waterHarness(t, spell)
		cl, p := ranger(t, h, pos(20, 23), 60)
		h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
		h.input(cl, setTarget(wolf.ID()))
		n := h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(8))
		t.Logf("the wolf gave the ranger up after %d ticks", n)
		if hp, maxHP := wolf.Health(); hp != maxHP {
			t.Errorf("the wolf gave up at %d/%d health, want full", hp, maxHP)
		}
		if hp, maxHP := p.Health(); hp != maxHP {
			t.Errorf("the ranger has %d/%d health: the wolf cast its low-health spell at full health", hp, maxHP)
		}
	})
	t.Run("below it", func(t *testing.T) {
		h, wolf := waterHarness(t, spell)
		h.sim.Command(gameFunc(func() { wolf.SetHealth(50) }))
		_, p := ranger(t, h, pos(20, 23), 0)
		h.sim.RunUntil(func() bool { return health(p) < 145 }, sim.MaxSeconds(2))
		h.sim.RunFor(3e9)
		if wolf.TargetID() != p.ID() || health(p) > 145-15 {
			t.Errorf("below 10 %%: the wolf targets %d (want the ranger %d), the ranger has %d health (want 3 spells or more)",
				wolf.TargetID(), p.ID(), health(p))
		}
	})
}

// An area that misses its target's tile holds no target beyond the leash (review of the
// monster abilities): a wolf with a beam of 4, or a circle of 2 around itself, follows the
// ranger along its shore to the corner of its leash area (26,21) and burns it from there
// (the ranger hops along the far shore, inside the leash area).
// Then the ranger shoots it from across the water 4 tiles east and 2 south (2 and 2 for
// the circle): a beam goes along one of 8 lines and a circle is round, so neither reaches
// that tile. Counted by their longest reach alone, the ranger was "in reach": the wolf
// held it, its area never hit it and each round counted as fighting back, so the ranger
// trained at the full rate, unhurt, for as long as it liked. Now the wolf gives it up as a
// plain wolf does (full health) and the arrows from there train as against a target that
// does not fight back (skills.afk.factor 0.25: the first one, no whole try).
func TestLeashAreaThatMissesHoldsNoTarget(t *testing.T) {
	for _, c := range []struct {
		name string
		area content.AttackArea
		from world.Pos // where the ranger shoots from
	}{
		{"beam", content.AttackArea{Shape: content.AreaBeam, Length: 4, Center: content.AreaSelf}, pos(30, 23)},
		{"circle", content.AttackArea{Shape: content.AreaCircle, Radius: 2, Center: content.AreaSelf}, pos(28, 23)},
	} {
		t.Run(c.name, func(t *testing.T) {
			h, wolf := waterHarness(t, func(def *content.Monster) {
				def.Attacks = append(def.Attacks, content.MonsterAttack{Type: content.AttackSpell, Element: "fire",
					Min: 5, Max: 5, IntervalMs: 1000, Chance: 1, Area: &c.area})
			})
			// The ranger hops along the far shore, 2 tiles at a time (a circle of 2 misses
			// a ranger 2 tiles east and 2 south: the wolf would give it up on the way).
			corner := pos(26, 21)
			cl, p := ranger(t, h, pos(22, 23), 60)
			h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
			for x := 22; x <= 26; x += 2 {
				h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(x, 23)) }))
				h.sim.RunUntil(func() bool { return wolf.Pos() == pos(x, 21) || wolf.TargetID() != p.ID() }, sim.MaxSeconds(5))
			}
			h.sim.RunUntil(func() bool { return health(p) < 145 || wolf.TargetID() != p.ID() }, sim.MaxSeconds(3))
			if wolf.Pos() != corner || wolf.TargetID() != p.ID() || health(p) >= 145 {
				t.Fatalf("the wolf stands on %v targeting %d with the ranger %d at %d health: want it on %v burning the ranger",
					wolf.Pos(), wolf.TargetID(), p.ID(), health(p), corner)
			}
			h.sim.Command(gameFunc(func() { h.w.Teleport(p, c.from); h.w.RestoreForTest(p) }))
			h.input(cl, setTarget(wolf.ID()))
			arrows, tries := h.w.CountItem(p, "test_arrow"), h.w.Skill(p, "distance").Tries
			h.sim.RunUntil(func() bool { return h.w.CountItem(p, "test_arrow") < arrows }, sim.MaxSeconds(4))
			h.sim.RunTicks(2)
			if h.w.CountItem(p, "test_arrow") != arrows-1 {
				t.Fatalf("the ranger shot %d arrows from %v, want 1", arrows-h.w.CountItem(p, "test_arrow"), c.from)
			}
			if got := h.w.Skill(p, "distance").Tries - tries; got != 0 {
				t.Errorf("an arrow from %v trained %d tries, want none (a quarter): the %s never reaches the ranger there", c.from, got, c.name)
			}
			if wolf.TargetID() == p.ID() {
				t.Errorf("the wolf on %v holds the ranger on %v, which its %s never hits", wolf.Pos(), c.from, c.name)
			}
			if hp, maxHP := wolf.Health(); hp != maxHP {
				t.Errorf("the wolf has %d/%d health: it should have given the ranger up (full health)", hp, maxHP)
			}
			if health(p) != 145 {
				t.Errorf("the ranger has %d health on %v, which the %s cannot reach", health(p), c.from, c.name)
			}
		})
	}
}

// A leash makes no safe spot inside its own area (review of lote 5): a ranger across the
// water from a wolf, inside the wolf's leash area but where the wolf could only get by
// leaving it, shoots the wolf, which stands at the water. Its chase checks the way once a
// second (pathRetry), not every tick; after stuckFor without one it gives the ranger up
// (full health, damage forgotten) and walks home. Then, for shunFor and on that tile, the
// ranger is beyond its leash: the wolf does not pick it again, each arrow makes it turn
// and give up again (it cannot be killed from there) and trains as against a target that
// does not fight back (skills.afk.factor, 0.25 in testBalance: 4 shots, 1 try).
func TestLeashGivesUpATargetItCannotReach(t *testing.T) {
	h, wolf := waterHarness(t)
	center := pos(20, 20)
	cl, p := ranger(t, h, pos(20, 23), 60) // 3 tiles from the wolf's spawn: in its leash area
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
	h.input(cl, setTarget(wolf.ID()))
	searching := 0 // ticks in which a monster searched a way
	h.sim.RunUntil(func() bool {
		if h.w.PathNodesSpentForTest() > 0 {
			searching++
		}
		return wolf.TargetID() == 0
	}, sim.MaxSeconds(8))
	if hp, maxHP := wolf.Health(); hp != maxHP || wolf.DamageShareForTest(p.ID()) != 0 || h.w.CountItem(p, "test_arrow") == 60 {
		t.Fatalf("the wolf gave up at %d/%d health, remembering %d damage (%d arrows left): want full and 0 after some shots",
			hp, maxHP, wolf.DamageShareForTest(p.ID()), h.w.CountItem(p, "test_arrow"))
	}
	t.Logf("the wolf gave up after searching a way in %d ticks", searching)
	if searching > 4 {
		t.Errorf("the wolf searched a way in %d ticks before giving up, want one a second (at most 4)", searching)
	}

	// Shunned: four more arrows train one try, and the wolf, home, never fights back.
	arrows, tries := h.w.CountItem(p, "test_arrow"), h.w.Skill(p, "distance").Tries
	held := 0 // ticks with the ranger as the wolf's target
	h.sim.RunUntil(func() bool {
		if wolf.TargetID() == p.ID() {
			held++
		}
		return h.w.CountItem(p, "test_arrow") == arrows-4 && !p.Walking()
	}, sim.MaxSeconds(12))
	h.sim.RunTicks(2)
	t.Logf("4 shots: the wolf held the ranger %d ticks", held)
	if got := h.w.Skill(p, "distance").Tries - tries; got != 1 {
		t.Errorf("4 shots from where the wolf gave the ranger up trained %d tries, want 1", got)
	}
	if held > 0 {
		t.Errorf("the wolf held the ranger as its target for %d ticks over 4 shots, want none (it gives up within the tick of each shot)", held)
	}
	if hp, maxHP := wolf.Health(); len(h.w.Monsters()) != 1 || hp < maxHP-20 || wolf.Pos() != center {
		t.Errorf("after 4 more shots the wolf is at %v with %d/%d health, want home at %v and (nearly) full", wolf.Pos(), hp, maxHP, center)
	}
}

// Walking along the far shore is no way out of that (review of lote 5): the ranger steps
// between 20,23 and 21,23 every 1.5 s, the wolf follows it step by step along its own
// shore, and those steps lead nowhere. Only a way found clears the wolf's count: it gives
// the ranger up after stuckFor anyway.
func TestLeashGivesUpATargetWalkingAlongTheShore(t *testing.T) {
	h, wolf := waterHarness(t)
	cl, p := ranger(t, h, pos(20, 23), 0)
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
	from := wolf.Pos()
	moved := false
	for i := 0; ; i++ {
		if i%30 == 0 {
			if i/30%2 == 0 {
				h.input(cl, walkPath(E))
			} else {
				h.input(cl, walkPath(W))
			}
		}
		h.sim.Step()
		moved = moved || wolf.Pos().X != from.X
		if wolf.TargetID() != p.ID() {
			t.Logf("the wolf gave the walking ranger up after %d ticks", i)
			break
		}
		if i >= 200 { // 10 s
			t.Fatalf("the wolf still chases the ranger along the shore after 10 s (it stands at %v)", wolf.Pos())
		}
	}
	if !moved {
		t.Error("the wolf never stepped along its shore: the scenario does not test a step that leads nowhere")
	}
}

// The shun holds on one tile (review of lote 5): on the tile where the wolf gave it up the
// ranger is ignored; one step away, along the same shore, it is a target again and costs
// stuckFor again before the wolf gives it up there too.
func TestLeashShunsATile(t *testing.T) {
	h, wolf := waterHarness(t)
	cl, p := ranger(t, h, pos(20, 23), 0)
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
	h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(8))
	h.sim.RunFor(2e9)
	if wolf.TargetID() != 0 {
		t.Fatalf("the wolf picked the ranger again on the tile where it gave it up")
	}
	h.input(cl, walkPath(E)) // 21,23: as unreachable, but another tile
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
	start := h.sim.Tick()
	h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(8))
	if held := h.sim.Tick() - start; held < 30 {
		t.Errorf("on a new tile the wolf gave the ranger up after %d ticks, want stuckFor (40) or about", held)
	}
}

// The shun lasts shunFor (combat.monster_shun_ms, 30 s in testBalance): the ranger keeps
// still on its tile, ignored until then, and is the wolf's target again right after.
func TestLeashShunExpires(t *testing.T) {
	h, wolf := waterHarness(t)
	_, p := ranger(t, h, pos(20, 23), 0)
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
	h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(8))
	shunned := h.sim.Tick()
	const shunFor = 30 * 20
	for h.sim.Tick() < shunned+shunFor-1 {
		h.sim.Step()
		if wolf.TargetID() == p.ID() {
			t.Fatalf("the wolf picked the shunned ranger again %d ticks after giving it up, before shunFor (%d)", h.sim.Tick()-shunned, shunFor)
		}
	}
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(1))
}

// After giving up a target it cannot reach, the wolf turns to a companion who hurt it and
// whom it can reach, without healing or forgetting.
func TestLeashUnreachableTurnsToACompanion(t *testing.T) {
	h, wolf := waterHarness(t)
	_, p := ranger(t, h, pos(20, 23), 0)
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
	_, mate := h.join("Mate", at(25, 18)) // the wolf's shore, in its leash area
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) {
		wolf.SetHealth(500)
		h.w.DamageMonsterForTest(ctx, wolf, mate, 10)
	}))
	h.sim.Step()
	if wolf.TargetID() != p.ID() {
		t.Fatalf("the wolf targets %d after the mate's hit, want the ranger %d", wolf.TargetID(), p.ID())
	}
	h.sim.RunUntil(func() bool { return wolf.TargetID() != p.ID() }, sim.MaxSeconds(8))
	if wolf.TargetID() != mate.ID() {
		t.Fatalf("the wolf turned to %d after giving the ranger up, want the mate %d", wolf.TargetID(), mate.ID())
	}
	if hp, _ := wolf.Health(); hp > 490 || wolf.DamageShareForTest(mate.ID()) != 10 {
		t.Errorf("after turning to the mate: health %d (want at most 490), the mate's damage %d (want 10)", hp, wolf.DamageShareForTest(mate.ID()))
	}
}

// When its target steps out of the leash, a monster turns to the closest player who hurt
// it; between two as close, to the one who hurt it first.
func TestLeashDropTargetTie(t *testing.T) {
	def := wolfDef()
	def.Health, def.Behavior.FleeAtHealthPct, def.Behavior.Aggressive = 1000, 0, false
	h := leashHarness(t, 4, []*content.Monster{def}, spawnAt("wolf", 20, 20, 0, 60))
	_, holder := h.join("Holder", at(21, 20))
	_, second := h.join("Second", at(20, 22))
	_, first := h.join("First", at(22, 20))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	if wolf.Pos() != pos(20, 20) || wolf.TargetID() != 0 {
		t.Fatalf("the passive wolf is at %v targeting %d, want home and idle", wolf.Pos(), wolf.TargetID())
	}
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) {
		h.w.DamageMonsterForTest(ctx, wolf, holder, 5) // its target
		h.w.DamageMonsterForTest(ctx, wolf, first, 5)  // 2 tiles away, hurt it first
		h.w.DamageMonsterForTest(ctx, wolf, second, 5) // 2 tiles away too
		h.w.Teleport(holder, pos(26, 20))              // out of the leash (4) and of its bite, in view
	}))
	h.sim.Step()
	if wolf.TargetID() != first.ID() {
		t.Errorf("the wolf turned to %d, want %d (as close as %d and hurt it first)", wolf.TargetID(), first.ID(), second.ID())
	}
}

// A creature in the way is no safe spot either (review of lote 5): an NPC, a training
// dummy or a still friend may never move. A ranger in a nook whose only way in a creature
// takes shoots a wolf that cannot get past it. After stuckFor the wolf turns to a player
// its bite reaches (the friend in the way), or, with none (a dummy), gives the ranger up
// as unreachable.
func TestLeashCreatureInTheWay(t *testing.T) {
	nook := func(t *testing.T, dummy bool) (*harness, *session.Monster) {
		t.Helper()
		rows := make([]string, 40)
		for y := range rows {
			row := []byte(strings.Repeat(".", 40))
			switch y {
			case 23, 24:
				row[19], row[21] = '#', '#'
			case 25:
				row[19], row[20], row[21] = '#', '#', '#'
			}
			rows[y] = string(row)
		}
		m := worldtest.Map(t, 0, 0, 7, rows...)
		spawns := []world.Spawn{spawnAt("wolf", 20, 18, 0, 60)}
		if dummy {
			spawns = append(spawns, spawnAt("dummy", 20, 23, 0, 60)) // the nook's mouth
		}
		m.Islands()[0].Spawns = spawns
		def := wolfDef()
		def.Health, def.Behavior.FleeAtHealthPct = 1000, 0
		h := newHarness(t, m, func(c *session.Config) {
			c.Monsters = content.Monsters{"wolf": def, "dummy": targetDummyDef()}
			c.Items = testItems()
			c.Spells = rangerSpells()
			c.Balance.Skills.Base["distance"] = content.SkillBase{StartLevel: 10, BaseTries: 1000}
			c.Balance.Combat.MonsterLeashTiles = 6
		})
		h.sim.Step()
		for _, mo := range h.w.Monsters() {
			if mo.Kind() == "wolf" {
				return h, mo
			}
		}
		t.Fatal("no wolf")
		return nil, nil
	}
	t.Run("a dummy", func(t *testing.T) {
		h, wolf := nook(t, true)
		cl, p := ranger(t, h, pos(20, 24), 60)
		h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
		h.input(cl, setTarget(wolf.ID()))
		h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(8))
		if hp, maxHP := wolf.Health(); hp != maxHP || wolf.DamageShareForTest(p.ID()) != 0 {
			t.Errorf("the wolf gave the ranger up at %d/%d health remembering %d damage, want full and 0", hp, maxHP, wolf.DamageShareForTest(p.ID()))
		}
	})
	t.Run("a friend", func(t *testing.T) {
		h, wolf := nook(t, false)
		cl, p := ranger(t, h, pos(20, 24), 60)
		h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(2))
		clF, friend := h.join("Friend", at(20, 23)) // stands in the nook's mouth
		h.input(cl, setTarget(wolf.ID()))
		h.sim.RunUntil(func() bool { return wolf.TargetID() != p.ID() }, sim.MaxSeconds(8))
		if wolf.TargetID() != friend.ID() {
			t.Fatalf("the wolf turned to %d, want the friend in its way %d", wolf.TargetID(), friend.ID())
		}
		if hp, maxHP := wolf.Health(); hp == maxHP || wolf.DamageShareForTest(p.ID()) == 0 {
			t.Errorf("after turning to the friend: health %d/%d, the ranger's damage %d (want it kept)", hp, maxHP, wolf.DamageShareForTest(p.ID()))
		}
		// The ranger was not given up (a way to it exists): once the friend is gone, the
		// wolf goes for it into the nook.
		h.sim.Command(h.w.Leave(clF))
		h.sim.RunUntil(func() bool {
			return wolf.TargetID() == p.ID() && chebyshev(wolf.Pos(), p.Pos()) == 1
		}, sim.MaxSeconds(3))
	})
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
