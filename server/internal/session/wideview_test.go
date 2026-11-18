package session_test

import (
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// The wide view (31x21, docs/00 and docs/02 "La vista"): what a player sees 15 tiles
// away, and may target and look at there. A monster's sight stays the classic window.

func wideHarness(t *testing.T, wolf *content.Monster, spawns ...world.Spawn) *harness {
	t.Helper()
	m := worldtest.Open(t, 0, 0, 96, 64)
	m.Islands()[0].Spawns = spawns
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolf}
		c.Items = testItems()
	})
}

func TestWideViewFifteenTilesAway(t *testing.T) {
	wolf := wolfDef()
	wolf.Behavior.Aggressive = false
	h := wideHarness(t, wolf, spawnAt("wolf", 55, 30, 0, 600)) // 15 tiles east of Ana
	acl, ana := h.join("Ana", at(40, 30))
	bcl, bob := h.join("Bob", at(55, 20)) // 15 east and 10 north
	h.sim.Step()
	w := onlyMonster(t, h)
	if !ana.Knows(bob.ID()) || !bob.Knows(ana.ID()) || !ana.Knows(w.ID()) {
		t.Fatalf("15 tiles away: Ana knows Bob %v, the wolf %v; Bob knows Ana %v",
			ana.Knows(bob.ID()), ana.Knows(w.ID()), bob.Knows(ana.ID()))
	}
	acl.take()

	// Bob walks east: 16 tiles away is the margin, still known; at 17 he leaves the view.
	h.input(bcl, walk(E))
	h.sim.RunTicks(20)
	if got := kinds(acl.take()); len(got) != 1 || got[0] != "creature_move" {
		t.Fatalf("Bob at 16 tiles: Ana got %v", got)
	}
	h.input(bcl, walk(E))
	h.sim.RunTicks(20)
	if got := kinds(acl.take()); len(got) != 1 || got[0] != "creature_disappear" || ana.Knows(bob.ID()) {
		t.Fatalf("Bob at 17 tiles: Ana got %v", got)
	}
	h.input(bcl, walkPath(W, W))
	h.sim.RunTicks(40)
	if got := kinds(acl.take()); len(got) != 2 || got[0] != "creature_appear" || got[1] != "creature_move" {
		t.Fatalf("Bob back at 15 tiles: Ana got %v", got)
	}

	// Ana targets the wolf 15 tiles away and keeps it (no chase: she stays put).
	h.input(acl, fightMode(pb.FightStance_FIGHT_STANCE_BALANCED, false))
	h.input(acl, setTarget(w.ID()))
	h.sim.RunFor(3 * time.Second)
	if ana.Target() != w.ID() || ana.Pos() != pos(40, 30) {
		t.Fatalf("Ana's target %d at %v, want the wolf %d", ana.Target(), ana.Pos(), w.ID())
	}

	// A shot and a hit 15 tiles away arrive with their real tiles.
	acl.take()
	h.sim.Command(gameFunc(func() { h.w.ProjectileForTest(pos(55, 20), pos(55, 30)) }))
	h.do(func(ctx *game.TickContext) { h.w.HurtForTest(ctx, bob, 5) })
	evs := acl.take()
	shots := find(evs, (*pb.ServerMessage).GetProjectile)
	if len(shots) != 1 || shots[0].GetFrom().GetY() != 20 || shots[0].GetTo().GetY() != 30 || shots[0].GetTo().GetX() != 55 {
		t.Fatalf("shot %v", shots)
	}
	if hp := find(evs, (*pb.ServerMessage).GetCreatureHealth); len(hp) != 1 || hp[0].GetId() != bob.ID() {
		t.Fatalf("Bob's health bar: %v", kinds(evs))
	}

	// Looking at a tile: 15 tiles away it answers, 17 tiles away it is too far.
	h.input(acl, lookAt(onTile(pos(55, 31)), grassID, 0))
	h.sim.Step()
	if evs := acl.take(); hasKey(evs, "inventory.too_far") || len(evs) == 0 {
		t.Fatalf("look 15 tiles away: %v", systemKeys(evs))
	}
	h.input(acl, lookAt(onTile(pos(57, 31)), grassID, 0))
	h.sim.Step()
	if evs := acl.take(); !hasKey(evs, "inventory.too_far") {
		t.Fatalf("look 17 tiles away: %v", systemKeys(evs))
	}
}

// A monster notices a player and keeps chasing it only within its sight, the classic
// 15x11 window (InSight): the player sees it from 15 tiles away, untroubled.
func TestMonsterSightStaysClassic(t *testing.T) {
	h := wideHarness(t, wolfDef(), spawnAt("wolf", 40, 30, 0, 600))
	_, ana := h.join("Ana", at(55, 30))
	h.sim.RunFor(3 * time.Second)
	w := onlyMonster(t, h)
	if !ana.Knows(w.ID()) || w.TargetID() != 0 {
		t.Fatalf("15 tiles away: Ana knows the wolf %v, its target %d", ana.Knows(w.ID()), w.TargetID())
	}
	h.do(func(*game.TickContext) { h.w.Teleport(ana, pos(47, 30)) }) // 7 tiles: in its sight
	h.sim.RunFor(time.Second)
	if w.TargetID() != ana.ID() {
		t.Fatalf("7 tiles away: the wolf's target %d", w.TargetID())
	}
	away := world.Pos{X: w.Pos().X + 12, Y: w.Pos().Y, Z: 7}
	h.do(func(*game.TickContext) { h.w.Teleport(ana, away) }) // out of its sight, in Ana's view
	h.sim.RunTicks(2)
	if w.TargetID() != 0 || !ana.Knows(w.ID()) {
		t.Fatalf("12 tiles away: the wolf's target %d, Ana knows it %v", w.TargetID(), ana.Knows(w.ID()))
	}
}

// A respawn waits only while a player stands within the classic window of the spawn tile
// (InSight's rectangle, on the floors seen together), not the wide view: a player hunting
// one spawn does not hold back its neighbours 12-20 tiles away, so the world's capacity
// (docs/07) stays as measured with 15x11 (docs/02 "Respawns").
func TestRespawnWaitsOnlyForTheClassicWindow(t *testing.T) {
	for _, c := range []struct {
		name   string
		dx, dy int
		waits  bool
	}{
		{"east edge of the classic window", session.SightHalfW, 0, true},
		{"south edge of the classic window", 0, session.SightHalfH, true},
		{"one beyond, east", session.SightHalfW + 1, 0, false},
		{"one beyond, south", 0, session.SightHalfH + 1, false},
		{"12 tiles east, in the wide view", 12, 0, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			wolf := wolfDef()
			wolf.Behavior.Aggressive = false
			h := wideHarness(t, wolf, spawnAt("wolf", 40, 30, 0, 5))
			_, ana := h.join("Ana", at(40+c.dx, 30+c.dy))
			h.sim.Step()
			w := onlyMonster(t, h)
			if !ana.Knows(w.ID()) {
				t.Fatalf("Ana at %v does not see the spawn tile", ana.Pos())
			}
			h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, w, ana, 1000) })
			h.sim.RunFor(20 * time.Second) // well past respawn_seconds
			if n := len(h.w.Monsters()); (n == 0) != c.waits {
				t.Fatalf("Ana at %v: %d monsters 20 s after the kill, want the respawn to wait %v", ana.Pos(), n, c.waits)
			}
		})
	}
}

// Every aimed range of the content stops at content.MaxRange (weapon.range, a spell's or
// a condition's range), the classic window's half-height: a monster hit from as far as a
// player may aim, straight up the window's short axis or across its corner, notices who
// hit it and fights back. One tile farther north it would not (InSight): the wide view
// lets a player target a monster 15 tiles away, the cap keeps it from free kills.
func TestMaxRangeIsTheClassicWindow(t *testing.T) {
	if content.MaxRange != min(session.SightHalfW, session.SightHalfH) {
		t.Fatalf("content.MaxRange = %d, the classic window is ±%d x ±%d", content.MaxRange, session.SightHalfW, session.SightHalfH)
	}
	r := content.MaxRange
	for _, c := range []struct {
		name      string
		dx, dy    int
		fightBack bool
	}{
		{"north", 0, -r, true},
		{"corner", r, r, true},
		{"one beyond, north", 0, -r - 1, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := worldtest.Open(t, 0, 0, 32, 32)
			m.Islands()[0].Spawns = []world.Spawn{spawnAt("dummy", 15+c.dx, 15+c.dy, 0, 60)}
			h := newHarness(t, m, func(cfg *session.Config) {
				cfg.Monsters = content.Monsters{"dummy": targetDummyDef()}
				cfg.Items = testItems()
				cfg.Spells = rangerSpells()
				// Built here, past the content check: the last case aims one tile beyond it.
				cfg.Spells["test_shot"].Effect.Damage.Range = max(abs(c.dx), abs(c.dy))
				cfg.Balance.Skills.Base["distance"] = content.SkillBase{StartLevel: 10, BaseTries: 1000}
			})
			cl, p := ranger(t, h, pos(15, 15), 0)
			d := h.dummy()
			h.castNow(cl, castAt("test_shot", d.ID()))
			if h.w.MonsterHealth(d) >= 1000 {
				t.Fatalf("the shot at %v missed the dummy at %v", p.Pos(), d.Pos())
			}
			h.sim.RunTicks(2)
			if got := d.TargetID() == p.ID(); got != c.fightBack {
				t.Fatalf("shot from %v at %v: the dummy fights back %v, want %v", p.Pos(), d.Pos(), got, c.fightBack)
			}
		})
	}
}

// PvP vision is the view: a player targets another 15 tiles away, and loses it beyond.
func TestPvPTargetFifteenTilesAway(t *testing.T) {
	g := newPvP(t, nil)
	acl, a := g.fighter("Ash", 0, 12, 30, 30, session.RolePlayer)
	vcl, v := g.fighter("Vale", 0, 27, 30, 30, session.RolePlayer)
	g.unsafe(acl)
	g.input(acl, fightMode(pb.FightStance_FIGHT_STANCE_BALANCED, false))
	g.input(acl, setTarget(v.ID()))
	g.sim.RunFor(time.Second)
	if a.Target() != v.ID() {
		t.Fatalf("15 tiles away: Ash's target %d, want Vale %d (%v)", a.Target(), v.ID(), systemKeys(acl.take()))
	}
	g.input(vcl, walkPath(E, E))
	g.sim.RunFor(3 * time.Second)
	if v.Pos() != pos(29, 30) || a.Target() != 0 {
		t.Fatalf("Vale at %v (17 tiles): Ash's target %d", v.Pos(), a.Target())
	}
}

// sharedMsg checks that every client got exactly one message about creature id that about
// picks out (it returns the creature's id, or 0 for another kind), and the same one: built
// once for every observer, as the wide view sends each to many more clients.
func sharedMsg(t *testing.T, what string, id uint32, about func(*pb.ServerMessage) uint32, cls ...*fakeClient) {
	t.Helper()
	var first *pb.ServerMessage
	for i, cl := range cls {
		var got []*pb.ServerMessage
		for _, e := range cl.take() {
			if about(e) == id {
				got = append(got, e)
			}
		}
		switch {
		case len(got) != 1:
			t.Fatalf("%s: client %d got %d messages, want 1", what, i, len(got))
		case i == 0:
			first = got[0]
		case got[0] != first:
			t.Errorf("%s: client %d got its own copy, not the shared message", what, i)
		}
	}
}

// Every observer of a creature appearing, turning, healed by giving up or leaving gets the
// same message, built once, like a step or a hit (observeMove, hitEvents).
func TestObserversShareOneMessage(t *testing.T) {
	appearOf := func(m *pb.ServerMessage) uint32 { return m.GetCreatureAppear().GetCreature().GetId() }
	turnOf := func(m *pb.ServerMessage) uint32 { return m.GetCreatureTurn().GetId() }
	healthOf := func(m *pb.ServerMessage) uint32 { return m.GetCreatureHealth().GetId() }
	goneOf := func(m *pb.ServerMessage) uint32 { return m.GetCreatureDisappear().GetId() }

	wolf := wolfDef()
	wolf.Behavior.Aggressive = false
	h := monsterHarness(t, []*content.Monster{wolf}, spawnAt("wolf", 30, 30, 0, 600))
	// Ana and Bob join in the first tick, the one the spawns fill in: both see the wolf
	// appear.
	acl, bcl := &fakeClient{}, &fakeClient{}
	for _, j := range []struct {
		name string
		cl   *fakeClient
		at   world.Pos
	}{{"Ana", acl, pos(36, 30)}, {"Bob", bcl, pos(30, 36)}} {
		nextChar++
		h.sim.Command(h.w.Join(session.Character{ID: nextChar, AccountID: nextChar, Name: j.name, Vocation: "guardian",
			Level: 1, Health: 145, Mana: 20, HasPos: true, Pos: j.at}, j.cl))
	}
	h.sim.Step()
	w := onlyMonster(t, h)
	ana := h.w.PlayerByCharacter(nextChar - 1)
	sharedMsg(t, "the wolf spawns", w.ID(), appearOf, acl, bcl)

	ccl, carl := h.join("Carl", at(33, 33))
	sharedMsg(t, "Carl joins", carl.ID(), appearOf, acl, bcl)
	ccl.take()

	h.input(ccl, &pb.ClientMessage{Message: &pb.ClientMessage_Turn{Turn: &pb.Turn{Dir: W}}})
	h.sim.Step()
	sharedMsg(t, "Carl turns", carl.ID(), turnOf, ccl, acl, bcl)

	h.do(func(*game.TickContext) { h.w.FaceForTest(w, pos(30, 20)) })
	sharedMsg(t, "the wolf faces north", w.ID(), turnOf, ccl, acl, bcl)

	h.do(func(ctx *game.TickContext) {
		w.SetHealth(10)
		h.w.GiveUpForTest(ctx, w)
	})
	sharedMsg(t, "the wolf gives up, healed", w.ID(), healthOf, ccl, acl, bcl)

	h.sim.Command(h.w.Leave(ccl))
	h.sim.Step()
	sharedMsg(t, "Carl leaves", carl.ID(), goneOf, acl, bcl)

	h.do(func(ctx *game.TickContext) { h.w.DamageMonsterForTest(ctx, w, ana, 1000) })
	sharedMsg(t, "the wolf dies", w.ID(), goneOf, acl, bcl)
}
