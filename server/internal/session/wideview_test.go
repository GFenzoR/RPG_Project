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
