package session_test

import (
	"bytes"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// The logout block of a fight (docs/02 "Bloqueo de logout en combate", linkdead.go): no
// Logout within travel.combat_block_ms of fighting a monster, and a connection closed in
// that time leaves the character in the world link-dead until the fight is over.

// combatBlock is the travel.combat_block_ms the fight tests set (fightHarness, blockMs):
// their own, not the one of data/balance.yaml (TestChapterOnePlayable reads that one).
const combatBlock = 12 * time.Second

// blockMs is a harness option: travel.combat_block_ms is combatBlock.
func blockMs(c *session.Config) { c.Balance.Travel.CombatBlockMs = int(combatBlock / time.Millisecond) }

// far is a tile out of the wolf's sight and far from the temple (worldtest: its first
// tile, (0, 0)).
var far = pos(55, 55)

// fightHarness is a harness on an open 64x64 map with travel.combat_block_ms of 12 s and
// one wolf at (20, 20) that bites for exactly bite every 2 s and never dies nor flees.
// With bite 0 it is a passive wolf with no attack at all: only the player fights.
func fightHarness(t *testing.T, bite int, opts ...option) *harness {
	t.Helper()
	def := wolfDef()
	def.Health, def.Behavior.FleeAtHealthPct, def.Loot = 1_000_000, 0, nil
	def.Attacks[0].Min, def.Attacks[0].Max = bite, bite
	if bite == 0 {
		def.Attacks, def.Behavior.Aggressive = nil, false
	}
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 20, 20, 0, 600)}
	return newHarness(t, m, append([]option{func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": def}
		c.Items = testItems()
	}, blockMs}, opts...)...)
}

// hunter joins a level-level guardian with full health next to the wolf, carrying a
// sword, a shield, a tunic and a backpack with 50 coins.
func (h *harness) hunter(name string, level int) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: name, Vocation: "guardian", Level: level,
		Experience: testBalance().Experience.TotalFor(level) + 100, Health: 1 << 20, Pos: pos(21, 20), HasPos: true,
		InventoryLoaded: true, Inventory: []session.ItemState{
			{ItemID: swordID, Count: 1, Slot: int(slotRight)},
			{ItemID: shieldID, Count: 1, Slot: int(slotLeft)},
			{ItemID: tunicID, Count: 1, Slot: int(slotArmor)},
			{ItemID: packID, Count: 1, Slot: int(slotBackpack), Items: []session.ItemState{{ItemID: coinID, Count: 50}}},
		}}
	return h.joinChar(c)
}

// bitten runs until the wolf's bite hurt p, and returns when.
func (h *harness) bitten(p *session.Player) time.Time {
	h.t.Helper()
	h.sim.RunUntil(func() bool { cur, mx := p.Health(); return cur < mx }, sim.MaxSeconds(10))
	return h.sim.Now()
}

// away takes p out of the wolf's sight: no more bites.
func (h *harness) away(p *session.Player) {
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, far) }))
	h.sim.Step()
}

// runTo runs the world until since+d.
func (h *harness) runTo(since time.Time, d time.Duration) {
	h.t.Helper()
	if left := since.Add(d).Sub(h.sim.Now()); left > 0 {
		h.sim.RunFor(left)
	}
}

// savesOf returns the snapshots of character id submitted from index from of h.saves on.
func (h *harness) savesOf(id int64, from int) []session.Snapshot {
	var out []session.Snapshot
	for _, s := range h.saves[from:] {
		if s.CharacterID == id {
			out = append(out, s)
		}
	}
	return out
}

// Logging out in the middle of a fight is refused: 5 s after a wolf's bite the Logout
// answers combat.logout_locked and the connection stays; past travel.combat_block_ms it
// goes as always (LOGGED_OUT, saved).
func TestLogoutRefusedAfterAMonsterHit(t *testing.T) {
	h := fightHarness(t, 15)
	cl, p := h.hunter("Hunter", 1)
	hit := h.bitten(p)
	h.away(p)
	h.runTo(hit, 5*time.Second)
	cl.take()
	h.input(cl, logout())
	h.sim.Step()
	if keys := sysKeys(cl.take()); cl.closed || !slices.Equal(keys, []string{"combat.logout_locked"}) ||
		h.w.PlayerByCharacter(p.CharacterID()) != p {
		t.Fatalf("5 s after the bite: closed %v, messages %v", cl.closed, keys)
	}
	h.runTo(hit, combatBlock+time.Second)
	n := len(h.saves)
	h.input(cl, logout())
	h.sim.Step()
	if s := h.savesOf(p.CharacterID(), n); !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT ||
		h.w.PlayerByCharacter(p.CharacterID()) != nil || len(s) != 1 || !s[0].Final {
		t.Fatalf("after the block: closed %v (%v), saves %d", cl.closed, cl.reason, len(s))
	}
}

// Dealing damage is fighting too: a player who hits a wolf that never bites back cannot
// log out right after.
func TestLogoutRefusedAfterHittingAMonster(t *testing.T) {
	h := fightHarness(t, 0)
	cl, p := h.hunter("Striker", 1)
	wolf := onlyMonster(t, h)
	h.input(cl, setTarget(wolf.ID()))
	h.sim.RunUntil(func() bool { cur, mx := wolf.Health(); return cur < mx }, sim.MaxSeconds(10))
	if cur, mx := p.Health(); cur != mx {
		t.Fatalf("the wolf hurt the player: %d/%d", cur, mx)
	}
	h.input(cl, setTarget(0))
	h.sim.Step()
	cl.take()
	h.input(cl, logout())
	h.sim.Step()
	if keys := sysKeys(cl.take()); cl.closed || !slices.Contains(keys, "combat.logout_locked") {
		t.Fatalf("closed %v, messages %v", cl.closed, keys)
	}
}

// A connection closed in the middle of a fight leaves the character in the world,
// link-dead: what its connection still sends is ignored, and it stays until
// travel.combat_block_ms after its last fight; then it leaves and is saved once.
func TestLinkDeadUntilTheFightEnds(t *testing.T) {
	h := fightHarness(t, 15)
	cl, p := h.hunter("Runner", 1)
	ow, _ := h.join("Watcher", at(57, 55))
	hit := h.bitten(p)
	h.away(p)
	n := len(h.saves)
	h.sim.Command(h.w.Leave(cl)) // the tab closed
	h.input(cl, walk(W))         // read before the close, queued after it
	h.sim.Step()
	ow.take()
	h.runTo(hit, combatBlock-time.Second)
	if h.w.PlayerByCharacter(p.CharacterID()) != p || !p.LinkDead() || p.Pos() != far ||
		len(h.savesOf(p.CharacterID(), n)) != 0 || cl.closes != 0 {
		t.Fatalf("before the block ends: in the world %v, link-dead %v, at %v, saves %d, closes %d",
			h.w.PlayerByCharacter(p.CharacterID()) == p, p.LinkDead(), p.Pos(), len(h.savesOf(p.CharacterID(), n)), cl.closes)
	}
	if gone := find(ow.take(), (*pb.ServerMessage).GetCreatureDisappear); len(gone) != 0 {
		t.Fatalf("the watcher saw it leave early: %v", gone)
	}
	h.runTo(hit, combatBlock+time.Second)
	s := h.savesOf(p.CharacterID(), n)
	if h.w.PlayerByCharacter(p.CharacterID()) != nil || len(s) != 1 || !s[0].Final || s[0].Pos != far {
		t.Fatalf("after the block: in the world %v, saves %+v", h.w.PlayerByCharacter(p.CharacterID()) != nil, s)
	}
	if gone := find(ow.take(), (*pb.ServerMessage).GetCreatureDisappear); len(gone) != 1 || gone[0].GetId() != p.ID() {
		t.Fatalf("the watcher did not see it leave: %v", gone)
	}
}

// A link-dead character is still the wolf's prey: it keeps biting (each bite renews the
// block) until the character dies. The death costs what any death costs (experience;
// equipment and backpack to the corpse) and takes it out of the world with one save, the
// final one: nothing is lost or doubled between the corpse and that save.
func TestLinkDeadKilledByAMonster(t *testing.T) {
	h := fightHarness(t, 40)
	cl, p := h.hunter("Doomed", 20)
	xp := p.Experience()
	h.bitten(p)
	at := p.Pos()
	n := len(h.saves)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.sim.RunFor(3 * time.Second)
	if !p.LinkDead() || wolf.TargetID() != p.ID() {
		t.Fatalf("link-dead %v, the wolf's target %d (player %d)", p.LinkDead(), wolf.TargetID(), p.ID())
	}
	h.sim.RunUntil(func() bool { return h.w.PlayerByCharacter(p.CharacterID()) == nil }, sim.MaxSeconds(60))
	s := h.savesOf(p.CharacterID(), n)
	if len(s) != 1 || !s[0].Final {
		t.Fatalf("saves after the leave: %+v", s)
	}
	if s[0].Experience >= xp || s[0].Experience != p.Experience() || s[0].Pos != h.w.Map().Islands()[0].Temple {
		t.Fatalf("saved experience %d (had %d, now %d) at %v", s[0].Experience, xp, p.Experience(), s[0].Pos)
	}
	if wolf.TargetID() != 0 || p.LinkDead() {
		t.Fatalf("the wolf still targets %d, link-dead %v", wolf.TargetID(), p.LinkDead())
	}
	// Every item is either in the saved inventory or in the corpse, once.
	got := map[uint16]int{}
	var count func([]session.ItemState)
	count = func(items []session.ItemState) {
		for _, it := range items {
			got[it.ItemID] += it.Count
			count(it.Items)
		}
	}
	count(s[0].Inventory)
	var inCorpse func([]*session.Item)
	inCorpse = func(items []*session.Item) {
		for _, it := range items {
			got[it.Def().Numeric] += it.Count()
			inCorpse(it.Items())
		}
	}
	corpses := h.w.CorpsesAt(at)
	if len(corpses) != 1 {
		t.Fatalf("%d corpses where it died", len(corpses))
	}
	inCorpse(corpses[0].Item.Items())
	want := map[uint16]int{swordID: 1, shieldID: 1, tunicID: 1, packID: 1, coinID: 50}
	for id, c := range want {
		if got[id] != c {
			t.Errorf("item %d: %d between the save and the corpse, want %d (all: %v)", id, got[id], c, got)
		}
	}
	if len(got) != len(want) {
		t.Errorf("items %v, want %v", got, want)
	}
}

// A new login of a link-dead character takes that same character back (no second one in
// the world): its position and health in memory, and its fight, so the Logout is still
// refused until the block ends.
func TestRelogTakesTheLinkDeadBack(t *testing.T) {
	h := fightHarness(t, 15)
	cl, p := h.hunter("Return", 1)
	hit := h.bitten(p)
	h.away(p)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	h.runTo(hit, 3*time.Second)
	if !p.LinkDead() {
		t.Fatal("not link-dead")
	}
	hp, _ := p.Health()
	// The database still has the character where it joined, with full health.
	cl2 := &fakeClient{}
	h.sim.Command(h.joinCmd(session.Character{ID: p.CharacterID(), AccountID: p.CharacterID(), Name: "Return",
		Vocation: "guardian", Level: 1, Health: 1 << 20, Pos: pos(21, 20), HasPos: true}, cl2))
	h.sim.Step()
	p2 := h.w.PlayerByCharacter(p.CharacterID())
	if p2 == nil {
		t.Fatalf("the relog left no player in the world (new connection closed %v: %v)", cl2.closed, cl2.reason)
	}
	if hp2, _ := p2.Health(); p2 == p || p2.LinkDead() || p2.Pos() != far || hp2 != hp || len(h.w.Players()) != 1 {
		t.Fatalf("took over: %v, link-dead %v, at %v, health %d (had %d), %d players", p2 != p, p2.LinkDead(), p2.Pos(),
			hp2, hp, len(h.w.Players()))
	}
	if cl2.closed {
		t.Fatalf("the new connection closed: %v", cl2.reason)
	}
	cl2.take()
	h.input(cl2, logout())
	h.sim.Step()
	if keys := sysKeys(cl2.take()); cl2.closed || !slices.Contains(keys, "combat.logout_locked") {
		t.Fatalf("the fight did not carry over: closed %v, %v", cl2.closed, keys)
	}
	h.runTo(hit, combatBlock+time.Second)
	h.input(cl2, logout())
	h.sim.Step()
	if !cl2.closed || cl2.reason != pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT {
		t.Fatalf("after the block: closed %v (%v)", cl2.closed, cl2.reason)
	}
}

// A death ends the fight: the player wakes at the temple and may log out at once.
func TestDeathEndsTheLogoutBlock(t *testing.T) {
	h := fightHarness(t, 60)
	cl, p := h.hunter("Fallen", 1)
	h.sim.RunUntil(func() bool { return p.Pos() == h.w.Map().Islands()[0].Temple }, sim.MaxSeconds(30))
	h.input(cl, logout())
	h.sim.Step()
	if !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT {
		t.Fatalf("after the death: closed %v (%v), messages %v", cl.closed, cl.reason, sysKeys(cl.take()))
	}
}

// Staff sanctions and a failed save are no fight to wait for: a kick, a ban and a
// transfer that was not stored (Tainted, SAVE_FAILED) take a player in combat out at once,
// connected or link-dead, and save it once. A password reset (the server ends the
// connection, not staff) leaves it link-dead like a closed tab.
func TestSanctionInCombatRemovesAtOnce(t *testing.T) {
	a := newAdminHarness(t, blockMs)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(2, 2))
	hurt := func(p *session.Player) {
		a.sim.Command(ctxFunc(func(ctx *game.TickContext) { a.w.HurtForTest(ctx, p, 1) }))
		a.sim.Step()
	}
	kick := func(_ *session.Player, name string) {
		if got := a.cmd(gm, "/kick "+name); !slices.Equal(got, []string{"gm.kicked"}) {
			t.Fatalf("kick %s: %v", name, got)
		}
	}
	ban := func(p *session.Player, name string) {
		a.takeJobs()
		if got := a.cmd(gm, "/ban "+name+" 7d botting"); len(got) != 0 {
			t.Fatalf("ban %s answered before the database: %v", name, got)
		}
		var job *session.AdminJob
		for _, j := range a.takeJobs() {
			if j.Kind == session.AdminBan {
				job = &j
			}
		}
		if job == nil {
			t.Fatalf("ban %s: no ban job", name)
		}
		a.sim.Command(a.w.AdminDone(session.AdminResult{ID: job.ID, Result: session.AdminOK, AccountID: p.CharacterID(), Name: name}))
		a.sim.Step()
	}
	taint := func(p *session.Player, _ string) {
		a.sim.Command(a.w.Tainted([]int64{p.CharacterID()}))
		a.sim.Step()
	}
	for _, c := range []struct {
		names  [2]string // connected, link-dead
		do     func(*session.Player, string)
		reason pb.DisconnectReason
	}{
		{[2]string{"Online", "Gone"}, kick, pb.DisconnectReason_DISCONNECT_REASON_KICKED},
		{[2]string{"Outlaw", "Fugitive"}, ban, pb.DisconnectReason_DISCONNECT_REASON_BANNED},
		{[2]string{"Tainted", "Lost"}, taint, pb.DisconnectReason_DISCONNECT_REASON_SAVE_FAILED},
	} {
		for i, linkDead := range []bool{false, true} {
			name := c.names[i]
			cl, p := a.joinAs(name, session.RolePlayer, pos(5, 5))
			hurt(p)
			if linkDead {
				a.sim.Command(a.w.Leave(cl))
				a.sim.Step()
				if !p.LinkDead() {
					t.Fatalf("%s is not link-dead", name)
				}
			}
			n := len(a.saves)
			c.do(p, name)
			if s := a.savesOf(p.CharacterID(), n); a.w.PlayerByCharacter(p.CharacterID()) != nil || p.LinkDead() ||
				len(s) != 1 || !s[0].Final || cl.reason != c.reason {
				t.Fatalf("%s: in the world %v, link-dead %v, saves %d, reason %v (want %v)", name,
					a.w.PlayerByCharacter(p.CharacterID()) != nil, p.LinkDead(), len(s), cl.reason, c.reason)
			}
		}
	}

	cl, p := a.joinAs("Reset", session.RolePlayer, pos(6, 6))
	hurt(p)
	a.sim.Command(a.w.KickAccount(p.CharacterID(), a.sim.Now())) // joinAs: account = character
	a.sim.Step()
	if !cl.closed || cl.closes != 1 || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED ||
		!p.LinkDead() || a.w.PlayerByCharacter(p.CharacterID()) != p {
		t.Fatalf("reset: closed %v (%d, %v), link-dead %v", cl.closed, cl.closes, cl.reason, p.LinkDead())
	}
	a.sim.RunFor(combatBlock + time.Second)
	if a.w.PlayerByCharacter(p.CharacterID()) != nil || cl.closes != 1 {
		t.Fatalf("reset: still in the world %v after the block, closes %d", a.w.PlayerByCharacter(p.CharacterID()) != nil, cl.closes)
	}
}

// A server shutdown saves a link-dead character with everyone else (SaveAll).
func TestShutdownSavesLinkDead(t *testing.T) {
	h := fightHarness(t, 15)
	cl, p := h.hunter("Sleeper", 1)
	h.bitten(p)
	h.away(p)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	n := len(h.saves)
	if pending := h.w.SaveAll(); len(pending) != 0 {
		t.Fatalf("pending %d", len(pending))
	}
	if s := h.savesOf(p.CharacterID(), n); !p.LinkDead() || len(s) != 1 || !s[0].Final || s[0].Pos != far {
		t.Fatalf("link-dead %v, saves %+v", p.LinkDead(), s)
	}
}

// A link-dead duelist defeated in the arena by its rival's swing (in the combat system,
// while it goes over the players: deathSave leaves the removal to the end of the tick)
// leaves with one save and loses nothing; the rival stays, its target gone.
func TestLinkDeadArenaDefeat(t *testing.T) {
	g := newPvP(t, nil, blockMs)
	ca, a := g.fighter("Ana", 0, 45, 45, 30, 0)
	cb, b := g.fighter("Bea", 0, 46, 45, 30, 0, func(c *session.Character) { c.Experience = 200000 })
	g.hit(a, b) // an arena hit: no PvP lock, but a fight
	g.sim.Command(g.w.Leave(cb))
	g.sim.Step()
	if !b.LinkDead() {
		t.Fatal("Bea is not link-dead after an arena hit")
	}
	xp := b.Experience()
	n := len(g.saves)
	g.do(func(*game.TickContext) { b.SetHealthForTest(1) })
	g.input(ca, setTarget(b.ID()))
	g.sim.RunUntil(func() bool { return g.w.PlayerByCharacter(b.CharacterID()) == nil }, sim.MaxSeconds(30))
	s := g.savesOf(b.CharacterID(), n)
	if len(s) != 1 || !s[0].Final || s[0].Experience != xp || s[0].Pos == pos(46, 45) {
		t.Fatalf("Bea's saves %+v (experience %d before)", s, xp)
	}
	if g.w.PlayerByCharacter(a.CharacterID()) != a || a.Target() != 0 {
		t.Fatalf("Ana in the world %v, target %d", g.w.PlayerByCharacter(a.CharacterID()) == a, a.Target())
	}
	// Nobody saw the defeat: Bea's next login says it (pvp.arena_defeat), only once.
	back := session.Character{ID: b.CharacterID(), AccountID: b.CharacterID(), Name: "Bea", Vocation: "guardian", Level: 30}
	cl2, _ := g.joinChar(back)
	if keys := sysKeys(cl2.take()); !slices.Contains(keys, "pvp.arena_defeat") {
		t.Fatalf("first login after the defeat: system messages %v", keys)
	}
	g.input(cl2, logout())
	g.sim.Step()
	cl3, _ := g.joinChar(back)
	if keys := sysKeys(cl3.take()); slices.Contains(keys, "pvp.arena_defeat") {
		t.Fatalf("the defeat was told again at the second login: %v", keys)
	}
}

// withLongPoison gives the world the test conditions with a poison of up to 40 hits.
func withLongPoison(c *session.Config) {
	cs := testConditions()
	cs["poison"].MaxTicks = 40
	c.Balance.Conditions = cs
}

// A link-dead character's conditions keep running, and each hit of a poison is a fight
// too: it stays in the world past the block of the last bite, until
// travel.combat_block_ms after the poison's last hit, and leaves then with one save.
func TestLinkDeadPoisonRenewsTheBlock(t *testing.T) {
	h := fightHarness(t, 15, withLongPoison)
	cl, p := h.hunter("Poisoned", 20)
	wolf := onlyMonster(t, h)
	hit := h.bitten(p)
	h.away(p)
	h.do(func(ctx *game.TickContext) {
		if !h.w.ApplyConditionForTest(ctx, p, nil, &content.ConditionApply{ID: "poison", Damage: 2, Ticks: 20}, wolf.ID()) {
			t.Fatal("no poison")
		}
	})
	n := len(h.saves)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	h.runTo(hit, combatBlock+5*time.Second) // past the bite's block
	if left := h.w.ConditionsForTest(p)["poison"]; h.w.PlayerByCharacter(p.CharacterID()) != p || !p.LinkDead() ||
		left == 0 || left >= 20 || len(h.savesOf(p.CharacterID(), n)) != 0 {
		t.Fatalf("17 s after the bite: in the world %v, link-dead %v, poison hits left %d, saves %d",
			h.w.PlayerByCharacter(p.CharacterID()) == p, p.LinkDead(), left, len(h.savesOf(p.CharacterID(), n)))
	}
	h.sim.RunUntil(func() bool { return h.w.ConditionsForTest(p)["poison"] == 0 }, sim.MaxSeconds(30))
	last := h.sim.Now() // the poison's last hit
	h.runTo(last, combatBlock-time.Second)
	if h.w.PlayerByCharacter(p.CharacterID()) != p || len(h.savesOf(p.CharacterID(), n)) != 0 {
		t.Fatal("it left before the block of the poison's last hit ended")
	}
	h.runTo(last, combatBlock+time.Second)
	if s := h.savesOf(p.CharacterID(), n); h.w.PlayerByCharacter(p.CharacterID()) != nil || len(s) != 1 || !s[0].Final {
		t.Fatalf("after the block: in the world %v, saves %+v", h.w.PlayerByCharacter(p.CharacterID()) != nil, s)
	}
}

// A slow client in a fight with a monster (the server cuts it) stays in the world
// link-dead like a closed tab: its connection is closed once, the gateway's Leave and a
// late command change nothing, and it leaves with one save when the block ends.
func TestSlowClientInAMonsterFight(t *testing.T) {
	h := fightHarness(t, 15)
	cl, p := h.hunter("Laggy", 1)
	hit := h.bitten(p)
	h.away(p)
	n := len(h.saves)
	h.cutSlow(cl)
	if h.w.PlayerByCharacter(p.CharacterID()) != p || !p.LinkDead() || cl.closes != 1 || len(h.savesOf(p.CharacterID(), n)) != 0 {
		t.Fatalf("cut: in the world %v, link-dead %v, closes %d, saves %d", h.w.PlayerByCharacter(p.CharacterID()) == p,
			p.LinkDead(), cl.closes, len(h.savesOf(p.CharacterID(), n)))
	}
	h.sim.Command(h.w.Leave(cl)) // the gateway, once the socket is closed
	h.input(cl, walk(W))         // read before the close, queued after it
	h.runTo(hit, combatBlock-time.Second)
	if h.w.PlayerByCharacter(p.CharacterID()) != p || p.Pos() != far || len(h.savesOf(p.CharacterID(), n)) != 0 {
		t.Fatalf("before the block ends: in the world %v, at %v", h.w.PlayerByCharacter(p.CharacterID()) == p, p.Pos())
	}
	h.runTo(hit, combatBlock+time.Second)
	if s := h.savesOf(p.CharacterID(), n); h.w.PlayerByCharacter(p.CharacterID()) != nil || len(s) != 1 || !s[0].Final ||
		s[0].Pos != far || cl.closes != 1 {
		t.Fatalf("after the block: in the world %v, saves %+v, closes %d", h.w.PlayerByCharacter(p.CharacterID()) != nil, s, cl.closes)
	}
}

// diedExperience is the experience a death.died message in evs says was lost, and
// whether there is one.
func diedExperience(evs []*pb.ServerMessage) (int64, bool) {
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		if l := m.GetLocalized(); l.GetKey() == "death.died" {
			for _, p := range l.GetParams() {
				if p.GetName() == "experience" {
					return p.GetNumber(), true
				}
			}
			return 0, true
		}
	}
	return 0, false
}

// A character that died link-dead learns it at its next login, which opens with the
// death screen (the same death.died, with what it lost); only once.
func TestDiedLinkDeadToldAtNextLogin(t *testing.T) {
	h := fightHarness(t, 40)
	cl, p := h.hunter("Unaware", 20)
	xp := p.Experience()
	h.bitten(p)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	h.sim.RunUntil(func() bool { return h.w.PlayerByCharacter(p.CharacterID()) == nil }, sim.MaxSeconds(60))
	lost := xp - p.Experience()
	back := session.Character{ID: p.CharacterID(), AccountID: p.CharacterID(), Name: "Unaware", Vocation: "guardian", Level: 20}
	cl2, _ := h.joinChar(back)
	if got, ok := diedExperience(cl2.take()); !ok || got != lost || lost <= 0 {
		t.Fatalf("first login: death.died %v with %d experience, lost %d", ok, got, lost)
	}
	h.input(cl2, logout())
	h.sim.Step()
	if !cl2.closed {
		t.Fatalf("the death ended the fight, yet the logout was refused: %v", sysKeys(cl2.take()))
	}
	cl3, _ := h.joinChar(back)
	if _, ok := diedExperience(cl3.take()); ok {
		t.Fatal("the death was told again at the second login")
	}
}

// A link-dead character that dies while its PvP lock lasts pays the death and waits out
// the lock at the temple, still link-dead: the death is saved at once (not the final
// save) and it leaves with its final save when the lock ends. A login in between takes it
// over and opens with the death screen.
func TestLinkDeadDeathUnderPvPLock(t *testing.T) {
	for _, relog := range []bool{false, true} {
		g := newPvP(t, nil)
		ca, a := g.fighter("Ana", 0, 10, 10, 30, 0, func(c *session.Character) { c.Experience = 200000 })
		_, b := g.fighter("Bea", 0, 11, 10, 30, 0)
		g.unsafe(ca)
		g.hit(a, b) // Ana's PvP lock: 10 s
		g.sim.Command(g.w.Leave(ca))
		g.sim.Step()
		n, xp := len(g.saves), a.Experience()
		g.do(func(ctx *game.TickContext) { g.w.HurtForTest(ctx, a, 1_000_000) }) // the world's damage
		temple := g.w.Map().Islands()[0].Temple
		s := g.savesOf(a.CharacterID(), n)
		if g.w.PlayerByCharacter(a.CharacterID()) != a || !a.LinkDead() || a.Pos() != temple ||
			len(s) != 1 || s[0].Final || s[0].Experience >= xp || s[0].Pos != temple {
			t.Fatalf("relog %v: after the death in the world %v, link-dead %v, at %v, saves %+v", relog,
				g.w.PlayerByCharacter(a.CharacterID()) == a, a.LinkDead(), a.Pos(), s)
		}
		if relog {
			cl2, a2 := g.joinChar(session.Character{ID: a.CharacterID(), AccountID: a.CharacterID(), Name: "Ana",
				Vocation: "guardian", Level: 30, Health: 100000, Pos: pos(10, 10), HasPos: true})
			got, ok := diedExperience(cl2.take())
			if a2 == a || a2.Pos() != temple || !ok || got != xp-a.Experience() {
				t.Fatalf("took over at %v: death.died %v with %d experience (lost %d)", a2.Pos(), ok, got, xp-a.Experience())
			}
			continue
		}
		g.sim.RunFor(11 * time.Second)
		s = g.savesOf(a.CharacterID(), n)
		if g.w.PlayerByCharacter(a.CharacterID()) != nil || len(s) != 2 || !s[1].Final ||
			s[1].Experience != s[0].Experience || s[1].Pos != temple {
			t.Fatalf("after the lock: in the world %v, saves %+v", g.w.PlayerByCharacter(a.CharacterID()) != nil, s)
		}
	}
}

// A listed link-dead player that is not in the world (a broken invariant: only remove
// takes one out of World.linkDead) is dropped with an error log: checkLinkDead never
// spins on it, which would hang the game loop.
func TestCheckLinkDeadDropsAStrayEntry(t *testing.T) {
	var buf bytes.Buffer
	h := fightHarness(t, 0, logTo(&buf))
	cl, p := h.join("Stray", &far)
	h.sim.Command(h.w.Leave(cl)) // no fight: it leaves at once
	h.sim.Step()
	if h.w.PlayerByCharacter(p.CharacterID()) != nil {
		t.Fatal("still in the world")
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.sim.Command(gameFunc(func() { h.w.StrayLinkDeadForTest(p) }))
		h.sim.Step() // checkLinkDead runs at the end of this tick
		h.sim.Step()
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second): //nolint:forbidigo // a real deadline: a hung tick never returns
		t.Fatal("checkLinkDead spins on a link-dead player out of the world: the game loop hangs")
	}
	if p.LinkDead() || !strings.Contains(buf.String(), "a link-dead player out of the world was still listed") {
		t.Fatalf("link-dead %v, log %q", p.LinkDead(), buf.String())
	}
}

// withLinkDeadCap is a harness option: travel.link_dead_max_ms is d.
func withLinkDeadCap(d time.Duration) option {
	return func(c *session.Config) { c.Balance.Travel.LinkDeadMaxMs = int(d / time.Millisecond) }
}

// A wolf that keeps biting a link-dead character holds it in the world no longer than
// travel.link_dead_max_ms from its leave: then it leaves with its final save though the
// fight goes on (a weak spawn biting a strong character would otherwise hold it for
// good), and the wolf has nobody to bite. A PvP lock still holds a link-dead character
// past the cap, until the lock ends.
func TestLinkDeadCappedInAnEndlessFight(t *testing.T) {
	const capped = 30 * time.Second
	h := fightHarness(t, 15, withLinkDeadCap(capped))
	cl, p := h.hunter("Tank", 40)
	co, o := h.join("Outlaw", &far)
	h.bitten(p)
	wolf := onlyMonster(t, h)
	h.do(func(ctx *game.TickContext) { h.w.SetPvPLockForTest(o, ctx.Tick+game.TicksFor(45*time.Second)) })
	n := len(h.saves)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Command(h.w.Leave(co))
	h.sim.Step()
	left := h.sim.Now()
	h.runTo(left, capped-time.Second)
	if h.w.PlayerByCharacter(p.CharacterID()) != p || !p.LinkDead() || wolf.TargetID() != p.ID() ||
		finalSaves(h.savesOf(p.CharacterID(), n)) != 0 || !o.LinkDead() {
		t.Fatalf("before the cap: in the world %v, link-dead %v, the wolf targets %d (player %d), final saves %d, outlaw link-dead %v",
			h.w.PlayerByCharacter(p.CharacterID()) == p, p.LinkDead(), wolf.TargetID(), p.ID(),
			finalSaves(h.savesOf(p.CharacterID(), n)), o.LinkDead())
	}
	h.runTo(left, capped+time.Second)
	if s := h.savesOf(p.CharacterID(), n); h.w.PlayerByCharacter(p.CharacterID()) != nil || finalSaves(s) != 1 ||
		!s[len(s)-1].Final || wolf.TargetID() != 0 {
		t.Fatalf("past the cap: in the world %v, saves %+v, the wolf targets %d",
			h.w.PlayerByCharacter(p.CharacterID()) != nil, s, wolf.TargetID())
	}
	if h.w.PlayerByCharacter(o.CharacterID()) != o || !o.LinkDead() || finalSaves(h.savesOf(o.CharacterID(), n)) != 0 {
		t.Fatalf("the cap cut a PvP lock short: in the world %v, link-dead %v",
			h.w.PlayerByCharacter(o.CharacterID()) == o, o.LinkDead())
	}
	h.runTo(left, 46*time.Second)
	if s := h.savesOf(o.CharacterID(), n); h.w.PlayerByCharacter(o.CharacterID()) != nil || finalSaves(s) != 1 {
		t.Fatalf("after the PvP lock: in the world %v, saves %+v", h.w.PlayerByCharacter(o.CharacterID()) != nil, s)
	}
}

// Nobody plays a link-dead character: the wolf that keeps biting it trains no shield, and
// the bites are no help in its party's fights (party.contribution_ms after its leave it
// shares no kill: its mate keeps it all).
func TestLinkDeadLearnsNothing(t *testing.T) {
	h := fightHarness(t, 15)
	cl, p := h.hunter("Idle", 40)
	nextChar++
	cm, mate := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Mate", Vocation: "guardian", Level: 40,
		Experience: testBalance().Experience.TotalFor(40) + 100, Health: 1 << 20, Pos: pos(30, 20), HasPos: true})
	h.form(cm, mate, member{cl, p})
	h.input(cm, partyCmd(pb.PartyAction_PARTY_ACTION_SHARE_ON, 0))
	h.bitten(p)
	shield := h.w.Skill(p, "shield")
	if shield.Tries == 0 && shield.Level == 10 {
		t.Fatal("the bites before the leave trained no shield: the test proves nothing")
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	shield = h.w.Skill(p, "shield")
	h.sim.RunFor(70 * time.Second) // more than party.contribution_ms (60 s)
	if now := h.w.Skill(p, "shield"); !p.LinkDead() || now.Level != shield.Level || now.Tries != shield.Tries {
		t.Fatalf("link-dead %v, shield %d (%d tries), was %d (%d tries)", p.LinkDead(), now.Level, now.Tries, shield.Level, shield.Tries)
	}
	xm, xp := mate.Experience(), p.Experience()
	h.do(func(ctx *game.TickContext) {
		h.w.ContributeForTest(ctx, mate)
		h.w.ShareForTest(ctx, pos(25, 20), 100, session.Share{P: mate, Amount: 30})
	})
	if dm, dp := mate.Experience()-xm, p.Experience()-xp; dm != 100 || dp != 0 {
		t.Fatalf("a kill by its mate: mate +%d, link-dead +%d (want 100 and 0: no sharing)", dm, dp)
	}
}
