package session_test

import (
	"fmt"
	"slices"
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

// Monster abilities (session/abilities.go, docs/02, monsters section): area attacks, heal_self,
// summons and a boss's phases, all data; and the chase that follows its way around a wall.

// parsedMonster decodes a data/monsters file as the server loads it (defaults included).
func parsedMonster(t *testing.T, src string) *content.Monster {
	t.Helper()
	m, err := content.ParseMonster([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// abilityHarness is a harness on the map drawn by rows (top-left at 0,0 on floor 7), with
// the test conditions, the monsters defs and spawns.
func abilityHarness(t *testing.T, m *world.Map, defs []*content.Monster, spawns ...world.Spawn) *harness {
	t.Helper()
	m.Islands()[0].Spawns = spawns
	ms := content.Monsters{}
	for _, d := range defs {
		ms[d.ID] = d
	}
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = ms
		c.Items = testItems()
		c.Balance.Conditions = testConditions()
	})
}

// joinAll logs a guardian in at each tile in the same tick (before any monster may act)
// and returns their clients and players; then hide, if not nil, runs in that tick too.
func (h *harness) joinAll(tiles []world.Pos, hide func([]*session.Player)) ([]*fakeClient, []*session.Player) {
	h.t.Helper()
	var cls []*fakeClient
	var ids []int64
	for i, p := range tiles {
		nextChar++
		c := session.Character{ID: nextChar, AccountID: nextChar, Name: fmt.Sprintf("P%d", i), Vocation: "guardian", Level: 1,
			Health: 145, Mana: 20, Pos: p, HasPos: true}
		cl := &fakeClient{}
		h.sim.Command(h.joinCmd(c, cl))
		cls, ids = append(cls, cl), append(ids, c.ID)
	}
	players := func() []*session.Player {
		var ps []*session.Player
		for _, id := range ids {
			ps = append(ps, h.w.PlayerByCharacter(id))
		}
		return ps
	}
	if hide != nil {
		h.sim.Command(gameFunc(func() { hide(players()) }))
	}
	h.sim.Step()
	ps := players()
	for i, p := range ps {
		if p == nil {
			h.t.Fatalf("player %d did not join", i)
		}
	}
	return cls, ps
}

// health is p's current health.
func health(p *session.Player) int { h, _ := p.Health(); return h }

// attacksOf returns the CreatureAttacks of creature id in evs.
func attacksOf(evs []*pb.ServerMessage, id uint32) []*pb.CreatureAttack {
	var out []*pb.CreatureAttack
	for _, a := range find(evs, (*pb.ServerMessage).GetCreatureAttack) {
		if a.GetId() == id {
			out = append(out, a)
		}
	}
	return out
}

// effectTiles returns the tiles of the Effects of effect id in evs.
func effectTiles(evs []*pb.ServerMessage, id uint32) []world.Pos {
	var out []world.Pos
	for _, e := range find(evs, (*pb.ServerMessage).GetEffect) {
		if e.GetEffectId() == id {
			out = append(out, world.Pos{X: uint16(e.GetPos().GetX()), Y: uint16(e.GetPos().GetY()), Z: uint8(e.GetPos().GetZ())})
		}
	}
	return out
}

const fireEffect = session.EffectElementBase + 1 // the effect of a fire tile or hit

// A circle around the monster hits the two players in it that it has line of sight to
// (its target and one more), each with the attack's element and condition; not one
// behind a wall, nor one in a protection zone. The clients get one CreatureAttack with
// the area and an Effect on every tile of it.
func TestMonsterCircleAroundItself(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"...........",
		"...........",
		"...........",
		"...........",
		".....#.....",
		"...........",
		"...........",
		"...........",
		"...........",
	)
	worldtest.SetTile(t, m, pos(3, 5), worldtest.Grass, world.FlagProtection)
	slam := parsedMonster(t, `id: slammer
health: 500
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: spell, element: fire, min: 10, max: 10, interval_ms: 2000, area: { shape: circle, radius: 2 },
      condition: { id: burning, ticks: 2, damage: 3 } }
`)
	h := abilityHarness(t, m, []*content.Monster{slam}, spawnAt("slammer", 5, 5, 0, 60))
	cls, ps := h.joinAll([]world.Pos{pos(5, 6), pos(7, 5), pos(5, 3), pos(3, 5)}, nil)
	clT, target, side, behind, safe := cls[0], ps[0], ps[1], ps[2], ps[3]
	mo := onlyMonster(t, h)
	h.sim.RunUntil(func() bool { return health(target) < 145 }, sim.MaxSeconds(5))
	h.sim.Step() // flush
	evs := clT.take()

	for _, c := range []struct {
		p    *session.Player
		want int
		burn bool
	}{{target, 135, true}, {side, 135, true}, {behind, 145, false}, {safe, 145, false}} {
		if got := health(c.p); got != c.want {
			t.Errorf("%v: health %d, want %d", c.p.Pos(), got, c.want)
		}
		if _, burning := h.w.ConditionsForTest(c.p)["burning"]; burning != c.burn {
			t.Errorf("%v: burning %v, want %v", c.p.Pos(), burning, c.burn)
		}
	}
	atk := attacksOf(evs, mo.ID())
	if len(atk) != 1 || atk[0].GetTargetId() != 0 || atk[0].GetRadius() != 2 || atk[0].GetKind() != pb.AttackKind_ATTACK_KIND_SPELL ||
		atk[0].GetTo().GetX() != 5 || atk[0].GetTo().GetY() != 5 {
		t.Fatalf("attacks = %v, want one SPELL of radius 2 around (5,5)", atk)
	}
	tiles := effectTiles(evs, fireEffect)
	// The 21 tiles of radius 2 but (5,3), behind the wall; the target's hit adds its own
	// fire effect on (5,6), and so does Side's on (7,5) (hitEvents).
	if want := 20 + 2; len(tiles) != want {
		t.Errorf("%d fire effects, want %d: %v", len(tiles), want, tiles)
	}
	if slices.Contains(tiles, pos(5, 3)) || !slices.Contains(tiles, pos(5, 4)) || !slices.Contains(tiles, pos(3, 5)) {
		t.Errorf("fire tiles %v: want the wall but not what it hides", tiles)
	}
}

// An area that kills a player halfway through goes on (review of the monster
// abilities): the players after it in the area are still hit, and the dead one, who
// wakes up at the temple inside the same circle (a protection zone), is not hit again.
func TestMonsterAreaKillsAPlayerHalfway(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"...........",
		"...........",
		"...........",
		"...........",
		"...........",
		"...........",
		"...........",
		".....T.....",
		"...........",
	)
	temple := pos(5, 7)
	worldtest.SetTile(t, m, temple, worldtest.Grass, world.FlagProtection)
	slam := parsedMonster(t, `id: slammer
health: 500
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: spell, element: fire, min: 10, max: 10, interval_ms: 2000, area: { shape: circle, radius: 2 } }
`)
	h := abilityHarness(t, m, []*content.Monster{slam}, spawnAt("slammer", 5, 5, 0, 60))
	// The circle covers its tiles row by row: the victim (row 4) is hit before the others
	// (rows 5 and 6), and the temple (row 7) is in the circle.
	_, ps := h.joinAll([]world.Pos{pos(5, 4), pos(4, 5), pos(6, 6)}, func(ps []*session.Player) {
		h.w.SetPlayerHealthForTest(ps[0], 5)
	})
	victim, others := ps[0], ps[1:]
	h.sim.RunUntil(func() bool { return health(others[0]) < 145 }, sim.MaxSeconds(5))
	if victim.Pos() != temple || health(victim) != 145 {
		t.Errorf("the victim is on %v with %d health, want woken up on the temple %v with full health (145)", victim.Pos(), health(victim), temple)
	}
	for _, p := range others {
		if health(p) != 135 {
			t.Errorf("%v: health %d after the victim died, want 135", p.Pos(), health(p))
		}
	}
}

// A beam goes length tiles from the monster towards its target and stops at a wall: it
// hits who stands on it, not who stands beside it or behind the wall. Diagonal too.
func TestMonsterBeam(t *testing.T) {
	breath := parsedMonster(t, `id: breather
health: 500
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: spell, element: fire, min: 10, max: 10, interval_ms: 2000, area: { shape: beam, length: 4 } }
`)
	rows := []string{
		"............",
		"............",
		"............",
		"............",
		"............",
		"............",
		"............",
		"............",
		".....#......",
		"............",
		"............",
		"............",
	}
	// The breather stands on (5,5); its target is the only player next to it.
	for _, c := range []struct {
		name        string
		target      world.Pos
		hit, notHit []world.Pos
		tiles       int // of the beam: up to the wall on (5,8), or its whole length
		dirX, dirY  int
	}{
		{"straight", pos(5, 6), []world.Pos{pos(5, 7)}, []world.Pos{pos(5, 9), pos(6, 7), pos(3, 7)}, 2, 0, 1},
		{"diagonal", pos(6, 6), []world.Pos{pos(8, 8)}, []world.Pos{pos(10, 10), pos(8, 7)}, 4, 1, 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := abilityHarness(t, worldtest.Map(t, 0, 0, 7, rows...), []*content.Monster{breath}, spawnAt("breather", 5, 5, 0, 60))
			cls, ps := h.joinAll(append(append([]world.Pos{c.target}, c.hit...), c.notHit...), nil)
			clT, target := cls[0], ps[0]
			hit, notHit := ps[1:1+len(c.hit)], ps[1+len(c.hit):]
			mo := onlyMonster(t, h)
			h.sim.RunUntil(func() bool { return health(target) < 145 }, sim.MaxSeconds(5))
			h.sim.Step()
			evs := clT.take()
			for _, p := range hit {
				if health(p) != 135 {
					t.Errorf("%v on the beam: health %d, want 135", p.Pos(), health(p))
				}
			}
			for _, p := range notHit {
				if health(p) != 145 {
					t.Errorf("%v off the beam: health %d, want 145", p.Pos(), health(p))
				}
			}
			atk := attacksOf(evs, mo.ID())
			if len(atk) != 1 || atk[0].GetTargetId() != 0 || atk[0].GetRadius() != 4 || atk[0].GetTo().GetX() != 5 || atk[0].GetTo().GetY() != 5 {
				t.Fatalf("attacks = %v, want one around the monster of radius 4 (the beam's length)", atk)
			}
			// One effect per tile of the beam, and one per player hit (hitEvents).
			tiles := effectTiles(evs, fireEffect)
			if want := c.tiles + 1 + len(hit); len(tiles) != want {
				t.Errorf("%d fire effects, want %d: %v", len(tiles), want, tiles)
			}
			for i := 1; i <= c.tiles; i++ {
				if p := pos(5+i*c.dirX, 5+i*c.dirY); !slices.Contains(tiles, p) {
					t.Errorf("no fire on %v of the beam: %v", p, tiles)
				}
			}
		})
	}
}

// A circle around the target goes with a projectile at it and hits its neighbours too,
// from range.
func TestMonsterCircleAroundTarget(t *testing.T) {
	spit := parsedMonster(t, `id: spitter
health: 500
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: distance, element: fire, min: 10, max: 10, interval_ms: 2000, range: 4, area: { shape: circle, radius: 1, center: target } }
`)
	h := abilityHarness(t, worldtest.Open(t, 0, 0, 32, 32), []*content.Monster{spit}, spawnAt("spitter", 10, 10, 0, 60))
	// The target is the closest to the spitter; near is next to the target, far two tiles
	// from it.
	cls, ps := h.joinAll([]world.Pos{pos(10, 13), pos(11, 14), pos(8, 15)}, nil)
	clT, target, near, far := cls[0], ps[0], ps[1], ps[2]
	mo := onlyMonster(t, h)
	h.sim.RunUntil(func() bool { return health(target) < 145 }, sim.MaxSeconds(5))
	h.sim.Step()
	evs := clT.take()
	if health(near) != 135 || health(far) != 145 {
		t.Errorf("near %d (want 135), far %d (want 145)", health(near), health(far))
	}
	atk := attacksOf(evs, mo.ID())
	if len(atk) != 1 || atk[0].GetKind() != pb.AttackKind_ATTACK_KIND_RANGED || atk[0].GetRadius() != 1 ||
		atk[0].GetTo().GetX() != 10 || atk[0].GetTo().GetY() != 13 {
		t.Fatalf("attacks = %v, want one RANGED of radius 1 around the target", atk)
	}
	if n := len(find(evs, (*pb.ServerMessage).GetProjectile)); n != 1 {
		t.Errorf("%d projectiles, want the shot at the target", n)
	}
}

// A client that sees the monster but not the centre of the circle it aims at its target
// gets only the side of the attack (as for a target it does not know): the target's tile
// beyond its window is not sent, and no area.
func TestMonsterAreaBeyondTheWindow(t *testing.T) {
	spit := parsedMonster(t, `id: spitter
health: 500
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: spell, element: fire, min: 10, max: 10, interval_ms: 2000, range: 4, area: { shape: circle, radius: 1, center: target } }
`)
	h := abilityHarness(t, worldtest.Open(t, 0, 0, 64, 48), []*content.Monster{spit}, spawnAt("spitter", 30, 20, 0, 60))
	// The onlooker is 8 rows above the spitter (it sees it, the spitter does not notice it)
	// and 12 above the target (beyond its window).
	cls, ps := h.joinAll([]world.Pos{pos(30, 24), pos(30, 12)}, nil)
	target, clO := ps[0], cls[1]
	h.sim.RunUntil(func() bool { return health(target) < 145 }, sim.MaxSeconds(5))
	h.sim.Step()
	mo := onlyMonster(t, h)
	atk := attacksOf(clO.take(), mo.ID())
	if len(atk) != 1 {
		t.Fatalf("the onlooker got %d attacks, want 1", len(atk))
	}
	edge := 12 + session.ViewHalfH
	if a := atk[0]; a.GetRadius() != 0 || a.GetTargetId() != 0 || int(a.GetTo().GetY()) != edge || int(a.GetTo().GetY()) == int(target.Pos().Y) {
		t.Errorf("attack %v: want its side (y %d) without an area", a, edge)
	}
}

// An area follows the invisibility rules: a monster that does not see invisible players
// does not hurt one in its area; one that does aims at an invisible target, and only the
// clients that see the target hear of it (no CreatureAttack, no Effect for the others).
func TestMonsterAreaAndInvisibility(t *testing.T) {
	t.Run("unseen players are not hit", func(t *testing.T) {
		slam := parsedMonster(t, `id: slammer
health: 500
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: spell, element: fire, min: 10, max: 10, interval_ms: 2000, area: { shape: circle, radius: 2 } }
`)
		h := abilityHarness(t, worldtest.Open(t, 0, 0, 32, 32), []*content.Monster{slam}, spawnAt("slammer", 10, 10, 0, 60))
		_, ps := h.joinAll([]world.Pos{pos(10, 11), pos(11, 10)}, func(ps []*session.Player) { h.w.SetInvisibleForTest(ps[1], true) })
		target, ghost := ps[0], ps[1]
		h.sim.RunUntil(func() bool { return health(target) < 145 }, sim.MaxSeconds(5))
		if health(ghost) != 145 {
			t.Errorf("the invisible player took %d damage from a monster that cannot see it", 145-health(ghost))
		}
	})
	t.Run("an area aimed at an invisible target", func(t *testing.T) {
		spit := parsedMonster(t, `id: spitter
health: 500
speed: 100
behavior: {aggressive: true, sees_invisible: true}
attacks:
  - { type: spell, element: fire, min: 10, max: 10, interval_ms: 2000, range: 4, area: { shape: circle, radius: 1, center: target } }
`)
		h := abilityHarness(t, worldtest.Open(t, 0, 0, 64, 32), []*content.Monster{spit}, spawnAt("spitter", 20, 10, 0, 60))
		// The onlooker sees the area but not the ghost, and is beyond the spitter's sight.
		cls, ps := h.joinAll([]world.Pos{pos(20, 13), pos(30, 10)}, func(ps []*session.Player) { h.w.SetInvisibleForTest(ps[0], true) })
		ghost, clO := ps[0], cls[1]
		h.sim.RunUntil(func() bool { return health(ghost) < 145 }, sim.MaxSeconds(5))
		h.sim.Step()
		evs := clO.take()
		if a := find(evs, (*pb.ServerMessage).GetCreatureAttack); len(a) != 0 {
			t.Errorf("the onlooker heard of the attack on an invisible player: %v", a)
		}
		if tiles := effectTiles(evs, fireEffect); len(tiles) != 0 {
			t.Errorf("the onlooker saw fire around an invisible player: %v", tiles)
		}
	})
}

// heal_self heals the monster only below its below_hp_pct and below its full health,
// with the heal's effect and floating text for who sees it.
func TestMonsterHealSelf(t *testing.T) {
	def := parsedMonster(t, `id: mender
health: 100
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: melee, min: 0, max: 0, interval_ms: 2000 }
  - { type: heal_self, min: 20, max: 20, interval_ms: 1000, below_hp_pct: 50 }
`)
	h := abilityHarness(t, worldtest.Open(t, 0, 0, 32, 32), []*content.Monster{def}, spawnAt("mender", 10, 10, 0, 60))
	cl, _ := h.join("Hunter", at(10, 11))
	h.sim.Step()
	mo := onlyMonster(t, h)
	h.sim.Command(gameFunc(func() { mo.SetHealth(60) }))
	h.sim.RunTicks(40)
	if cur, _ := mo.Health(); cur != 60 {
		t.Fatalf("health %d at 60 %%: no heal above 50 %%", cur)
	}
	cl.take()
	h.sim.Command(gameFunc(func() { mo.SetHealth(40) }))
	h.sim.RunTicks(3)
	evs := cl.take()
	if cur, _ := mo.Health(); cur != 60 {
		t.Fatalf("health %d, want 40 + 20", cur)
	}
	heals := 0
	for _, f := range find(evs, (*pb.ServerMessage).GetFloatingText) {
		if f.GetKind() == pb.FloatingTextKind_FLOATING_TEXT_KIND_HEAL && f.GetAmount() == 20 {
			heals++
		}
	}
	if heals != 1 || len(effectTiles(evs, session.EffectHeal)) != 1 {
		t.Errorf("%d heal texts and %d heal effects, want one each", heals, len(effectTiles(evs, session.EffectHeal)))
	}
	h.sim.RunTicks(40) // at 60 % again: no more heals
	if cur, _ := mo.Health(); cur != 60 {
		t.Errorf("health %d: it healed above 50 %%", cur)
	}
}

// summonerDefs is a boss that calls two imps (three at most) below 60 % and the imp.
func summonerDefs(t *testing.T) []*content.Monster {
	boss := parsedMonster(t, `id: caller
health: 1000
experience: 500
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: melee, min: 0, max: 0, interval_ms: 2000 }
  - { type: summon, interval_ms: 1000, below_hp_pct: 60, summon: { monster: imp, count: 2, max_alive: 3 } }
loot:
  - { item: copper_coin, chance: 1, count: [5, 5] }
`)
	imp := parsedMonster(t, `id: imp
health: 30
experience: 40
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: melee, min: 0, max: 0, interval_ms: 2000 }
loot:
  - { item: copper_coin, chance: 1, count: [9, 9] }
`)
	return []*content.Monster{boss, imp}
}

// monstersOf returns the monsters of kind in the world.
func monstersOf(h *harness, kind string) []*session.Monster {
	var out []*session.Monster
	for _, m := range h.w.Monsters() {
		if m.Kind() == kind {
			out = append(out, m)
		}
	}
	return out
}

// A summoner calls nothing at full health; below its below_hp_pct it calls its count
// next to itself and never more than max_alive alive at once. A summon fights the
// caller's target, gives no experience and no loot and never respawns; the rest go when
// the caller dies (DESPAWN), and the caller's kill pays as before.
func TestMonsterSummons(t *testing.T) {
	h := abilityHarness(t, worldtest.Open(t, 0, 0, 32, 32), summonerDefs(t), spawnAt("caller", 10, 10, 0, 60))
	cl, p := h.join("Hunter", at(10, 12))
	h.sim.RunTicks(60)
	boss := onlyMonster(t, h)
	if n := len(monstersOf(h, "imp")); n != 0 || boss.TargetID() != p.ID() {
		t.Fatalf("%d imps at full health, boss targets %d", n, boss.TargetID())
	}
	cl.take()
	h.sim.Command(gameFunc(func() { boss.SetHealth(500) }))
	h.sim.Step()
	imps := monstersOf(h, "imp")
	if len(imps) != 2 {
		t.Fatalf("%d imps below 60 %%, want 2", len(imps))
	}
	for _, imp := range imps {
		if imp.Master() != boss || imp.TargetID() != p.ID() {
			t.Errorf("imp %d: master %v, target %d", imp.ID(), imp.Master(), imp.TargetID())
		}
	}
	evs := cl.take()
	for _, a := range find(evs, (*pb.ServerMessage).GetCreatureAppear) {
		if c := a.GetCreature(); c.GetContentId() == "imp" && chebyshev(pos(int(c.GetPos().GetX()), int(c.GetPos().GetY())), boss.Pos()) != 1 {
			t.Errorf("an imp appeared on %v, the caller stands on %v", c.GetPos(), boss.Pos())
		}
	}
	if n := len(effectTiles(evs, session.EffectConjure)); n != 2 {
		t.Errorf("%d conjure effects, want one per imp", n)
	}
	h.sim.RunTicks(100) // five more rounds: one more imp, then max_alive holds
	if n := len(monstersOf(h, "imp")); n != 3 {
		t.Fatalf("%d imps, want max_alive 3", n)
	}

	// Killing a summon pays nothing and leaves no remains; the round that waited for room
	// calls another at once.
	imp := monstersOf(h, "imp")[0]
	var died world.Pos
	h.sim.Command(gameCtx(func(ctx *game.TickContext) {
		died = imp.Pos()
		h.w.DamageMonsterForTest(ctx, imp, p, 30)
	}))
	h.sim.Step()
	imps = monstersOf(h, "imp")
	if p.Experience() != 0 || len(h.w.CorpsesAt(died)) != 0 || slices.Contains(imps, imp) {
		t.Errorf("a dead imp gave %d experience and %d remains (still in the world: %v)", p.Experience(), len(h.w.CorpsesAt(died)), slices.Contains(imps, imp))
	}
	if len(imps) != 3 {
		t.Errorf("%d imps right after one died, want 3", len(imps))
	}

	// The caller dies: its imps go with it, and its kill pays its experience and loot.
	cl.take()
	ids := []uint32{}
	for _, imp := range monstersOf(h, "imp") {
		ids = append(ids, imp.ID())
	}
	h.sim.Command(killCmd(h, boss, p))
	h.sim.Step()
	if n := len(h.w.Monsters()); n != 0 {
		t.Fatalf("%d monsters left after the caller died", n)
	}
	gone := map[uint32]pb.DisappearReason{}
	for _, d := range find(cl.take(), (*pb.ServerMessage).GetCreatureDisappear) {
		gone[d.GetId()] = d.GetReason()
	}
	for _, id := range ids {
		if gone[id] != pb.DisappearReason_DISAPPEAR_REASON_DESPAWN {
			t.Errorf("imp %d left as %v, want DESPAWN", id, gone[id])
		}
	}
	if p.Experience() != 500 || len(h.w.CorpsesAt(boss.Pos())) != 1 {
		t.Errorf("the caller gave %d experience (want 500), %d remains", p.Experience(), len(h.w.CorpsesAt(boss.Pos())))
	}
	// Away from the spawn (a respawn waits while someone watches), the caller comes back
	// once; a dead imp never does (it would come back as another caller: the spawn's).
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(30, 30)) }))
	h.sim.RunTicks(20 * 70)
	if len(monstersOf(h, "caller")) != 1 || len(monstersOf(h, "imp")) != 0 {
		t.Errorf("after the respawn: %d callers, %d imps", len(monstersOf(h, "caller")), len(monstersOf(h, "imp")))
	}
}

// killCmd is a command that has p kill m (all its health in one hit).
func killCmd(h *harness, m *session.Monster, p *session.Player) game.Command {
	return gameCtx(func(ctx *game.TickContext) {
		cur, _ := m.Health()
		h.w.DamageMonsterForTest(ctx, m, p, cur)
	})
}

// gameCtx wraps a test closure that needs the tick's context as a command.
type gameCtx func(*game.TickContext)

func (f gameCtx) Execute(ctx *game.TickContext) { f(ctx) }

// A caller that gives up takes its summons away with it: the next fight starts afresh.
// Its target steps out of its leash area (3 tiles around 10,10) and of its reach, still
// in its sight: the leash drops it (beyondLeash, dropTarget) and, with nobody else to
// fight, the caller gives up (giveUp: full health, its imps DESPAWN).
func TestMonsterSummonsGoWhenItGivesUp(t *testing.T) {
	h := leashHarness(t, 3, summonerDefs(t), spawnAt("caller", 10, 10, 0, 60))
	cl, p := h.join("Hunter", at(10, 12))
	h.sim.RunTicks(10)
	boss := onlyMonster(t, h)
	h.sim.Command(gameFunc(func() { boss.SetHealth(500) }))
	h.sim.RunTicks(2)
	imps := monstersOf(h, "imp")
	if len(imps) != 2 || boss.TargetID() != p.ID() {
		t.Fatalf("%d imps, the caller targets %d (want 2 and the hunter)", len(imps), boss.TargetID())
	}
	cl.take()
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(10, 15)) }))
	h.sim.Step()
	if hp, maxHP := boss.Health(); boss.TargetID() != 0 || hp != maxHP {
		t.Fatalf("the caller targets %d at %d/%d health: want given up (no target, full health)", boss.TargetID(), hp, maxHP)
	}
	if n := len(monstersOf(h, "imp")); n != 0 {
		t.Errorf("%d imps after the caller gave up", n)
	}
	gone := map[uint32]pb.DisappearReason{}
	for _, d := range find(cl.take(), (*pb.ServerMessage).GetCreatureDisappear) {
		gone[d.GetId()] = d.GetReason()
	}
	for _, imp := range imps {
		if gone[imp.ID()] != pb.DisappearReason_DISAPPEAR_REASON_DESPAWN {
			t.Errorf("imp %d left as %v, want DESPAWN", imp.ID(), gone[imp.ID()])
		}
	}
}

// A boss's phase is on while its health is below below_hp_pct: its speed (speed_mult,
// told to who sees it), its attack intervals (attack_interval_mult) and its attacks_add
// follow; healed above it, it is back as it was.
func TestMonsterPhases(t *testing.T) {
	def := parsedMonster(t, `id: brute
health: 1000
speed: 100
behavior: {aggressive: true}
attacks:
  - { type: melee, min: 1, max: 1, interval_ms: 2000 }
phases:
  - { below_hp_pct: 30, speed_mult: 2, attack_interval_mult: 0.5,
      attacks_add: [ { type: spell, element: fire, min: 7, max: 7, interval_ms: 1000, range: 3 } ] }
`)
	h := abilityHarness(t, worldtest.Open(t, 0, 0, 32, 32), []*content.Monster{def}, spawnAt("brute", 10, 10, 0, 60))
	cl, p := h.join("Hunter", at(10, 11))
	h.sim.RunTicks(5)
	mo := onlyMonster(t, h)
	// hits counts the melee (1) and fire (7) hits on p over n ticks.
	hits := func(n int) (melee, fire int) {
		cl.take()
		h.sim.RunTicks(n)
		for _, f := range find(cl.take(), (*pb.ServerMessage).GetFloatingText) {
			if f.GetKind() != pb.FloatingTextKind_FLOATING_TEXT_KIND_DAMAGE || f.GetPos().GetX() != uint32(p.Pos().X) || f.GetPos().GetY() != uint32(p.Pos().Y) {
				continue
			}
			switch f.GetAmount() {
			case 1:
				melee++
			case 7:
				fire++
			}
		}
		h.w.RestoreForTest(p)
		return melee, fire
	}
	if melee, fire := hits(80); melee != 2 || fire != 0 || mo.Phase() != 0 || mo.Speed() != 100 {
		t.Fatalf("full health: %d melee, %d fire hits in 4 s, phase %d, speed %d", melee, fire, mo.Phase(), mo.Speed())
	}
	h.sim.Command(gameFunc(func() { mo.SetHealth(250) }))
	h.sim.Step()
	if mo.Phase() != 1 || mo.Speed() != 200 {
		t.Fatalf("below 30 %%: phase %d, speed %d", mo.Phase(), mo.Speed())
	}
	speeds := find(cl.take(), (*pb.ServerMessage).GetCreatureSpeed)
	if len(speeds) != 1 || speeds[0].GetSpeed() != 200 {
		t.Errorf("speed updates %v, want one to 200", speeds)
	}
	hits(40) // the rounds set before the phase run out
	if melee, fire := hits(80); melee != 4 || fire != 8 {
		t.Errorf("enraged: %d melee (want 4: 2 s × 0.5), %d fire (want 8: 1 s × 0.5) in 4 s", melee, fire)
	}
	h.sim.Command(gameFunc(func() { mo.SetHealth(1000) }))
	h.sim.Step()
	if mo.Phase() != 0 || mo.Speed() != 100 {
		t.Errorf("healed: phase %d, speed %d", mo.Phase(), mo.Speed())
	}
}

// The server refuses a summon of a monster it does not know, or of one that summons too
// (a chain without a bound).
func TestStartupRefusesBadSummons(t *testing.T) {
	for _, c := range []struct {
		name  string
		spoil func([]*content.Monster)
		want  string
	}{
		{"unknown", func(ms []*content.Monster) { ms[0].Attacks[1].Summon.Monster = "ghost" }, `summons unknown monster "ghost"`},
		{"a summoner", func(ms []*content.Monster) {
			ms[1].Attacks = append(ms[1].Attacks, content.MonsterAttack{Type: content.AttackSummon, IntervalMs: 1000, Chance: 1,
				Summon: &content.MonsterSummon{Monster: "imp", Count: 1, MaxAlive: 1}})
		}, `summons "imp", which summons too`},
	} {
		t.Run(c.name, func(t *testing.T) {
			defs := summonerDefs(t)
			c.spoil(defs)
			m := worldtest.Open(t, 0, 0, 32, 32)
			_, err := session.New(session.Config{Map: m, Balance: testBalance(), Vocations: testVocations, Items: testItems(),
				Monsters: content.Monsters{"caller": defs[0], "imp": defs[1]}, Save: func(session.Snapshot) bool { return true }})
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("session.New = %v, want an error with %q", err, c.want)
			}
		})
	}
}
