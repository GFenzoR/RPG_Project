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
// that author's attack), and its time runs on while its holder is away; ranged condition
// spells are in pvp_condition_spell_test.go, server-side disconnects in
// pvp_linkdead_test.go.
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
		c.AuthorHit.IsZero() || c.AuthorHit.After(g.sim.Now()) || c.SavedAt.IsZero() || c.SavedAt.After(g.sim.Now()) {
		t.Fatalf("saved poison %+v", c)
	}

	// Ana's skull is still the one of her hit by hand (the poison did not hurt in the
	// protection zone): each hit after the relog renews it.
	until := g.w.PvPStateForTest(a).SkullUntil
	cb, b := g.rejoin(bea, s, 1000)
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb.take()); !allTen(hits) {
		t.Fatalf("hits after the relog %v, want Ana's scaled hits (10)", hits)
	}
	if st := g.w.PvPStateForTest(a); a.Skull() != pb.Skull_SKULL_AGGRESSOR || !st.SkullUntil.After(until) {
		t.Fatalf("Ana's skull %v until %v, was until %v", a.Skull(), st.SkullUntil, until)
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

// A relog does not stretch an attack either: back after the aggressor time, the poison ran
// out while she was away and Ana's unjustified attack is over: nothing hurts or marks.
func TestPvPConditionRelogAfterAggressorTime(t *testing.T) {
	g := newPvPCond(t, nil)
	_, a, bea, s := g.unjustPoison()
	g.sim.RunFor(61 * time.Second)
	cb, b := g.rejoin(bea, s, 1000)
	g.sim.RunFor(3 * time.Second)
	if hits := damageTexts(cb.take()); len(hits) != 0 || a.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("hits %v, Ana %v", hits, a.Skull())
	}
	if left := g.w.ConditionsForTest(b)["poison"]; left != 0 {
		t.Fatalf("poison hits left %d", left)
	}
}

// Nor can the victim hold the attack back to land it later. Bea waits out Ana's lock in a
// protection zone and logs out; back late, but within the aggressor time of Ana's hit by
// hand and with little health, the hits that would have fallen while she was away passed
// as in the protection zone: none lands now, so Ana's skull ends 60 s after her own hit and
// the poison cannot hand her a kill. (Before, the frozen poison resumed: every hit renewed
// her skull and lock, and Bea chose when it killed her.)
func TestPvPConditionRunsWhileVictimAway(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a, bea, s := g.unjustPoison() // t = 11 s, Ana's own hit at t = 0
	until := g.w.PvPStateForTest(a).SkullUntil
	g.sim.RunFor(44 * time.Second) // t = 55 s
	if a.Skull() != pb.Skull_SKULL_AGGRESSOR {
		t.Fatalf("Ana's skull %v before the relog", a.Skull())
	}
	cb, b := g.rejoin(bea, s, 5)
	if left := g.w.ConditionsForTest(b)["poison"]; left != 0 {
		t.Fatalf("poison hits left %d after 44 s away", left)
	}
	g.sim.RunFor(7 * time.Second) // t = 62 s
	if hits := damageTexts(cb.take()); len(hits) != 0 {
		t.Fatalf("hits after the late relog %v", hits)
	}
	if st := g.w.PvPStateForTest(a); a.Skull() != pb.Skull_SKULL_UNSPECIFIED || st.SkullUntil.After(until) || st.Kills != 0 {
		t.Fatalf("Ana %v %+v, skull was until %v", a.Skull(), st, until)
	}
	g.input(ca, logout()) // her lock of t = 0 is long over
	g.sim.Step()
	if !ca.closed {
		t.Fatalf("Ana could not log out: %v", sysKeys(ca.take()))
	}
}

// A relog does not cut self-defense: the memory of Ana's attack saved with her poison comes
// back on its own clock even though the poison ran out while Bea was away, so Bea's hit
// back within the aggressor time is still justified (no skull for her).
func TestPvPConditionRelogKeepsSelfDefense(t *testing.T) {
	g := newPvPCond(t, nil)
	_, a, bea, s := g.unjustPoison() // t = 11 s, Ana's own hit at t = 0
	g.sim.RunFor(30 * time.Second)   // the 19 hits left run out meanwhile
	cb, b := g.rejoin(bea, s, 1000)
	if left := g.w.ConditionsForTest(b)["poison"]; left != 0 {
		t.Fatalf("poison hits left %d", left)
	}
	if got := g.w.HitByForTest(b); !slices.Equal(got, []int64{a.CharacterID()}) {
		t.Fatalf("Bea remembers hits from %v, want Ana's (%d)", got, a.CharacterID())
	}
	g.unsafe(cb)
	g.hit(b, a)
	if b.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("Bea's hit back is not self-defense: skull %v", b.Skull())
	}
}

// Away for a while: another player's conditions ran meanwhile and the rest goes on, on the
// beat it would have had; a monster's condition waited frozen (logging out does not cure).
// Bea joins 3 s (60 ticks) after her save: Ana's poison, due 10 ticks after it every 20,
// lost 3 of its 10 hits and is due in 10 ticks again; Ana's slow lost 3 of its 5 s; the
// monster's burning still has its 3 hits.
func TestPvPConditionTimeRunsWhileAway(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	g.unsafe(ca)
	g.sim.RunFor(5 * time.Second) // the server is older than the absence
	saved := g.sim.Now().Add(-3 * time.Second)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0, func(c *session.Character) {
		c.Conditions = []session.ConditionState{
			{ID: "poison", LeftMs: 500, Ticks: 10, Damage: 20, Author: a.CharacterID(), AuthorHit: saved, AuthorUnjust: true,
				SavedAt: saved},
			{ID: "slowed", LeftMs: 5000, Author: a.CharacterID(), SavedAt: saved},
			{ID: "burning", LeftMs: 500, Ticks: 3, Damage: 20},
		}
	})
	got := g.w.ConditionsForTest(b)
	if got["poison"] != 7 || got["slowed"] != 2000 || got["burning"] != 3 {
		t.Fatalf("conditions after 3 s away %v, want poison 7 hits, slowed 2000 ms, burning 3 hits", got)
	}
	g.sim.RunTicks(9)
	if hits := damageTexts(cb.take()); slices.Contains(hits, 10) {
		t.Fatalf("Ana's poison hit before its beat: %v", hits)
	}
	g.sim.Step()
	if hits := damageTexts(cb.take()); !slices.Contains(hits, 10) || g.w.ConditionsForTest(b)["poison"] != 6 {
		t.Fatalf("Ana's poison on its beat: hits %v, conditions %v", hits, g.w.ConditionsForTest(b))
	}
	if a.Skull() != pb.Skull_SKULL_AGGRESSOR {
		t.Fatalf("the rest is still Ana's attack: skull %v", a.Skull())
	}
}

// A save whose time cannot be placed on this server's clock ends another player's
// condition (its holder takes no hit that may have fallen long ago, its author no mark or
// lock from an attack nobody can time): a row from before the save time was kept, a save
// from before this server started, or one from a clock ahead of this one. A monster's
// condition saved with it waits as always.
func TestPvPConditionSavedBeforeRestart(t *testing.T) {
	g := newPvPCond(t, nil)
	cc, c := g.fighter("Cid", 0, 20, 20, 30, 0)
	g.unsafe(cc)
	g.sim.RunFor(2 * time.Second)
	up := g.sim.Elapsed() // the joins below run one tick later
	cases := []struct {
		name  string
		saved time.Time
		kept  bool
	}{
		{"Gus", time.Time{}, false},                               // an old row: no saved_at
		{"Hal", g.sim.Now().Add(-up - 10*time.Second), false},     // before this server's first tick
		{"Ivy", g.sim.Now().Add(30 * time.Second), false},         // a clock ahead of this one
		{"Jon", g.sim.Now().Add(-up + 2*game.TickDuration), true}, // within this server's time
	}
	for i, tc := range cases {
		_, v := g.fighter(tc.name, 0, 21+i, 20, 30, 0, func(ch *session.Character) {
			ch.Conditions = []session.ConditionState{
				{ID: "poison", LeftMs: 900, Ticks: 30, Damage: 20, Author: c.CharacterID(), AuthorUnjust: true, SavedAt: tc.saved},
				{ID: "burning", LeftMs: 500, Ticks: 3, Damage: 20},
			}
		})
		got := g.w.ConditionsForTest(v)
		if (got["poison"] > 0) != tc.kept || got["burning"] != 3 {
			t.Fatalf("%s: conditions %v, want Cid's poison %v and the monster's burning", tc.name, got, tc.kept)
		}
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
// under PvP on) only runs out, and the memory of the attack saved with it is not
// restored.
func TestPvPConditionSavedWithPvPOff(t *testing.T) {
	g := newPvPCond(t, nil, func(c *session.Config) { c.Balance.PvP.Enabled = false })
	_, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	g.sim.RunFor(2 * time.Second) // the server is older than the saved hit: it could be placed
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0, func(c *session.Character) {
		c.Conditions = []session.ConditionState{{ID: "poison", LeftMs: 500, Ticks: 5, Damage: 20, Author: a.CharacterID(),
			AuthorHit: g.sim.Now().Add(-time.Second), AuthorUnjust: true, SavedAt: g.sim.Now()}}
	})
	if hit := g.w.HitByForTest(b); len(hit) != 0 {
		t.Fatalf("Bea remembers hits from %v with PvP off", hit)
	}
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
	if len(s.Conditions) != 1 || s.Conditions[0].Author != a.CharacterID() || !s.Conditions[0].AuthorHit.IsZero() ||
		s.Conditions[0].SavedAt.IsZero() {
		t.Fatalf("arena poison saved %+v", s.Conditions)
	}

	// Cid's poison on Dan, unjustified 30 s ago by the clock, but the server is younger.
	cc, c := g.fighter("Cid", 0, 20, 20, 30, 0)
	g.unsafe(cc)
	// Dan joins on the next tick, and recallHit forgets a hit only if it is older than
	// the server (30 s = 600 ticks > that tick).
	if g.sim.Tick()+1 >= 600 {
		t.Fatalf("tick %d: the server is not young", g.sim.Tick())
	}
	cd, d := g.fighter("Dan", 0, 21, 20, 30, 0, func(ch *session.Character) {
		ch.Conditions = []session.ConditionState{{ID: "poison", LeftMs: 500, Ticks: 5, Damage: 20, Author: c.CharacterID(),
			AuthorHit: g.sim.Now().Add(-30 * time.Second), AuthorUnjust: true, SavedAt: g.sim.Now()}}
	})
	// Fay's, by a clock that was ahead of this server's: a hit in the future is forgotten.
	cf, f := g.fighter("Fay", 0, 20, 21, 30, 0, func(ch *session.Character) {
		ch.Conditions = []session.ConditionState{{ID: "poison", LeftMs: 500, Ticks: 5, Damage: 20, Author: c.CharacterID(),
			AuthorHit: g.sim.Now().Add(30 * time.Second), AuthorUnjust: true, SavedAt: g.sim.Now()}}
	})
	if g.w.ConditionsForTest(d)["poison"] == 0 || g.w.ConditionsForTest(f)["poison"] == 0 {
		t.Fatal("a poison saved just now was dropped: this tests the memory saved with it")
	}
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cd.take()); len(hits) != 0 || c.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("hits %v, Cid %v", hits, c.Skull())
	}
	if hits := damageTexts(cf.take()); len(hits) != 0 {
		t.Fatalf("Fay's hits %v", hits)
	}
}

// A victim locked in a fight who closes her connection stays link-dead, and a new login
// takes her over with the memory of the attack (pvpCarry). The poison carried in the same
// state does not add a second memory of Ana (recallHit keeps the carried entry) and still
// continues Ana's attack.
func TestPvPConditionVictimTakesOverLinkDead(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.poison(a, b, 30)
	g.sim.Command(g.w.Leave(cb))
	g.sim.Step()
	if !b.LinkDead() {
		t.Fatal("Bea is not link-dead")
	}
	cb2, b2 := g.fighter("Bea", b.CharacterID(), 11, 10, 30, 0)
	if b2 == b || g.w.ConditionsForTest(b2)["poison"] == 0 {
		t.Fatalf("the new login did not take the poison over: %v", g.w.ConditionsForTest(b2))
	}
	if got := g.w.HitByForTest(b2); !slices.Equal(got, []int64{a.CharacterID()}) {
		t.Fatalf("Bea remembers hits from %v, want only Ana's (%d)", got, a.CharacterID())
	}
	until := g.w.PvPStateForTest(a).SkullUntil
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb2.take()); !allTen(hits) || !g.w.PvPStateForTest(a).SkullUntil.After(until) {
		t.Fatalf("hits after the takeover %v, Ana's skull until %v, was until %v", hits,
			g.w.PvPStateForTest(a).SkullUntil, until)
	}
}

// Stacking a damage condition hands its hits to whoever made the stronger application
// and, on a player, its attack too: a monster's poison taken over by Ana's stronger one is
// Ana's attack (scaled hits, saved with her as its author), and taken back by a stronger
// monster's it is the world's again (full hits, no author).
func TestPvPConditionStackSwitchesAuthor(t *testing.T) {
	g := newPvPCond(t, nil, withMonster(targetDummyDef(), 60, 60))
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.sim.Step() // the monster spawns, far from both
	m := g.dummy()
	g.unsafe(ca)
	g.hit(a, b) // Ana's attack, which her poison may continue
	poison := func(source uint32, damage int) {
		g.t.Helper()
		g.do(func(ctx *game.TickContext) {
			if !g.w.ApplyConditionForTest(ctx, b, nil, &content.ConditionApply{ID: "poison", Damage: damage, Ticks: 5}, source) {
				g.t.Fatal("no poison")
			}
		})
	}
	author := func() int64 {
		g.t.Helper()
		g.sim.Command(g.w.ForceSaveForTest(cb))
		g.sim.Step()
		s := g.saves[len(g.saves)-1]
		if len(s.Conditions) != 1 || s.Conditions[0].ID != "poison" {
			g.t.Fatalf("saved conditions %+v", s.Conditions)
		}
		return s.Conditions[0].Author
	}
	same := func(hits []uint64, n uint64) bool {
		return len(hits) > 0 && !slices.ContainsFunc(hits, func(h uint64) bool { return h != n })
	}

	poison(m.ID(), 20)
	cb.take()
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb.take()); !same(hits, 20) || author() != 0 {
		t.Fatalf("the monster's poison: hits %v, author %d", hits, author())
	}
	poison(a.ID(), 30) // stronger: Ana's attack now, 30 × 50 %
	cb.take()
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb.take()); !same(hits, 15) || author() != a.CharacterID() {
		t.Fatalf("Ana's poison: hits %v, author %d", hits, author())
	}
	poison(m.ID(), 40) // stronger again: the world's
	cb.take()
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb.take()); !same(hits, 40) || author() != 0 {
		t.Fatalf("the monster's poison again: hits %v, author %d", hits, author())
	}
}
