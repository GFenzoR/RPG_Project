package session_test

import (
	"slices"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// Conditions between players (T5.2): a condition of another player keeps its author
// across relogs of either side (saved by character, with what its holder remembers of
// that author's attack); ranged condition spells are in pvp_condition_spell_test.go.
// Test numbers: pvp.damage_pct 50, so a poison hit of 20 hurts 10; every damage
// condition hits once a second; the PvP lock is 10 s and the aggressor time 60 s.

// pvpCondSpells are the condition spells plus venom, a ranged poison (the test vocation
// is guardian; every spell costs 1 mana and has no cooldown).
func pvpCondSpells() content.Spells {
	ss := condSpells()
	ss["venom"] = &content.Spell{ID: "venom", Words: "test venom", Vocations: []string{"guardian"}, Level: 1, Mana: 1,
		Group: "attack", Effect: content.SpellEffect{Condition: &content.ConditionApply{ID: "poison", Range: 4, Ticks: 4, Damage: 20}}}
	return ss
}

// withPvPCond gives a PvP world the condition spells and a poison long enough to outlast
// a PvP lock (40 hits).
func withPvPCond(c *session.Config) {
	cs := testConditions()
	cs["poison"].MaxTicks = 40
	c.Balance.Conditions = cs
	c.Spells = pvpCondSpells()
}

// newPvPCond is newPvP withPvPCond.
func newPvPCond(t *testing.T, data *session.GuildData, opts ...option) *pvpWorld {
	t.Helper()
	return newPvP(t, data, append([]option{withPvPCond}, opts...)...)
}

// poison puts a poison of a on v (20 per hit, hits hits).
func (g *pvpWorld) poison(a, v *session.Player, hits int) {
	g.t.Helper()
	g.do(func(ctx *game.TickContext) {
		if !g.w.ApplyConditionForTest(ctx, v, nil, &content.ConditionApply{ID: "poison", Damage: 20, Ticks: hits}, a.ID()) {
			g.t.Fatal("no poison")
		}
	})
}

// damageTexts are the damage numbers in evs.
func damageTexts(evs []*pb.ServerMessage) []uint64 {
	var out []uint64
	for _, f := range find(evs, (*pb.ServerMessage).GetFloatingText) {
		if f.GetKind() == pb.FloatingTextKind_FLOATING_TEXT_KIND_DAMAGE {
			out = append(out, f.GetAmount())
		}
	}
	return out
}

// allTen reports whether every hit in hits is a scaled poison hit (20 × 50 %) and there is
// at least one.
func allTen(hits []uint64) bool {
	return len(hits) > 0 && !slices.ContainsFunc(hits, func(n uint64) bool { return n != 10 })
}

// leave logs cl's character out (it must not be locked), acknowledges its final save, as
// the persistence goroutine would, and returns that snapshot: the next login reads the
// database.
func (g *pvpWorld) leave(cl *fakeClient, p *session.Player) session.Snapshot {
	g.t.Helper()
	g.input(cl, logout())
	g.sim.Step()
	if !cl.closed {
		g.t.Fatalf("%d could not log out: %v", p.CharacterID(), sysKeys(cl.take()))
	}
	s := g.saves[len(g.saves)-1]
	if s.CharacterID != p.CharacterID() || !s.Final {
		g.t.Fatalf("last save %+v", s)
	}
	g.sim.Command(g.w.Saved(s.CharacterID, s.Seq))
	g.sim.Step()
	return s
}

// unjustPoison is the start of the relog scenarios: Ana (safe mode off) hits Bea by hand,
// an unjustified attack, and poisons her for 30 hits; Bea then waits in a protection zone
// (where the poison does not hurt) until both locks are over, and logs out. It returns
// Ana, her client, Bea's character id and Bea's final snapshot.
func (g *pvpWorld) unjustPoison() (*fakeClient, *session.Player, int64, session.Snapshot) {
	g.t.Helper()
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.poison(a, b, 30)
	g.do(func(*game.TickContext) { g.w.Teleport(b, pos(5, 45)) })
	g.sim.RunFor(11 * time.Second)
	return ca, a, b.CharacterID(), g.leave(cb, b)
}

// rejoin logs Bea's character in again at (11, 10) with the conditions of s, as the
// database would give them back.
func (g *pvpWorld) rejoin(id int64, s session.Snapshot, health int) (*fakeClient, *session.Player) {
	g.t.Helper()
	return g.fighter("Bea", id, 11, 10, 30, 0, func(c *session.Character) {
		c.Health, c.Conditions = health, s.Conditions
	})
}

// The bug of T5.2: a poison of another player lost its author when its victim logged out
// and in, and hurt as one of the world (full damage, nobody credited). Now the saved
// condition names its author and what the victim remembered of the attack, so after the
// relog the poison still continues Ana's own attack: scaled, renewing her skull and lock,
// and a death by it is her unjustified kill.
func TestPvPConditionSurvivesVictimRelog(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a, bea, s := g.unjustPoison()
	if len(s.Conditions) != 1 {
		t.Fatalf("saved conditions %+v", s.Conditions)
	}
	if c := s.Conditions[0]; c.ID != "poison" || c.Author != a.CharacterID() || !c.AuthorUnjust ||
		c.AuthorHit.IsZero() || c.AuthorHit.After(g.sim.Now()) {
		t.Fatalf("saved poison %+v", c)
	}

	cb, b := g.rejoin(bea, s, 1000)
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb.take()); !allTen(hits) {
		t.Fatalf("hits after the relog %v, want Ana's scaled hits (10)", hits)
	}
	if a.Skull() != pb.Skull_SKULL_AGGRESSOR {
		t.Fatalf("Ana's skull %v", a.Skull())
	}
	ca.take()
	g.input(ca, logout())
	g.sim.Step()
	if keys := sysKeys(ca.take()); ca.closed || !slices.Contains(keys, "pvp.logout_locked") {
		t.Fatalf("the poison did not lock Ana: %v", keys)
	}

	// A death by the poison is Ana's.
	g.do(func(*game.TickContext) { b.SetHealthForTest(5) })
	g.sim.RunFor(time.Second)
	if st := g.w.PvPStateForTest(a); st.Kills != 1 || len(st.Unjust) != 1 {
		t.Fatalf("Ana %+v", st)
	}
	if keys := sysKeys(cb.take()); !slices.Contains(keys, "pvp.killed_by") {
		t.Fatalf("Bea's messages %v", keys)
	}
}

// A relog does not stretch an attack either: back after the aggressor time, the poison
// resumes but its unjustified attack is over, so it hurts nobody and marks nobody.
func TestPvPConditionRelogAfterAggressorTime(t *testing.T) {
	g := newPvPCond(t, nil)
	_, a, bea, s := g.unjustPoison()
	g.sim.RunFor(61 * time.Second)
	cb, _ := g.rejoin(bea, s, 1000)
	g.sim.RunFor(3 * time.Second)
	if hits := damageTexts(cb.take()); len(hits) != 0 || a.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("hits %v, Ana %v", hits, a.Skull())
	}
}

// The author's relog (a new creature id): the poison follows the character, so it is the
// new Ana's attack and her kill.
func TestPvPConditionAuthorRelogs(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.poison(a, b, 30)
	g.sim.Command(g.w.Leave(ca)) // locked: link-dead until the new login takes her over
	g.sim.Step()
	ca2, a2 := g.fighter("Ana", a.CharacterID(), 10, 10, 30, 0)
	if a2.ID() == a.ID() {
		t.Fatal("same creature id")
	}
	g.unsafe(ca2)
	cb.take()
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb.take()); !allTen(hits) {
		t.Fatalf("hits after Ana's relog %v", hits)
	}
	g.do(func(*game.TickContext) { b.SetHealthForTest(5) })
	g.sim.RunFor(time.Second)
	if st := g.w.PvPStateForTest(a2); st.Kills != 1 || len(st.Unjust) != 1 {
		t.Fatalf("new Ana %+v", st)
	}
}

// An author who closes her connection while her poison hurts is an attacker gone offline:
// every hit renews her lock, so she stays link-dead in the world for as long as it hurts,
// and a death by it is her kill (as for any attacker that lost its connection). She
// leaves only when the lock of the last hit is over.
func TestPvPConditionAuthorLinkDeadKills(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.poison(a, b, 30)
	g.sim.Command(g.w.Leave(ca))
	g.sim.Step()
	cb.take()
	g.sim.RunFor(15 * time.Second) // past the lock of the hit by hand: the poison renews it
	if hits := damageTexts(cb.take()); !allTen(hits) || !a.LinkDead() || g.w.PlayerByCharacter(a.CharacterID()) != a {
		t.Fatalf("hits %v, Ana link-dead %v", hits, a.LinkDead())
	}
	g.do(func(*game.TickContext) { b.SetHealthForTest(5) })
	g.sim.RunFor(time.Second)
	if st := g.w.PvPStateForTest(a); st.Kills != 1 || len(st.Unjust) != 1 {
		t.Fatalf("link-dead Ana %+v", st)
	}
	if keys := sysKeys(cb.take()); !slices.Contains(keys, "pvp.killed_by") {
		t.Fatalf("Bea's messages %v", keys)
	}
	// The unjustified kill locks her for kill_lock_ms (30 s); then she is saved and out.
	g.sim.RunFor(32 * time.Second)
	if g.w.PlayerByCharacter(a.CharacterID()) != nil {
		t.Fatal("Ana still in the world after her lock")
	}
}

// An author who left the world cannot attack: her poison hurts nobody (its hits pass, as
// in a protection zone) and so there is no death without a player to credit. Back in
// the world, with her safe mode off, it continues her attack again.
func TestPvPConditionAuthorOffline(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.poison(a, b, 30)
	g.do(func(*game.TickContext) { g.w.Teleport(b, pos(5, 45)) })
	g.sim.RunFor(11 * time.Second)
	g.leave(ca, a)
	g.do(func(*game.TickContext) { g.w.Teleport(b, pos(11, 10)) })
	cb.take()
	g.sim.RunFor(3 * time.Second)
	if hits := damageTexts(cb.take()); len(hits) != 0 {
		t.Fatalf("hits while Ana is offline %v", hits)
	}
	if left := g.w.ConditionsForTest(b)["poison"]; left <= 0 || left >= 30 {
		t.Fatalf("poison hits left %d", left)
	}
	ca2, a2 := g.fighter("Ana", a.CharacterID(), 30, 30, 30, 0)
	g.sim.RunFor(2 * time.Second) // safe mode on after a login: no unjustified attack
	if hits := damageTexts(cb.take()); len(hits) != 0 {
		t.Fatalf("hits with Ana in safe mode %v", hits)
	}
	g.unsafe(ca2)
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb.take()); !allTen(hits) || a2.Skull() != pb.Skull_SKULL_AGGRESSOR {
		t.Fatalf("hits after Ana came back %v, skull %v", hits, a2.Skull())
	}
}

// With PvP off nobody hurts another player: a condition of a player saved before (or
// under PvP on) only runs out.
func TestPvPConditionSavedWithPvPOff(t *testing.T) {
	g := newPvPCond(t, nil, func(c *session.Config) { c.Balance.PvP.Enabled = false })
	_, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0, func(c *session.Character) {
		c.Conditions = []session.ConditionState{{ID: "poison", LeftMs: 500, Ticks: 5, Damage: 20, Author: a.CharacterID()}}
	})
	g.sim.RunFor(3 * time.Second)
	if hits := damageTexts(cb.take()); len(hits) != 0 {
		t.Fatalf("hits %v", hits)
	}
	if left := g.w.ConditionsForTest(b)["poison"]; left != 2 {
		t.Fatalf("poison hits left %d, want 2", left)
	}
}

// What a condition saves of its author: an arena duel gives no memory to carry (it gives
// no self-defense or attack outside the arena), and a hit from before this server's first
// tick (a restart since) cannot be placed and is forgotten.
func TestPvPConditionSavedMemory(t *testing.T) {
	g := newPvPCond(t, nil)
	_, a := g.fighter("Ana", 0, 45, 45, 30, 0)
	cb, b := g.fighter("Bea", 0, 46, 45, 30, 0)
	g.hit(a, b)
	g.poison(a, b, 30)
	g.sim.Command(g.w.ForceSaveForTest(cb))
	g.sim.Step()
	s := g.saves[len(g.saves)-1]
	if len(s.Conditions) != 1 || s.Conditions[0].Author != a.CharacterID() || !s.Conditions[0].AuthorHit.IsZero() {
		t.Fatalf("arena poison saved %+v", s.Conditions)
	}

	// Cid's poison on Dan, unjustified 30 s ago by the clock, but the server is younger.
	cc, c := g.fighter("Cid", 0, 20, 20, 30, 0)
	g.unsafe(cc)
	if g.sim.Tick() > 600 {
		t.Fatalf("tick %d: the server is not young", g.sim.Tick())
	}
	cd, _ := g.fighter("Dan", 0, 21, 20, 30, 0, func(ch *session.Character) {
		ch.Conditions = []session.ConditionState{{ID: "poison", LeftMs: 500, Ticks: 5, Damage: 20, Author: c.CharacterID(),
			AuthorHit: g.sim.Now().Add(-30 * time.Second), AuthorUnjust: true}}
	})
	// Fay's, by a clock that was ahead of this server's: a hit in the future is forgotten.
	cf, _ := g.fighter("Fay", 0, 20, 21, 30, 0, func(ch *session.Character) {
		ch.Conditions = []session.ConditionState{{ID: "poison", LeftMs: 500, Ticks: 5, Damage: 20, Author: c.CharacterID(),
			AuthorHit: g.sim.Now().Add(30 * time.Second), AuthorUnjust: true}}
	})
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cd.take()); len(hits) != 0 || c.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("hits %v, Cid %v", hits, c.Skull())
	}
	if hits := damageTexts(cf.take()); len(hits) != 0 {
		t.Fatalf("Fay's hits %v", hits)
	}
}
