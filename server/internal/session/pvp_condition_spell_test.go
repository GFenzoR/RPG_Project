package session_test

import (
	"slices"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// Ranged condition spells against players (T5.2): an attack by the rules of a direct one,
// whose damage condition is the caster's attack. Worlds and numbers as in
// pvp_condition_test.go (newPvPCond: root slows at 4 tiles, venom poisons at 4 tiles for
// 4 hits of 20, scaled to 10).

// A ranged condition spell aimed at a player is an attack by the rules of a direct one:
// zones, levels, staff, safe mode (a marked victim or an arena is fine), range and line
// of sight; aimed at a party member it is allowed, as a bolt is.
func TestPvPConditionSpellRules(t *testing.T) {
	type side struct{ x, y, level int }
	open := func(x int) side { return side{x, 10, 30} }
	cases := []struct {
		name    string
		a, v    side
		safe    bool
		marked  bool // v hits a third player first (aggressor)
		party   bool
		staff   bool
		off     bool
		reason  string // "" = it lands
		skull   bool   // Ana ends with the aggressor skull
		manaUse bool
	}{
		{name: "open field", a: open(10), v: open(12), reason: "", skull: true, manaUse: true},
		{name: "safe mode, unmarked victim", a: open(10), v: open(12), safe: true, reason: "pvp.safe_mode"},
		{name: "safe mode, marked victim", a: open(10), v: open(12), safe: true, marked: true, manaUse: true},
		{name: "party member", a: open(10), v: open(12), party: true, skull: true, manaUse: true},
		{name: "victim in no_pvp", a: open(38), v: side{40, 10, 30}, reason: "pvp.zone"},
		{name: "attacker in protection", a: side{10, 45, 30}, v: side{12, 45, 30}, reason: "pvp.zone"},
		{name: "victim in protection", a: side{12, 45, 30}, v: side{10, 45, 30}, reason: "pvp.zone"},
		{name: "arena, even in safe mode", a: side{45, 45, 30}, v: side{47, 45, 30}, safe: true, manaUse: true},
		{name: "victim below the level", a: open(10), v: side{12, 10, 19}, reason: "pvp.their_level"},
		{name: "staff victim", a: open(10), v: open(12), staff: true, reason: "pvp.protected_staff"},
		{name: "out of range", a: open(10), v: open(15), reason: "magic.out_of_range"},
		{name: "pvp off", a: open(10), v: open(12), off: true, reason: "magic.no_target"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newPvPCond(t, nil, func(c *session.Config) { c.Balance.PvP.Enabled = !tc.off })
			ca, a := g.fighter("Ana", 0, tc.a.x, tc.a.y, 30, 0)
			role := session.RolePlayer
			if tc.staff {
				role = session.RoleGM
			}
			cb, b := g.fighter("Bea", 0, tc.v.x, tc.v.y, tc.v.level, role)
			if tc.marked {
				_, e := g.fighter("Eli", 0, tc.v.x, tc.v.y+1, 30, 0)
				g.hit(b, e)
			}
			if tc.party {
				g.form(ca, a, member{cb, b})
			}
			if !tc.safe {
				g.unsafe(ca)
			}
			speed, mana := b.Speed(), a.Mana()
			ca.take()
			g.input(ca, castAt("root", b.ID()))
			g.sim.Step()
			keys := sysKeys(ca.take())
			slowed := g.w.ConditionsForTest(b)["slowed"] > 0
			if tc.reason != "" {
				if !slices.Contains(keys, tc.reason) || slowed || b.Speed() != speed || a.Mana() != mana {
					t.Fatalf("messages %v, slowed %v, speed %d → %d, mana %d → %d", keys, slowed, speed, b.Speed(), mana, a.Mana())
				}
			} else if !slowed || b.Speed() >= speed {
				t.Fatalf("not slowed: speed %d → %d, messages %v", speed, b.Speed(), keys)
			}
			if got := a.Skull() == pb.Skull_SKULL_AGGRESSOR; got != tc.skull {
				t.Fatalf("Ana's skull %v", a.Skull())
			}
			if tc.manaUse != (a.Mana() < mana) {
				t.Fatalf("mana %d → %d", mana, a.Mana())
			}
		})
	}
}

// A ranged condition spell on a player locks both sides like a hit, and its damage
// condition is the caster's attack: scaled hits, and a death by it is the caster's kill.
func TestPvPConditionSpellPoisonKills(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 13, 10, 30, 0)
	g.unsafe(ca)
	cb.take()
	g.input(ca, castAt("venom", b.ID()))
	g.sim.Step()
	if a.Skull() != pb.Skull_SKULL_AGGRESSOR || g.w.ConditionsForTest(b)["poison"] != 4 {
		t.Fatalf("Ana %v, Bea's conditions %v", a.Skull(), g.w.ConditionsForTest(b))
	}
	g.input(cb, logout())
	g.sim.Step()
	if keys := sysKeys(cb.take()); cb.closed || !slices.Contains(keys, "pvp.logout_locked") {
		t.Fatalf("Bea was not locked: %v", keys)
	}
	g.sim.RunFor(2 * time.Second)
	if hits := damageTexts(cb.take()); !allTen(hits) {
		t.Fatalf("poison hits %v", hits)
	}
	g.do(func(*game.TickContext) { b.SetHealthForTest(5) })
	g.sim.RunFor(time.Second)
	if st := g.w.PvPStateForTest(a); st.Kills != 1 || len(st.Unjust) != 1 {
		t.Fatalf("Ana %+v", st)
	}
}

// During a war the members of both guilds aim condition spells at each other without
// marks, also in safe mode, and a ranged poison of the war hurts as the war's attack; a
// member of the caster's own guild may be aimed at too (a direct attack), unjustified.
func TestPvPConditionSpellWar(t *testing.T) {
	tg := newTwoGuilds(t, withPvPCond)
	id := tg.pendingWar()
	tg.war(tg.cc, wAccept, "", id)
	tg.cb.take()
	tg.input(tg.cb, castAt("root", tg.d.ID()))
	tg.sim.Step()
	if keys := sysKeys(tg.cb.take()); tg.w.ConditionsForTest(tg.d)["slowed"] == 0 {
		t.Fatalf("Dan not slowed: %v", keys)
	}
	tg.input(tg.cb, castAt("venom", tg.d.ID()))
	tg.sim.Step()
	before, _ := tg.d.Health()
	tg.sim.RunFor(2 * time.Second)
	if cur, _ := tg.d.Health(); cur >= before || tg.b.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("Dan %d → %d, Bea %v", before, cur, tg.b.Skull())
	}

	// Ana, Bea's own guild, is no enemy: in safe mode the spell is refused.
	tg.cb.take()
	tg.input(tg.cb, castAt("root", tg.a.ID()))
	tg.sim.Step()
	if keys := sysKeys(tg.cb.take()); !slices.Contains(keys, "pvp.safe_mode") || tg.w.ConditionsForTest(tg.a)["slowed"] > 0 {
		t.Fatalf("root on Ana: %v", keys)
	}
}
