package session_test

import (
	"slices"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/guild"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// PvP with skulls and guild wars (T5.2). Every test runs on an open 64x64 field with
// guilds on and these zones:
//
//	no_pvp      x 40..63, y 0..20
//	protection  x 0..10,  y 40..50
//	pvp (arena) x 40..50, y 40..50
func pvpRules() content.PvP {
	return content.PvP{Enabled: true, MinLevel: 20, DamagePct: 50, AggressorMs: 60000, LockMs: 10000,
		KillLockMs: 30000, KillCreditMs: 20000,
		Murderer: content.PvPMark{Hours: 2, Windows: []content.PvPWindow{{Hours: 1, Kills: 2}},
			EquipmentDropPct: 100, BackpackDropPct: 100},
		Outlaw: content.PvPMark{Hours: 5, Windows: []content.PvPWindow{{Hours: 1, Kills: 4}},
			EquipmentDropPct: 100, BackpackDropPct: 100},
		War: content.PvPWar{KillLimit: 2, Hours: 1, AnswerHours: 1, MaxWars: 2}}
}

type pvpWorld struct{ *guildHarness }

func newPvP(t *testing.T, data *session.GuildData, opts ...option) *pvpWorld {
	t.Helper()
	all := append([]option{func(c *session.Config) {
		c.Balance.PvP = pvpRules()
		c.Spells = testSpells()
		c.Balance.Skills.Base["magic"] = content.SkillBase{StartLevel: 0, BaseTries: magicTries}
	}}, opts...)
	g := &pvpWorld{newGuildHarness(t, data, all...)}
	m := g.w.Map()
	zone(m, 40, 0, 63, 20, world.FlagNoPvP)
	zone(m, 0, 40, 10, 50, world.FlagProtection)
	zone(m, 40, 40, 50, 50, world.FlagPvP)
	return g
}

// zone adds flag to every tile of the rect (inclusive) on floor 7.
func zone(m *world.Map, x0, y0, x1, y1 int, flag world.Flags) {
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			s := m.SectorAt(pos(x, y))
			s.Flags[(y%world.SectorSize)*world.SectorSize+x%world.SectorSize] |= flag
		}
	}
}

// fighter joins a character (id 0: a new one) with a backpack at (x, y).
func (g *pvpWorld) fighter(name string, id int64, x, y, level int, role session.Role, opts ...func(*session.Character)) (*fakeClient, *session.Player) {
	g.t.Helper()
	if id == 0 {
		nextChar++
		id = nextChar
	}
	c := session.Character{ID: id, AccountID: id, Name: name, Vocation: "guardian", Level: level, Health: 100000,
		Mana: 20, HasPos: true, Pos: pos(x, y), Role: role,
		Inventory: []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack)}}}
	for _, o := range opts {
		o(&c)
	}
	cl, p := g.joinChar(c)
	cl.take()
	return cl, p
}

func safeMode(on bool) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_SetSafeMode{SetSafeMode: &pb.SetSafeMode{Enabled: on}}}
}

func logout() *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}}
}

// unsafe turns cl's safe mode off.
func (g *pvpWorld) unsafe(cl *fakeClient) {
	g.input(cl, safeMode(false))
	g.sim.Step()
	cl.take()
}

// kill makes a kill v with a hit (v is left with 1 health first).
func (g *pvpWorld) kill(a, v *session.Player) {
	g.t.Helper()
	g.do(func(ctx *game.TickContext) {
		v.SetHealthForTest(1)
		g.w.PvPHitForTest(ctx, a, v, 10)
	})
}

// hit lands one hit of a on v that does not kill it.
func (g *pvpWorld) hit(a, v *session.Player) {
	g.do(func(ctx *game.TickContext) { g.w.PvPHitForTest(ctx, a, v, 2) })
}

// Who may attack whom: zones, levels, staff, the safe mode and the off switch.
func TestPvPAttackMatrix(t *testing.T) {
	type side struct {
		x, y, level int
		role        session.Role
	}
	open := func(x int) side { return side{x, 10, 30, session.RolePlayer} }
	cases := []struct {
		name   string
		a, v   side
		safe   bool
		off    bool
		reason string // "" = allowed
	}{
		{"open field", open(10), open(11), false, false, ""},
		{"safe mode, unmarked victim", open(10), open(11), true, false, "pvp.safe_mode"},
		{"victim in no_pvp", open(39), side{40, 10, 30, 0}, false, false, "pvp.zone"},
		{"attacker in no_pvp", side{40, 10, 30, 0}, open(39), false, false, "pvp.zone"},
		{"attacker in protection", side{10, 45, 30, 0}, side{11, 45, 30, 0}, false, false, "pvp.zone"},
		{"victim in protection", side{11, 45, 30, 0}, side{10, 45, 30, 0}, false, false, "pvp.zone"},
		{"arena, even in safe mode", side{45, 45, 30, 0}, side{46, 45, 30, 0}, true, false, ""},
		{"attacker below the level", side{10, 10, 19, 0}, open(11), false, false, "pvp.your_level"},
		{"victim below the level", open(10), side{11, 10, 19, 0}, false, false, "pvp.their_level"},
		{"staff attacker", side{10, 10, 30, session.RoleGM}, open(11), false, false, "pvp.staff"},
		{"staff victim", open(10), side{11, 10, 30, session.RoleAdmin}, false, false, "pvp.protected_staff"},
		{"pvp off", open(10), open(11), false, true, "combat.cannot_attack"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newPvP(t, nil, func(c *session.Config) { c.Balance.PvP.Enabled = !tc.off })
			ca, a := g.fighter("Ana", 0, tc.a.x, tc.a.y, tc.a.level, tc.a.role)
			_, v := g.fighter("Bea", 0, tc.v.x, tc.v.y, tc.v.level, tc.v.role)
			if !tc.safe {
				g.unsafe(ca)
			}
			ca.take()
			g.input(ca, setTarget(v.ID()))
			g.sim.Step()
			keys := sysKeys(ca.take())
			if tc.reason == "" {
				if a.Target() != v.ID() || len(keys) > 0 {
					t.Fatalf("target %d, messages %v; want an attack", a.Target(), keys)
				}
				return
			}
			if a.Target() != 0 || !slices.Contains(keys, tc.reason) {
				t.Fatalf("target %d, messages %v; want %s", a.Target(), keys, tc.reason)
			}
		})
	}
}

// Attacking an unmarked player gives the aggressor skull (everyone around sees it); its
// victim may fight back, even in safe mode, without a mark; killing the aggressor is
// justified.
func TestPvPAggressorAndDefense(t *testing.T) {
	g := newPvP(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.input(ca, setTarget(b.ID()))
	g.sim.RunUntil(func() bool { return a.Skull() == pb.Skull_SKULL_AGGRESSOR }, sim.MaxSeconds(5))
	skulls := find(cb.take(), (*pb.ServerMessage).GetCreatureSkull)
	if len(skulls) != 1 || skulls[0].GetId() != a.ID() || skulls[0].GetSkull() != pb.Skull_SKULL_AGGRESSOR {
		t.Fatalf("Bea saw skulls %v", skulls)
	}
	// Bea is in safe mode: she may still fight back (Ana is marked).
	g.input(cb, setTarget(a.ID()))
	g.sim.Step()
	if b.Target() != a.ID() {
		t.Fatalf("Bea cannot fight back: %v", sysKeys(cb.take()))
	}
	g.input(ca, setTarget(0))
	g.sim.RunFor(4 * time.Second) // Bea swings at least once
	if b.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("the defender got skull %v", b.Skull())
	}
	cb.take()
	g.kill(b, a)
	if keys := sysKeys(cb.take()); !slices.Contains(keys, "pvp.kill") {
		t.Fatalf("Bea's messages %v", keys)
	}
	if st := g.w.PvPStateForTest(b); len(st.Unjust) != 0 || st.Kills != 1 {
		t.Fatalf("Bea's state %+v", st)
	}
	if a.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("a death ends the aggressor skull, Ana has %v", a.Skull())
	}
}

// Self-defense without marks: Ana (marked from another fight) is attacked by Cid, who
// is justified (she has a skull). Ana hitting back is justified too, even though Cid has
// no mark, and so is killing him.
func TestPvPSelfDefense(t *testing.T) {
	g := newPvP(t, nil)
	_, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	_, e := g.fighter("Eli", 0, 12, 10, 30, 0)
	_, c := g.fighter("Cid", 0, 11, 11, 30, 0)
	g.hit(a, e) // Ana: aggressor
	if a.Skull() != pb.Skull_SKULL_AGGRESSOR {
		t.Fatal("no aggressor skull")
	}
	g.hit(c, a)
	if c.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("attacking a marked player marked Cid: %v", c.Skull())
	}
	g.kill(a, c)
	if st := g.w.PvPStateForTest(a); len(st.Unjust) != 0 || st.Kills != 1 {
		t.Fatalf("killing her attacker counted as unjustified: %+v", st)
	}
}

// Unjustified kills: the murderer skull at the first window's threshold, the outlaw at
// its own, and both end with the injected clock; old kills leave the windows.
func TestPvPMurdererAndOutlaw(t *testing.T) {
	g := newPvP(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	_, v := g.fighter("Bea", 0, 20, 20, 30, 0)
	g.kill(a, v)
	if a.Skull() != pb.Skull_SKULL_AGGRESSOR || !slices.Contains(sysKeys(ca.take()), "pvp.kill_unjust") {
		t.Fatalf("after one kill: %v", a.Skull())
	}
	g.kill(a, v)
	if a.Skull() != pb.Skull_SKULL_MURDERER {
		t.Fatalf("after two kills: %v", a.Skull())
	}
	if keys := sysKeys(ca.take()); !slices.Contains(keys, "pvp.skull_gained") {
		t.Fatalf("messages %v", keys)
	}
	g.kill(a, v)
	g.kill(a, v)
	if a.Skull() != pb.Skull_SKULL_OUTLAW {
		t.Fatalf("after four kills: %v", a.Skull())
	}
	// The outlaw mark lasts 5 h since the last kill.
	g.sim.Clock().Advance(4 * time.Hour)
	g.sim.RunFor(2 * time.Second)
	if a.Skull() != pb.Skull_SKULL_OUTLAW {
		t.Fatalf("after 4 h: %v", a.Skull())
	}
	g.sim.Clock().Advance(time.Hour + time.Minute)
	g.sim.RunFor(2 * time.Second)
	if a.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("after 5 h: %v", a.Skull())
	}
	// The old kills are out of the 1 h window: a new one is not a murder yet.
	g.kill(a, v)
	if a.Skull() != pb.Skull_SKULL_AGGRESSOR {
		t.Fatalf("a kill after the window: %v", a.Skull())
	}
	if st := g.w.PvPStateForTest(a); len(st.Unjust) != 1 || st.Kills != 5 {
		t.Fatalf("state %+v", st)
	}
}

// Safe mode with area spells: unmarked players are spared with it on and hurt with it
// off; party and guild members are never hurt.
func TestPvPSafeModeArea(t *testing.T) {
	const guildID = 1
	ana, dan := int64(5_000_001), int64(5_000_002)
	data := &session.GuildData{IDHigh: guildID, Guilds: []session.GuildRecord{{ID: guildID, Name: "Alpha", Members: []session.GuildMemberRecord{
		{CharacterID: ana, Name: "Ana", Rank: guild.Leader}, {CharacterID: dan, Name: "Dan", Rank: guild.Member}}}}}
	g := newPvP(t, data)
	ca, a := g.fighter("Ana", ana, 20, 20, 30, 0, func(c *session.Character) { c.Vocation, c.Mana = "arcanist", arcanistMax })
	_, b := g.fighter("Bea", 0, 21, 20, 30, 0)
	cc, c := g.fighter("Cid", 0, 20, 21, 30, 0)
	_, d := g.fighter("Dan", dan, 19, 20, 30, 0)
	g.form(ca, a, member{cc, c})
	full := func(ps ...*session.Player) []bool {
		var out []bool
		for _, p := range ps {
			cur, mx := p.Health()
			out = append(out, cur == mx)
		}
		return out
	}
	g.input(ca, cast("test_ring"))
	g.sim.Step()
	if got := full(b, c, d); !slices.Equal(got, []bool{true, true, true}) || a.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("safe mode: full health %v, skull %v", got, a.Skull())
	}
	g.unsafe(ca)
	g.sim.RunFor(5 * time.Second) // cooldown
	g.input(ca, cast("test_ring"))
	g.sim.Step()
	if got := full(b, c, d); !slices.Equal(got, []bool{false, true, true}) || a.Skull() != pb.Skull_SKULL_AGGRESSOR {
		t.Fatalf("safe mode off: full health %v, skull %v", got, a.Skull())
	}
}

func warCmd(a pb.GuildAction, name string, war uint64) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_GuildCommand{GuildCommand: &pb.GuildCommand{
		Action: a, Name: name, WarId: war}}}
}

// war sends one war command (after the chat flood window refilled) and returns the
// system message keys cl got; its events stay for lastGuild.
func (g *pvpWorld) war(cl *fakeClient, a pb.GuildAction, name string, id uint64) []string {
	g.t.Helper()
	g.sim.RunFor(2 * time.Second)
	cl.take()
	g.input(cl, warCmd(a, name, id))
	g.sim.Step()
	evs := cl.take()
	cl.batches = append(cl.batches, &pb.ServerBatch{Events: evs})
	return sysKeys(evs)
}

const (
	wDeclare   = pb.GuildAction_GUILD_ACTION_WAR_DECLARE
	wAccept    = pb.GuildAction_GUILD_ACTION_WAR_ACCEPT
	wDecline   = pb.GuildAction_GUILD_ACTION_WAR_DECLINE
	wSurrender = pb.GuildAction_GUILD_ACTION_WAR_SURRENDER
)

// twoGuilds is Alpha (Ana leads, Bea) and Beta (Cid leads, Dan), all level 30.
type twoGuilds struct {
	*pvpWorld
	ca, cb, cc, cd *fakeClient
	a, b, c, d     *session.Player
}

func newTwoGuilds(t *testing.T) *twoGuilds {
	t.Helper()
	ids := []int64{6_000_001, 6_000_002, 6_000_003, 6_000_004}
	for i := range ids {
		ids[i] += int64(len(t.Name())) * 10 // distinct characters per test
	}
	data := &session.GuildData{IDHigh: 2, Guilds: []session.GuildRecord{
		{ID: 1, Name: "Alpha", Members: []session.GuildMemberRecord{
			{CharacterID: ids[0], Name: "Ana", Rank: guild.Leader}, {CharacterID: ids[1], Name: "Bea", Rank: guild.Member}}},
		{ID: 2, Name: "Beta", Members: []session.GuildMemberRecord{
			{CharacterID: ids[2], Name: "Cid", Rank: guild.Leader}, {CharacterID: ids[3], Name: "Dan", Rank: guild.Member}}},
	}}
	tg := &twoGuilds{pvpWorld: newPvP(t, data)}
	tg.ca, tg.a = tg.fighter("Ana", ids[0], 10, 10, 30, 0)
	tg.cb, tg.b = tg.fighter("Bea", ids[1], 11, 10, 30, 0)
	tg.cc, tg.c = tg.fighter("Cid", ids[2], 12, 12, 30, 0)
	tg.cd, tg.d = tg.fighter("Dan", ids[3], 13, 12, 30, 0)
	tg.ops()
	return tg
}

// pendingWar declares Alpha's war on Beta and returns its id from Cid's update.
func (tg *twoGuilds) pendingWar() uint64 {
	tg.t.Helper()
	wantKeys(tg.t, tg.war(tg.ca, wDeclare, "beta", 0), "guild.war_declared")
	tg.sim.Step()
	ws := lastGuild(tg.cc).GetWars()
	if len(ws) != 1 || ws[0].GetState() != pb.GuildWarState_GUILD_WAR_STATE_PENDING || ws[0].GetDeclaredByUs() ||
		ws[0].GetEnemyName() != "Alpha" {
		tg.t.Fatalf("Cid's wars %v", ws)
	}
	return ws[0].GetWarId()
}

// A war from declaration to victory: during it the members fight without marks (also
// in safe mode), every kill scores, and the kill limit ends it. Then the old enemies
// are unmarked players again.
func TestGuildWarLifecycle(t *testing.T) {
	tg := newTwoGuilds(t)
	id := tg.pendingWar()
	if keys := tg.war(tg.cc, wAccept, "", id); !slices.Contains(keys, "guild.war_started") {
		t.Fatalf("accept: %v", keys)
	}
	if ops := tg.ops(); !slices.Equal(ops, []session.GuildOp{session.GuildWarDeclare, session.GuildWarStart}) {
		t.Fatalf("ops %v", ops)
	}
	// Bea is in safe mode: Dan is a war enemy, so she may attack him.
	tg.input(tg.cb, setTarget(tg.d.ID()))
	tg.sim.Step()
	if tg.b.Target() != tg.d.ID() {
		t.Fatalf("Bea cannot attack a war enemy: %v", sysKeys(tg.cb.take()))
	}
	tg.input(tg.cb, setTarget(0))
	tg.cb.take()
	tg.kill(tg.b, tg.d)
	if keys := sysKeys(tg.cb.take()); !slices.Contains(keys, "pvp.kill") || tg.b.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("war kill: %v, skull %v", keys, tg.b.Skull())
	}
	tg.sim.Step()
	ws := lastGuild(tg.ca).GetWars()
	if len(ws) != 1 || ws[0].GetOurKills() != 1 || ws[0].GetTheirKills() != 0 || ws[0].GetKillLimit() != 2 {
		t.Fatalf("Ana's wars %v", ws)
	}
	tg.kill(tg.b, tg.d)
	tg.sim.Step()
	if keys := sysKeys(tg.ca.take()); !slices.Contains(keys, "guild.war_won") {
		t.Fatalf("Ana: %v", keys)
	}
	if keys := sysKeys(tg.cc.take()); !slices.Contains(keys, "guild.war_lost") {
		t.Fatalf("Cid: %v", keys)
	}
	if ops := tg.ops(); !slices.Equal(ops, []session.GuildOp{session.GuildWarKills, session.GuildWarKills, session.GuildWarEnd}) {
		t.Fatalf("ops %v", ops)
	}
	if st := tg.w.PvPStateForTest(tg.b); len(st.Unjust) != 0 || st.Kills != 2 {
		t.Fatalf("Bea %+v", st)
	}
	tg.cb.take()
	tg.input(tg.cb, setTarget(tg.c.ID())) // Dan woke up at the temple: Cid is in view
	tg.sim.Step()
	if keys := sysKeys(tg.cb.take()); tg.b.Target() != 0 || !slices.Contains(keys, "pvp.safe_mode") {
		t.Fatalf("after the war: target %d, %v", tg.b.Target(), keys)
	}
}

// The other ends of a war: declined, surrendered, expired, out of time (a draw) and a
// disbanded guild. Only leaders act.
func TestGuildWarEnds(t *testing.T) {
	tg := newTwoGuilds(t)
	if keys := tg.war(tg.cb, wDeclare, "beta", 0); !slices.Contains(keys, "guild.no_permission") {
		t.Fatalf("a member declared: %v", keys)
	}
	wantKeys(t, tg.war(tg.ca, wDeclare, "alpha", 0), "guild.war_self")

	id := tg.pendingWar()
	wantKeys(t, tg.war(tg.ca, wDeclare, "beta", 0), "guild.war_exists")
	wantKeys(t, tg.war(tg.ca, wAccept, "", id), "guild.war_not_found") // only the enemy accepts
	wantKeys(t, tg.war(tg.cc, wDecline, "", id), "guild.war_declined")

	id = tg.pendingWar()
	tg.war(tg.cc, wAccept, "", id)
	wantKeys(t, tg.war(tg.cc, wSurrender, "", id), "guild.war_surrendered")
	tg.sim.Step()
	wantKeys(t, sysKeys(tg.ca.take()), "guild.war_won")

	tg.pendingWar()
	tg.sim.Clock().Advance(time.Hour)
	tg.sim.RunFor(2 * time.Second)
	wantKeys(t, sysKeys(tg.ca.take()), "guild.war_expired")

	id = tg.pendingWar()
	tg.war(tg.cc, wAccept, "", id)
	tg.sim.Clock().Advance(time.Hour)
	tg.sim.RunFor(2 * time.Second)
	wantKeys(t, sysKeys(tg.ca.take()), "guild.war_draw")

	tg.ops()
	id = tg.pendingWar()
	tg.war(tg.cc, wAccept, "", id)
	tg.send(tg.ca, gDisband, "Alpha", "", 0)
	tg.sim.Step()
	wantKeys(t, sysKeys(tg.cc.take()), "guild.war_disbanded")
	if ops := tg.ops(); !slices.Equal(ops, []session.GuildOp{session.GuildWarDeclare, session.GuildWarStart,
		session.GuildWarEnd, session.GuildDisband}) {
		t.Fatalf("ops %v", ops)
	}
	if ws := lastGuild(tg.cc).GetWars(); len(ws) != 0 {
		t.Fatalf("Cid still has wars %v", ws)
	}
}

// A murderer drops everything when it dies, blessings or not; the skull stays.
func TestPvPSkullDeathLoss(t *testing.T) {
	g := newPvP(t, nil, func(c *session.Config) { c.Monsters = content.Monsters{"dummy": targetDummyDef()} }) // corpses
	blessed := map[string]int64{"bless.a": 1, "bless.b": 1, "bless.c": 1, "bless.d": 1, "bless.e": 1}
	_, a := g.fighter("Ana", 0, 10, 10, 30, 0, func(c *session.Character) {
		c.Storage = blessed
		c.Inventory = append(c.Inventory, session.ItemState{ItemID: swordID, Count: 1, Slot: int(pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND)},
			session.ItemState{ItemID: tunicID, Count: 1, Slot: int(pb.EquipmentSlot_EQUIPMENT_SLOT_ARMOR)})
	})
	_, v := g.fighter("Bea", 0, 20, 20, 30, 0)
	g.kill(a, v)
	g.kill(a, v)
	if a.Skull() != pb.Skull_SKULL_MURDERER {
		t.Fatalf("skull %v", a.Skull())
	}
	g.do(func(ctx *game.TickContext) { g.w.DieForTest(ctx, a) })
	last := g.saves[len(g.saves)-1]
	if last.CharacterID != a.CharacterID() || len(last.Inventory) != 0 {
		t.Fatalf("a murderer with 5 blessings kept %v", last.Inventory)
	}
	if a.Skull() != pb.Skull_SKULL_MURDERER || last.PvP.Skull != int(pb.Skull_SKULL_MURDERER) {
		t.Fatalf("the mark ended with the death: %v / %d", a.Skull(), last.PvP.Skull)
	}
}

// The PvP lock: no logout for either side, no protection zone for the attacker, until
// it passes.
func TestPvPLocks(t *testing.T) {
	g := newPvP(t, nil)
	ca, a := g.fighter("Ana", 0, 11, 45, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 46, 30, 0)
	g.hit(a, b)
	for _, cl := range []*fakeClient{ca, cb} {
		cl.take()
		g.input(cl, logout())
		g.sim.Step()
		if keys := sysKeys(cl.take()); cl.closed || !slices.Contains(keys, "pvp.logout_locked") {
			t.Fatalf("logout during the lock: closed %v, %v", cl.closed, keys)
		}
	}
	g.input(ca, walk(W))
	g.sim.RunFor(2 * time.Second)
	evs := ca.take()
	if a.Pos() != pos(11, 45) || len(find(evs, (*pb.ServerMessage).GetWalkRejected)) != 1 ||
		!slices.Contains(sysKeys(evs), "pvp.protection_locked") {
		t.Fatalf("Ana at %v, %v", a.Pos(), kinds(evs))
	}
	g.input(cb, walk(W)) // the victim may flee into a protection zone
	g.sim.RunFor(2 * time.Second)
	if b.Pos() != pos(10, 46) {
		t.Fatalf("Bea at %v", b.Pos())
	}
	g.sim.RunFor(10 * time.Second)
	g.input(ca, walk(W))
	g.sim.RunFor(2 * time.Second)
	if a.Pos() != pos(10, 45) {
		t.Fatalf("after the lock Ana is at %v", a.Pos())
	}
	g.input(ca, logout())
	g.sim.Step()
	if !ca.closed {
		t.Fatal("no logout after the lock")
	}
}

// The skull, the kills and the unjustified kills survive a logout: the next login shows
// the skull to everyone.
func TestPvPPersistence(t *testing.T) {
	g := newPvP(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	_, v := g.fighter("Bea", 0, 20, 20, 30, 0)
	g.kill(a, v)
	g.kill(a, v)
	g.sim.RunFor(31 * time.Second) // the kill lock
	charID := a.CharacterID()
	g.sim.Command(g.w.Leave(ca))
	g.sim.Step()
	last := g.saves[len(g.saves)-1]
	st := last.PvP
	if last.CharacterID != charID || st.Skull != int(pb.Skull_SKULL_MURDERER) || st.Kills != 2 || len(st.Unjust) != 2 ||
		!st.SkullUntil.After(g.sim.Now()) {
		t.Fatalf("saved %+v", st)
	}
	cv, _ := g.fighter("Cid", 0, 11, 11, 30, 0)
	_, a2 := g.fighter("Ana", charID, 10, 10, 30, 0, func(c *session.Character) { c.PvP = st })
	if a2.Skull() != pb.Skull_SKULL_MURDERER {
		t.Fatalf("after login: %v", a2.Skull())
	}
	g.sim.Step()
	seen := false
	for _, ap := range find(cv.take(), (*pb.ServerMessage).GetCreatureAppear) {
		if ap.GetCreature().GetId() == a2.ID() {
			seen = ap.GetCreature().GetSkull() == pb.Skull_SKULL_MURDERER
		}
	}
	if !seen {
		t.Fatal("Cid did not see the skull")
	}
}

// A defeat in an arena costs nothing and marks nobody.
func TestPvPArena(t *testing.T) {
	g := newPvP(t, nil)
	ca, a := g.fighter("Ana", 0, 45, 45, 30, 0)
	cv, v := g.fighter("Bea", 0, 46, 45, 30, 0, func(c *session.Character) { c.Experience = 50000 })
	xp := v.Experience()
	g.kill(a, v)
	if v.Experience() != xp || a.Skull() != pb.Skull_SKULL_UNSPECIFIED {
		t.Fatalf("experience %d → %d, skull %v", xp, v.Experience(), a.Skull())
	}
	wantKeys(t, sysKeys(cv.take()), "pvp.arena_defeat")
	g.input(ca, logout())
	g.sim.Step()
	if !ca.closed {
		t.Fatal("an arena fight locked the logout")
	}
}

// A GM removes a skull (audited); a player cannot.
func TestPvPUnskull(t *testing.T) {
	g := newPvP(t, nil)
	cgm, _ := g.fighter("Gina", 0, 30, 30, 30, session.RoleGM)
	cp, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	_, v := g.fighter("Bea", 0, 20, 20, 30, 0)
	g.kill(a, v)
	g.kill(a, v)
	g.sim.RunFor(2 * time.Second)
	cp.take()
	g.input(cp, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/unskull Ana"))
	g.sim.Step()
	if keys := sysKeys(cp.take()); !slices.Contains(keys, "command.unknown") || a.Skull() != pb.Skull_SKULL_MURDERER {
		t.Fatalf("a player unskulled: %v", keys)
	}
	g.jobs = nil
	g.input(cgm, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/unskull Ana"))
	g.sim.Step()
	if a.Skull() != pb.Skull_SKULL_UNSPECIFIED || len(g.w.PvPStateForTest(a).Unjust) != 0 {
		t.Fatalf("skull %v", a.Skull())
	}
	audited := false
	for _, j := range g.jobs {
		audited = audited || j.Kind == session.AdminAudit && j.Audit.Action == "remove_skull" && j.Audit.Result == "ok"
	}
	if !audited {
		t.Fatalf("jobs %+v", g.jobs)
	}
}
