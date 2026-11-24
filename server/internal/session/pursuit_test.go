package session_test

import (
	"math"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Pursuit and regeneration (pursuit.go, docs/02-game-design.md monsters section, owner's
// request of 2026-11-23). The wolves of these tests spawn at 20,20 with radius 1 and a
// leash of 4: their comfort zone (the leash area) reaches 5 tiles from the center.

const (
	pursuitLeash  = 4
	pursuitRadius = 1
	comfort       = pursuitRadius + pursuitLeash
)

var home = pos(20, 20)

// pursuitHarness is a harness on m (an open 64x64 floor 7 if nil) with one wolf (def,
// wolfDef if nil) spawned at 20,20, the leash of these tests and the given pursuit and
// regeneration.
func pursuitHarness(t *testing.T, m *world.Map, def *content.Monster, p content.Pursuit, r content.MonsterRegenRate,
	opts ...func(*session.Config)) *harness {
	t.Helper()
	if m == nil {
		m = worldtest.Open(t, 0, 0, 64, 64)
	}
	if def == nil {
		def = wolfDef()
	}
	m.Islands()[0].Spawns = []world.Spawn{spawnAt(def.ID, 20, 20, pursuitRadius, 60)}
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{def.ID: def}
		c.Items = testItems()
		c.Balance.Combat.MonsterLeashTiles = pursuitLeash
		c.Balance.Combat.MonsterPursuit = p
		c.Balance.Combat.MonsterRegen = r
		for _, o := range opts {
			o(c)
		}
	})
}

// harmlessWolf is a wolf that bites for 0, never flees and has 100 health; fast makes it
// outrun any player.
func harmlessWolf(fast bool) *content.Monster {
	d := wolfDef()
	d.Health, d.Behavior.FleeAtHealthPct = 100, 0
	d.Attacks[0].Max = 0
	if fast {
		d.Speed = 400
	}
	return d
}

// engaged joins a player at p and runs until the wolf targets it.
func engaged(t *testing.T, h *harness, name string, p world.Pos) (*fakeClient, *session.Player, *session.Monster) {
	t.Helper()
	cl, pl := h.join(name, &p)
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.sim.RunUntil(func() bool { return wolf.TargetID() == pl.ID() }, sim.MaxSeconds(3))
	if wolf.TargetID() != pl.ID() {
		t.Fatalf("the wolf targets %d, want %s (%d)", wolf.TargetID(), name, pl.ID())
	}
	return cl, pl, wolf
}

// Inside its comfort zone a monster always chases, even one that never pursues beyond it
// (persistence 0): the wolf follows a player who walks around within the zone.
func TestPursuitChasesInsideTheComfortZone(t *testing.T) {
	h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{}, content.MonsterRegenRate{})
	cl, p, wolf := engaged(t, h, "Walker", pos(22, 20))
	h.input(cl, walkPath(SE, SE, S, S)) // to 24,24: 4 tiles from the center
	runLeashed(t, h, wolf, home, comfort, 10, func() bool {
		return !p.Walking() && chebyshev(wolf.Pos(), p.Pos()) <= 1
	})
	if wolf.TargetID() != p.ID() || chebyshev(wolf.Pos(), p.Pos()) > 1 || wolf.PursuingForTest() {
		t.Errorf("wolf at %v targets %d (pursuing %v), walker at %v: want it next to the walker, chasing inside its zone",
			wolf.Pos(), wolf.TargetID(), wolf.PursuingForTest(), p.Pos())
	}
}

// The chance of keeping a chase beyond the comfort zone: persistence^(1 + 2·(d-l)/(cap-l))
// for a target d tiles from the center (leash area l, chase cap 15), 0 below the
// monster's give_up_below_hp_pct, halfway to 1 against a target below
// insist_target_hp_pct, and always 1 for a persistence of 1.
func TestPursuitChance(t *testing.T) {
	pur := content.Pursuit{Persistence: 0.5, MaxChaseTiles: 15, RollMs: 3000, GiveUpBelowHpPct: 20, InsistTargetHpPct: 30}
	h := pursuitHarness(t, nil, harmlessWolf(false), pur, content.MonsterRegenRate{})
	_, p := h.join("Far", at(20+comfort+1, 50)) // out of the wolf's sight: it stays idle
	h.sim.Step()
	wolf := onlyMonster(t, h)
	chance := func(x int) float64 {
		var c float64
		h.do(func(*game.TickContext) {
			h.w.Teleport(p, pos(x, 20))
			c = h.w.PursuitChanceForTest(wolf, p)
		})
		return c
	}
	near := math.Pow(0.5, 1+2.0/10)
	if c := chance(20 + comfort + 1); math.Abs(c-near) > 1e-9 {
		t.Errorf("just out of the comfort zone: %v, want %v", c, near)
	}
	if c := chance(20 + 15); math.Abs(c-0.125) > 1e-9 {
		t.Errorf("at the chase cap: %v, want 0.125", c)
	}
	h.do(func(*game.TickContext) { p.SetHealthForTest(20) }) // below 30 % of 145
	if c := chance(20 + 15); math.Abs(c-(0.125+0.875/2)) > 1e-9 {
		t.Errorf("against a weak target at the cap: %v, want %v", c, 0.125+0.875/2)
	}
	h.do(func(*game.TickContext) { wolf.SetHealth(19) })
	if c := chance(20 + comfort + 1); c != 0 {
		t.Errorf("below its give_up_below_hp_pct: %v, want 0", c)
	}
}

// pursuitRun drags a fast wolf east (the runner walks 30 tiles east from next to it) and
// reports the tick at which the wolf gave the runner up and the farthest tile from the
// center it reached. It fails if the wolf ever passes its chase cap.
func pursuitRun(t *testing.T, pur content.Pursuit) (gaveUp int, farthest int) {
	t.Helper()
	h := pursuitHarness(t, nil, harmlessWolf(true), pur, content.MonsterRegenRate{})
	cl, p, wolf := engaged(t, h, "Runner", pos(22, 20))
	h.input(cl, east(30))
	n := runLeashed(t, h, wolf, home, max(comfort, pur.MaxChaseTiles), 40, func() bool {
		farthest = max(farthest, chebyshev(wolf.Pos(), home))
		return wolf.TargetID() == 0
	})
	if wolf.TargetID() != 0 {
		t.Fatalf("after 40 s the wolf still chases the runner (wolf at %v, runner at %v)", wolf.Pos(), p.Pos())
	}
	return n, farthest
}

// Beyond the comfort zone the chase is a roll of the loop's seeded random source: the same
// seed gives the same chase, tick for tick. A persistence of 0.5 with this seed follows
// out of the zone for a while and then gives up before the cap.
func TestPursuitGiveUpIsReproducible(t *testing.T) {
	pur := content.Pursuit{Persistence: 0.5, MaxChaseTiles: 20, LoseSightMs: 60000, RollMs: 1000}
	n1, far1 := pursuitRun(t, pur)
	n2, far2 := pursuitRun(t, pur)
	t.Logf("gave up after %d ticks, %d tiles from the center at most", n1, far1)
	if n1 != n2 || far1 != far2 {
		t.Errorf("two runs with one seed: gave up after %d and %d ticks, %d and %d tiles out", n1, n2, far1, far2)
	}
	if far1 <= comfort || far1 >= 20 {
		t.Errorf("the wolf reached %d tiles from the center: want beyond its comfort zone (%d) and short of its cap (20)", far1, comfort)
	}
	// Without persistence it never leaves its comfort zone.
	if _, far := pursuitRun(t, content.Pursuit{MaxChaseTiles: 20, LoseSightMs: 60000, RollMs: 1000}); far > comfort {
		t.Errorf("persistence 0: the wolf reached %d tiles from the center, want at most %d", far, comfort)
	}
}

// The hard cap: a wolf that never gives up (persistence 1) follows the runner to its
// max_chase_tiles and not one tile farther (runLeashed fails the test), then lets it go.
func TestPursuitHardCap(t *testing.T) {
	const cap = 12
	_, far := pursuitRun(t, content.Pursuit{Persistence: 1, MaxChaseTiles: cap, LoseSightMs: 60000, RollMs: 1000})
	// It stops next to the runner standing on its cap's last tile, or on it.
	if far < cap-1 || far > cap {
		t.Errorf("the wolf reached %d tiles from the center, want %d or %d (its cap)", far, cap-1, cap)
	}
}

// A target out of the monster's sight (the classic window) is kept lose_sight_ms, chased
// where it is, and given up after that; without lose_sight_ms it is lost at once.
func TestPursuitLosesSight(t *testing.T) {
	pur := content.Pursuit{Persistence: 1, MaxChaseTiles: 30, LoseSightMs: 2000, RollMs: 1000}
	h := pursuitHarness(t, nil, harmlessWolf(false), pur, content.MonsterRegenRate{})
	_, p, wolf := engaged(t, h, "Hider", pos(22, 20))
	h.do(func(*game.TickContext) { h.w.Teleport(p, pos(21, 42)) }) // 22 tiles south: out of sight
	h.sim.RunTicks(30)                                             // 1.5 s
	if wolf.TargetID() != p.ID() {
		t.Fatalf("after 1.5 s out of sight the wolf targets %d, want the hider (lose_sight_ms 2000)", wolf.TargetID())
	}
	if wolf.Pos().Y <= 21 {
		t.Errorf("the wolf at %v did not go after the hider", wolf.Pos())
	}
	h.sim.RunTicks(11)
	if wolf.TargetID() != 0 {
		t.Errorf("after 2 s out of sight the wolf targets %d, want nobody", wolf.TargetID())
	}

	h = pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{Persistence: 1, MaxChaseTiles: 30, RollMs: 1000},
		content.MonsterRegenRate{})
	_, p, wolf = engaged(t, h, "Hider", pos(22, 20))
	h.do(func(*game.TickContext) { h.w.Teleport(p, pos(21, 42)) })
	h.sim.Step()
	if wolf.TargetID() != 0 {
		t.Errorf("without lose_sight_ms the wolf targets %d after its target left its sight, want nobody", wolf.TargetID())
	}
}

// A target that steps into a protection zone is given up at once, however persistent the
// monster, and the monster does not wait at the border: it walks home.
func TestPursuitProtectionZone(t *testing.T) {
	m := worldtest.Open(t, 0, 0, 64, 64)
	for y := 0; y < 64; y++ {
		worldtest.SetTile(t, m, pos(30, y), worldtest.Grass, world.FlagProtection)
	}
	pur := content.Pursuit{Persistence: 1, MaxChaseTiles: 30, LoseSightMs: 60000, RollMs: 1000}
	h := pursuitHarness(t, m, harmlessWolf(true), pur, content.MonsterRegenRate{})
	cl, p, wolf := engaged(t, h, "Safe", pos(22, 20))
	h.input(cl, east(8)) // to 30,20: the protection zone
	h.sim.RunUntil(func() bool { return p.Pos() == pos(30, 20) }, sim.MaxSeconds(10))
	h.sim.Step()
	if wolf.TargetID() != 0 {
		t.Fatalf("the wolf targets %d with its target in a protection zone, want nobody", wolf.TargetID())
	}
	runLeashed(t, h, wolf, home, 30, 10, func() bool { return chebyshev(wolf.Pos(), home) <= pursuitRadius })
	if chebyshev(wolf.Pos(), home) > pursuitRadius {
		t.Errorf("the wolf stays at %v, want it home", wolf.Pos())
	}
}

// A target that changes floor is given up at once: monsters take no stairs.
func TestPursuitFloorChange(t *testing.T) {
	open := make([]string, 64)
	for i := range open {
		open[i] = strings.Repeat(".", 64)
	}
	m := worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 6, Rows: open}, worldtest.Layer{Z: 7, Rows: open})
	pur := content.Pursuit{Persistence: 1, MaxChaseTiles: 30, LoseSightMs: 60000, RollMs: 1000}
	h := pursuitHarness(t, m, harmlessWolf(false), pur, content.MonsterRegenRate{})
	h.join("Far", at(20, 50)) // keeps floor 7 awake, out of the wolf's sight
	_, p, wolf := engaged(t, h, "Climber", pos(22, 20))
	h.do(func(*game.TickContext) { h.w.Teleport(p, world.Pos{X: 22, Y: 20, Z: 6}) })
	h.sim.Step()
	if wolf.TargetID() != 0 {
		t.Errorf("the wolf targets %d with its target a floor up, want nobody", wolf.TargetID())
	}
}

// Giving up keeps the monster's wounds (no full heal) and it walks home at its speed
// (when its slow regeneration starts: TestPursuitRegenStartsWhenTheFightEnds).
func TestPursuitGiveUpKeepsHealth(t *testing.T) {
	regen := content.MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 1}
	h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{RollMs: 1000}, regen)
	cl, p, wolf := engaged(t, h, "Biter", pos(22, 20))
	h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(3))
	h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, wolf, p, 60) })
	h.input(cl, east(14))
	runLeashed(t, h, wolf, home, comfort, 20, func() bool { return wolf.TargetID() == 0 })
	runLeashed(t, h, wolf, home, comfort, 10, func() bool { return chebyshev(wolf.Pos(), home) <= pursuitRadius })
	if hp, _ := wolf.Health(); hp != 40 || chebyshev(wolf.Pos(), home) > pursuitRadius {
		t.Errorf("the wolf is at %v with %d health, want home with 40 (its wounds kept)", wolf.Pos(), hp)
	}
}

// Slow regeneration: delay_ms (10 s) after its last fight, pct % (1) of its maximum health
// every interval_ms (5 s), counted from the ticks: also while no player was near and it
// did not think. With a target it never regenerates (it has no heal spell).
func TestPursuitRegeneration(t *testing.T) {
	regen := content.MonsterRegenRate{DelayMs: 10000, IntervalMs: 5000, Pct: 1}
	const second = 20 // ticks
	t.Run("out of combat", func(t *testing.T) {
		h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{}, regen)
		cl, _ := h.join("Far", at(20, 50)) // keeps the sector awake, out of the wolf's sight
		h.sim.Step()
		wolf := onlyMonster(t, h)
		h.do(func(ctx *game.TickContext) {
			wolf.SetHealth(50)
			wolf.CalmForTest(ctx)
		})
		h.sim.RunTicks(15*second - 2)
		if hp, _ := wolf.Health(); hp != 50 {
			t.Fatalf("health %d just before 15 s, want 50", hp)
		}
		h.sim.RunTicks(2)
		if hp, _ := wolf.Health(); hp != 51 {
			t.Fatalf("health %d at 15 s, want 51", hp)
		}
		// Nobody near for a minute: the wolf does not think, the time counts anyway.
		h.sim.Command(h.w.Leave(cl))
		h.sim.RunTicks(60 * second)
		if hp, _ := wolf.Health(); hp != 51 {
			t.Fatalf("health %d while nobody was near, want 51 (it does not think)", hp)
		}
		h.join("Back", at(20, 50))
		h.sim.RunTicks(2)
		if hp, _ := wolf.Health(); hp != 63 {
			t.Errorf("health %d once someone came back at 75 s, want 63", hp)
		}
	})
	t.Run("in combat", func(t *testing.T) {
		h := pursuitHarness(t, nil, harmlessWolf(false), content.Pursuit{}, regen)
		_, _, wolf := engaged(t, h, "Tank", pos(22, 20))
		h.do(func(*game.TickContext) { wolf.SetHealth(50) })
		h.sim.RunTicks(60 * second)
		if hp, _ := wolf.Health(); hp != 50 {
			t.Errorf("health %d after a minute fighting, want 50 (no regeneration in combat)", hp)
		}
	})
}

// A monster remembers who hurt it in a fight it gave up for memory_ms: when that player
// comes back into its comfort zone it turns on it first, even a passive one that picks
// nobody else. Once the memory ran out it lets the player be.
func TestPursuitReaggroesARememberedAttacker(t *testing.T) {
	passive := harmlessWolf(false)
	passive.Behavior.Aggressive = false
	for _, c := range []struct {
		name   string
		wait   int // ticks before the attacker comes back
		aggros bool
	}{{"within memory", 20 * 5, true}, {"after it", 20 * 65, false}} {
		t.Run(c.name, func(t *testing.T) {
			h := pursuitHarness(t, nil, passive, content.Pursuit{RollMs: 1000, MemoryMs: 60000}, content.MonsterRegenRate{})
			_, a := h.join("Hitter", at(22, 20))
			h.join("Bystander", at(19, 21)) // closer to the wolf all along
			h.sim.Step()
			wolf := onlyMonster(t, h)
			h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, wolf, a, 5) })
			h.sim.Step()
			if wolf.TargetID() != a.ID() {
				t.Fatalf("the wolf targets %d after the hit, want the hitter", wolf.TargetID())
			}
			h.do(func(*game.TickContext) { h.w.Teleport(a, pos(20+comfort+2, 20)) }) // out of its zone, in sight
			h.sim.RunUntil(func() bool { return wolf.TargetID() == 0 }, sim.MaxSeconds(2))
			if wolf.TargetID() != 0 {
				t.Fatalf("the wolf still targets %d, want it to give up", wolf.TargetID())
			}
			h.sim.RunTicks(c.wait)
			if wolf.TargetID() != 0 {
				t.Fatalf("the wolf targets %d while the hitter stays away", wolf.TargetID())
			}
			h.do(func(*game.TickContext) { h.w.Teleport(a, pos(23, 20)) })
			h.sim.RunTicks(10)
			if got := wolf.TargetID() == a.ID(); got != c.aggros {
				t.Errorf("the wolf targets %d (the hitter is %d), want re-aggro %v", wolf.TargetID(), a.ID(), c.aggros)
			}
		})
	}
}

// An idle monster out of its home area walks home even with no player anywhere (its
// sector is not active: it thinks as a stray).
func TestPursuitIdleWalkHome(t *testing.T) {
	pur := content.Pursuit{Persistence: 1, MaxChaseTiles: 20, LoseSightMs: 60000, RollMs: 1000}
	h := pursuitHarness(t, nil, harmlessWolf(true), pur, content.MonsterRegenRate{})
	cl, p, wolf := engaged(t, h, "Lure", pos(22, 20))
	h.input(cl, east(14))
	h.sim.RunUntil(func() bool { return !p.Walking() && chebyshev(wolf.Pos(), p.Pos()) <= 1 }, sim.MaxSeconds(15))
	from := wolf.Pos()
	if chebyshev(from, home) <= comfort {
		t.Fatalf("the wolf at %v did not follow the lure out of its zone", from)
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	if len(h.w.Players()) != 0 || h.w.StraysForTest() != 1 {
		t.Fatalf("%d players, %d strays: want none and the wolf", len(h.w.Players()), h.w.StraysForTest())
	}
	n := h.sim.RunUntil(func() bool { return chebyshev(wolf.Pos(), home) <= pursuitRadius }, sim.MaxSeconds(15))
	t.Logf("from %v home (%v) in %d ticks with nobody in the world", from, wolf.Pos(), n)
	if chebyshev(wolf.Pos(), home) > pursuitRadius {
		t.Fatalf("the wolf stays at %v, want it home", wolf.Pos())
	}
	h.sim.RunTicks(2) // it notices it is home on its next think, the list drops it on the one after
	if h.w.StraysForTest() != 0 {
		t.Errorf("%d strays once home, want 0", h.w.StraysForTest())
	}
}

// A stray that cannot get home (water all the way across) goes back to its spawn after
// combat.monster_stray_ms, once nobody sees it: the spawn does not count a lost monster
// alive forever.
func TestPursuitStuckStrayRespawns(t *testing.T) {
	rows := make([]string, 64)
	for y := range rows {
		row := []byte(strings.Repeat(".", 64))
		row[30] = '~'
		rows[y] = string(row)
	}
	m := worldtest.Map(t, 0, 0, 7, rows...)
	h := pursuitHarness(t, m, harmlessWolf(false), content.Pursuit{}, content.MonsterRegenRate{},
		func(c *session.Config) { c.Balance.Combat.MonsterStrayMs = 10000 })
	h.join("Far", at(40, 55)) // keeps the sector awake, out of the wolf's sight
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.do(func(*game.TickContext) { h.w.MoveMonsterForTest(wolf, pos(40, 20)) })
	h.sim.RunTicks(20 * 9)
	if got := h.w.Monsters(); len(got) != 1 || got[0] != wolf {
		t.Fatalf("after 9 s: %d monsters, want the stray still there", len(got))
	}
	h.sim.RunTicks(20 * 2)
	if got := h.w.Monsters(); len(got) != 0 {
		t.Fatalf("after 11 s: %d monsters, want the stray gone back to its spawn", len(got))
	}
	h.sim.RunTicks(20 * 6) // the respawn retry
	got := h.w.Monsters()
	if len(got) != 1 || got[0] == wolf || chebyshev(got[0].Pos(), home) > pursuitRadius {
		t.Fatalf("after the respawn: %d monsters, want a new wolf at home", len(got))
	}
}
