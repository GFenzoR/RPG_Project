package session_test

import (
	"slices"
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

// Who attacks whom and why a creature leaves the view (A9, docs/05 "Quién ataca y por
// qué sale una criatura", session/attack.go).

const (
	melee  = pb.AttackKind_ATTACK_KIND_MELEE
	ranged = pb.AttackKind_ATTACK_KIND_RANGED
	spell  = pb.AttackKind_ATTACK_KIND_SPELL
)

// attacksBy returns the CreatureAttack events of attacker id.
func attacksBy(evs []*pb.ServerMessage, id uint32) []*pb.CreatureAttack {
	var out []*pb.CreatureAttack
	for _, a := range find(evs, (*pb.ServerMessage).GetCreatureAttack) {
		if a.GetId() == id {
			out = append(out, a)
		}
	}
	return out
}

// samePos reports whether a protocol position is p.
func samePos(a *pb.Position, p world.Pos) bool {
	return a != nil && a.GetX() == uint32(p.X) && a.GetY() == uint32(p.Y) && a.GetZ() == uint32(p.Z)
}

// wantAttack fails t unless evs hold an attack of id with kind on target at to (radius r).
func wantAttack(t *testing.T, who string, evs []*pb.ServerMessage, id uint32, kind pb.AttackKind, target uint32, to world.Pos, r uint32) {
	t.Helper()
	for _, a := range attacksBy(evs, id) {
		if a.GetKind() == kind && a.GetTargetId() == target && samePos(a.GetTo(), to) && a.GetRadius() == r {
			return
		}
	}
	t.Errorf("%s: no CreatureAttack{id %d, %v, target %d, to %v, radius %d}; got %v", who, id, kind, target, to, r, attacksBy(evs, id))
}

// disappearsOf returns the reasons of the CreatureDisappear events of id.
func disappearsOf(evs []*pb.ServerMessage, id uint32) []pb.DisappearReason {
	var out []pb.DisappearReason
	for _, d := range find(evs, (*pb.ServerMessage).GetCreatureDisappear) {
		if d.GetId() == id {
			out = append(out, d.GetReason())
		}
	}
	return out
}

// wantGone fails t unless evs make id disappear exactly once, for why.
func wantGone(t *testing.T, who string, evs []*pb.ServerMessage, id uint32, why pb.DisappearReason) {
	t.Helper()
	if got := disappearsOf(evs, id); len(got) != 1 || got[0] != why {
		t.Errorf("%s: disappear reasons of %d = %v, want [%v]", who, id, got, why)
	}
}

// attackFirst fails t if, in a batch of cl with an attack of id on `to`, the first event
// about that tile is a Projectile, Effect or FloatingText: the client reads the attack
// before what it does.
func attackFirst(t *testing.T, cl *fakeClient, id uint32, to world.Pos) {
	t.Helper()
	seen := false
	for _, b := range cl.batches {
		first, mine := -1, false
		for i, e := range b.Events {
			a := e.GetCreatureAttack()
			if samePos(a.GetTo(), to) || samePos(e.GetProjectile().GetTo(), to) ||
				samePos(e.GetEffect().GetPos(), to) || samePos(e.GetFloatingText().GetPos(), to) {
				if first < 0 {
					first = i
				}
			}
			if a.GetId() == id && samePos(a.GetTo(), to) {
				seen, mine = true, true
			}
		}
		if mine && b.Events[first].GetCreatureAttack() == nil {
			t.Errorf("tick %d: event %d, before the attack of %d on %v (%v)", b.Tick, first, id, to, kinds(b.Events))
		}
	}
	if !seen {
		t.Errorf("no attack of %d on %v in the batches", id, to)
	}
}

// A client's own record of the creatures it knows (fakeClient.follow, which the harness
// checks for every client of every test) catches an attack by or at a creature the
// client never got or already saw leave, and accepts one between creatures it knows.
func TestClientsFollowWhoTheyKnow(t *testing.T) {
	creature := func(id uint32) *pb.Creature { return &pb.Creature{Id: id} }
	appear := func(id uint32) *pb.ServerMessage {
		return &pb.ServerMessage{Message: &pb.ServerMessage_CreatureAppear{CreatureAppear: &pb.CreatureAppear{Creature: creature(id)}}}
	}
	leave := func(id uint32) *pb.ServerMessage {
		return disappearMsg(id, pb.DisappearReason_DISAPPEAR_REASON_OUT_OF_VIEW)
	}
	attack := func(id, target uint32) *pb.ServerMessage {
		return &pb.ServerMessage{Message: &pb.ServerMessage_CreatureAttack{CreatureAttack: &pb.CreatureAttack{Id: id, TargetId: target}}}
	}
	full := &pb.ServerMessage{Message: &pb.ServerMessage_FullMapView{FullMapView: &pb.FullMapView{
		Area: &pb.MapArea{Creatures: []*pb.Creature{creature(1), creature(2)}}}}}
	cl := &fakeClient{}
	cl.Send(&pb.ServerBatch{Events: []*pb.ServerMessage{
		full, attack(1, 2), attack(2, 0), // known from the full view
		attack(3, 1), appear(3), attack(3, 1), // 3 before and after it appears
		leave(2), attack(1, 2), // 2 after it left
		full, attack(3, 1), // a full view forgets what it does not list
	}})
	got := make([][2]uint32, 0, len(cl.strangers))
	for _, a := range cl.strangers {
		got = append(got, [2]uint32{a.GetId(), a.GetTargetId()})
	}
	if want := [][2]uint32{{3, 1}, {1, 2}, {3, 1}}; !slices.Equal(got, want) {
		t.Errorf("strangers = %v, want %v", got, want)
	}
}

// disappearMsg is the CreatureDisappear of id, for why.
func disappearMsg(id uint32, why pb.DisappearReason) *pb.ServerMessage {
	return &pb.ServerMessage{Message: &pb.ServerMessage_CreatureDisappear{CreatureDisappear: &pb.CreatureDisappear{Id: id, Reason: why}}}
}

// A melee round of a player and the blow a monster answers with go, as CreatureAttack,
// to the attacker, the target and whoever sees them, before the hit's effect; a client
// out of the window gets nothing. The Welcome says the server sends them.
func TestAttackEventsMelee(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{targetDummyDef()}, spawnAt("dummy", 20, 20, 0, 60))
	cl, p := h.join("Hunter", at(21, 20))
	ocl, _ := h.join("Watcher", at(25, 23))
	fcl, _ := h.join("Far", at(50, 20)) // 29 tiles away: out of the window
	d := onlyMonster(t, h)
	if w := find(cl.take(), (*pb.ServerMessage).GetWelcome); len(w) != 1 || !w[0].GetAttackEvents() {
		t.Fatalf("Welcome = %v, want attack_events", w)
	}
	cl.batches, ocl.batches = nil, nil
	h.input(cl, setTarget(d.ID()))
	h.sim.RunTicks(45) // the first round and the answer
	attackFirst(t, ocl, p.ID(), pos(20, 20))
	attackFirst(t, ocl, d.ID(), pos(21, 20))
	own, evs := cl.take(), ocl.take()
	wantAttack(t, "attacker", own, p.ID(), melee, d.ID(), pos(20, 20), 0)
	wantAttack(t, "attacker", own, d.ID(), melee, p.ID(), pos(21, 20), 0)
	wantAttack(t, "watcher", evs, p.ID(), melee, d.ID(), pos(20, 20), 0)
	wantAttack(t, "watcher", evs, d.ID(), melee, p.ID(), pos(21, 20), 0)
	if got := find(fcl.take(), (*pb.ServerMessage).GetCreatureAttack); len(got) != 0 {
		t.Errorf("a client out of the window got %v", got)
	}
}

// A blow from the edge of a client's window (its margin) at a creature just beyond it:
// the side of the target is the attacker's own tile, and the client still gets the
// attack, without a target, on that tile (it plays it where the attacker faces; a
// monster turns to its target before it strikes). A Projectile drops that case (it
// would fly nowhere); a swing still shows.
func TestAttackEventsMeleeAtTheEdge(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{targetDummyDef()}, spawnAt("dummy", 10+session.ViewHalfW, 10, 0, 60))
	cl, p := h.join("Hunter", at(11+session.ViewHalfW, 10))
	ecl, _ := h.join("Edge", at(10, 10)) // sees the dummy on its margin, not the hunter
	d := onlyMonster(t, h)
	ecl.take()
	h.input(cl, setTarget(d.ID()))
	h.sim.RunTicks(45) // the first round and the answer
	if d.Pos() != pos(10+session.ViewHalfW, 10) || p.Pos() != pos(11+session.ViewHalfW, 10) {
		t.Fatalf("they moved: dummy %v, hunter %v", d.Pos(), p.Pos())
	}
	evs := ecl.take()
	wantAttack(t, "edge", evs, d.ID(), melee, 0, d.Pos(), 0)
	if got := attacksBy(evs, p.ID()); len(got) != 0 {
		t.Errorf("edge: got the attacks of a player beyond its window: %v", got)
	}
}

// Shots: a bow and a wand of a player and the distance attack and spell of a monster are
// RANGED or SPELL attacks before their projectile. A client that sees the shooter but not
// its target gets only the side of the target (the edge of its window), never its id or
// tile.
func TestAttackEventsRanged(t *testing.T) {
	t.Run("bow", func(t *testing.T) {
		h := rangedHarness(t, worldtest.Open(t, 0, 0, 64, 32), spawnAt("dummy", 34, 10, 0, 60))
		cl, p := ranger(t, h, pos(30, 10), 10)
		ncl, _ := h.join("Near", at(28, 12))
		ecl, _ := h.join("Edge", at(16, 10)) // sees the archer (14 tiles), not the dummy (18)
		d := h.dummy()
		ncl.batches, ecl.batches = nil, nil
		h.input(cl, setTarget(d.ID()))
		h.sim.RunTicks(2) // one shot
		attackFirst(t, ncl, p.ID(), pos(34, 10))
		wantAttack(t, "near", ncl.take(), p.ID(), ranged, d.ID(), pos(34, 10), 0)
		evs := ecl.take()
		wantAttack(t, "edge", evs, p.ID(), ranged, 0, pos(32, 10), 0)
		for _, a := range find(evs, (*pb.ServerMessage).GetCreatureAttack) {
			if a.GetTargetId() == d.ID() || samePos(a.GetTo(), pos(34, 10)) {
				t.Errorf("edge: the attack gives the target away: %v", a)
			}
		}
		if pr := find(evs, (*pb.ServerMessage).GetProjectile); len(pr) != 1 || !samePos(pr[0].GetTo(), pos(32, 10)) {
			t.Errorf("edge: projectiles %v, want one to the edge (32,10) like the attack", pr)
		}
	})
	t.Run("wand", func(t *testing.T) {
		h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 13, 10, 0, 60))
		cl, p := arcanist(t, h, pos(10, 10))
		p.EquipForTest(testItems()["test_energy_wand"], nil)
		d := h.dummy()
		h.input(cl, setTarget(d.ID()))
		h.sim.RunTicks(2)
		attackFirst(t, cl, p.ID(), pos(13, 10))
		wantAttack(t, "wand", cl.take(), p.ID(), ranged, d.ID(), pos(13, 10), 0)
	})
	t.Run("monster", func(t *testing.T) {
		caster := &content.Monster{ID: "caster", Health: 1000, Speed: 100,
			Behavior: content.MonsterBehavior{Aggressive: true, TargetDistance: 3},
			Attacks: []content.MonsterAttack{
				{Type: "distance", Element: "earth", Min: 1, Max: 1, IntervalMs: 2000, Chance: 1, Range: 3},
				{Type: "spell", Element: "death", Min: 1, Max: 1, IntervalMs: 2000, Chance: 1, Range: 3},
			},
		}
		m := worldtest.Open(t, 0, 0, 32, 32)
		m.Islands()[0].Spawns = []world.Spawn{spawnAt("caster", 13, 10, 0, 60)}
		h := newHarness(t, m, func(cfg *session.Config) {
			cfg.Monsters = content.Monsters{"caster": caster}
			cfg.Items = testItems()
		})
		cl, p := h.join("Target", at(10, 10))
		ocl, _ := h.join("Watcher", at(13, 18)) // in view, out of the caster's sight
		h.sim.RunTicks(10)
		mo := onlyMonster(t, h)
		attackFirst(t, cl, mo.ID(), pos(10, 10))
		for who, evs := range map[string][]*pb.ServerMessage{"target": cl.take(), "watcher": ocl.take()} {
			wantAttack(t, who, evs, mo.ID(), ranged, p.ID(), pos(10, 10), 0)
			wantAttack(t, who, evs, mo.ID(), spell, p.ID(), pos(10, 10), 0)
		}
	})
}

// Spells: a bolt is a SPELL attack on its target before its projectile; an area spell is
// a SPELL attack without a target, centred on the caster with its radius, before the
// effects on its tiles.
func TestAttackEventsSpells(t *testing.T) {
	h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 13, 10, 0, 60))
	cl, p := arcanist(t, h, pos(10, 10))
	ocl, _ := h.join("Watcher", at(12, 14))
	d := h.dummy()
	ocl.batches = nil
	h.input(cl, castAt("test_bolt", d.ID()))
	h.sim.Step()
	attackFirst(t, ocl, p.ID(), pos(13, 10))
	wantAttack(t, "bolt", ocl.take(), p.ID(), spell, d.ID(), pos(13, 10), 0)

	h.sim.RunTicks(20) // the attack group's cooldown
	h.input(cl, cast("test_ring"))
	h.sim.Step()
	attackFirst(t, ocl, p.ID(), pos(10, 10))
	evs := ocl.take()
	wantAttack(t, "area", evs, p.ID(), spell, 0, pos(10, 10), 2)
	if n := len(attacksBy(evs, p.ID())); n != 1 {
		t.Errorf("area spell: %d attacks, want one for the cast (not one per creature hit)", n)
	}
}

// The other ways to attack go through playerAttack too: a rune (its spell, from an item)
// and a condition spell at a monster are SPELL attacks before their projectile.
func TestAttackEventsRuneAndConditionSpell(t *testing.T) {
	t.Run("rune", func(t *testing.T) {
		h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 13, 10, 0, 60))
		cl, p := arcanist(t, h, pos(10, 10))
		ocl, _ := h.join("Watcher", at(12, 14))
		d := h.dummy()
		pack := openPack(t, h, cl)
		h.castNow(cl, cast("test_conjure"))
		h.sim.RunTicks(20) // the support group's cooldown
		ocl.take()
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
			From: inContainer(pack, 0), ItemId: runeID,
			To: &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: d.ID()}}}}})
		h.sim.Step()
		if h.w.MonsterHealth(d) == 1000 {
			t.Fatal("the rune did not hit")
		}
		attackFirst(t, ocl, p.ID(), pos(13, 10))
		wantAttack(t, "watcher", ocl.take(), p.ID(), spell, d.ID(), pos(13, 10), 0)
	})
	t.Run("condition spell", func(t *testing.T) {
		h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(targetDummyDef(), 13, 10))
		cl, p := h.join("Binder", at(10, 10))
		ocl, _ := h.join("Watcher", at(12, 14))
		d := h.dummy()
		ocl.take()
		h.castNow(cl, castAt("root", d.ID()))
		attackFirst(t, ocl, p.ID(), pos(13, 10))
		wantAttack(t, "watcher", ocl.take(), p.ID(), spell, d.ID(), pos(13, 10), 0)
	})
}

// PvP (T5.2): a bolt, a wand and a bow at a player are SPELL and RANGED attacks on it,
// for the victim and whoever sees them, before their projectile. (Condition spells at a
// player: TestPvPConditionSpellRules.)
func TestAttackEventsAtPlayers(t *testing.T) {
	type shooter struct {
		name  string
		kind  pb.AttackKind
		setup func(*session.Character)
		start func(g *pvpWorld, cl *fakeClient, v *session.Player)
	}
	arcanistOf := func(c *session.Character) { c.Vocation, c.Mana = "arcanist", arcanistMax }
	fight := func(g *pvpWorld, cl *fakeClient, v *session.Player) { g.input(cl, setTarget(v.ID())) }
	for _, sh := range []shooter{
		{name: "bolt", kind: spell, setup: arcanistOf,
			start: func(g *pvpWorld, cl *fakeClient, v *session.Player) { g.input(cl, castAt("test_bolt", v.ID())) }},
		{name: "wand", kind: ranged, setup: arcanistOf, start: fight},
		{name: "bow", kind: ranged, start: fight, setup: func(c *session.Character) {
			c.Vocation = "ranger"
			c.Inventory = append(c.Inventory, session.ItemState{ItemID: bowID, Count: 1, Slot: int(slotRight)},
				session.ItemState{ItemID: arrowID, Count: 10, Slot: int(slotAmmo)})
		}},
	} {
		t.Run(sh.name, func(t *testing.T) {
			g := newPvP(t, nil, func(c *session.Config) {
				c.Balance.Skills.Base["distance"] = content.SkillBase{StartLevel: 10, BaseTries: 1000}
				c.Balance.Combat.WandMinFactor = 1 // wand hits are exact
			})
			ca, a := g.fighter("Ana", 0, 20, 20, 30, 0, sh.setup)
			if sh.name == "wand" {
				a.EquipForTest(testItems()["test_energy_wand"], nil)
			}
			cb, b := g.fighter("Bea", 0, 23, 20, 30, 0)
			co, _ := g.fighter("Cid", 0, 21, 24, 30, 0)
			g.unsafe(ca)
			cb.take()
			co.take()
			sh.start(g, ca, b)
			g.sim.RunTicks(2)
			if cur, mx := b.Health(); cur == mx {
				t.Fatalf("Bea was not hit (%v)", sysKeys(ca.take()))
			}
			attackFirst(t, co, a.ID(), b.Pos())
			wantAttack(t, "victim", cb.take(), a.ID(), sh.kind, b.ID(), b.Pos(), 0)
			wantAttack(t, "watcher", co.take(), a.ID(), sh.kind, b.ID(), b.Pos(), 0)
		})
	}
}

// PvP: a player's blow at another is a MELEE attack for the victim and whoever sees
// them; a player killed by one leaves its tile as a DEATH.
func TestAttackEventsPvP(t *testing.T) {
	g := newPvP(t, nil)
	acl, a := g.fighter("Attacker", 0, 20, 30, 20, session.RolePlayer)
	vcl, v := g.fighter("Victim", 0, 21, 30, 20, session.RolePlayer)
	ocl, _ := g.fighter("Watcher", 0, 24, 32, 20, session.RolePlayer)
	g.unsafe(acl)
	vcl.take()
	ocl.take()
	g.input(acl, setTarget(v.ID()))
	g.sim.RunTicks(2)
	wantAttack(t, "victim", vcl.take(), a.ID(), melee, v.ID(), pos(21, 30), 0)
	wantAttack(t, "watcher", ocl.take(), a.ID(), melee, v.ID(), pos(21, 30), 0)

	g.kill(a, v)
	wantGone(t, "watcher", ocl.take(), v.ID(), pb.DisappearReason_DISAPPEAR_REASON_DEATH)
	wantGone(t, "attacker", acl.take(), v.ID(), pb.DisappearReason_DISAPPEAR_REASON_DEATH)
}

// Every way out of the view carries its reason: a monster's death (after its empty health
// bar) and despawn, a player's death, logout, dropped connection, teleport and
// invisibility (as a teleport: nothing says it is still there), stairs (a teleport too:
// the step onto them is all the watcher sees) and walking out of view either way. (Out of
// a house: TestHouseDoorsGuestsAndExpel.)
func TestDisappearReasons(t *testing.T) {
	const (
		outOfView = pb.DisappearReason_DISAPPEAR_REASON_OUT_OF_VIEW
		death     = pb.DisappearReason_DISAPPEAR_REASON_DEATH
		despawn   = pb.DisappearReason_DISAPPEAR_REASON_DESPAWN
		teleport  = pb.DisappearReason_DISAPPEAR_REASON_TELEPORT
		logoutWhy = pb.DisappearReason_DISAPPEAR_REASON_LOGOUT
	)
	t.Run("monster death", func(t *testing.T) {
		fragile := &content.Monster{ID: "dummy", Health: 5, Speed: 100, Behavior: content.MonsterBehavior{TargetDistance: 1}}
		m := worldtest.Open(t, 0, 0, 32, 32)
		m.Islands()[0].Spawns = []world.Spawn{spawnAt("dummy", 13, 10, 0, 60)}
		h := newHarness(t, m, func(c *session.Config) {
			c.Monsters = content.Monsters{"dummy": fragile}
			c.Items = testItems()
			c.Spells = testSpells()
			c.Balance.Skills.Base["magic"] = content.SkillBase{StartLevel: 0, BaseTries: magicTries}
		})
		cl, _ := arcanist(t, h, pos(10, 10))
		ocl, _ := h.join("Watcher", at(12, 13))
		d := h.dummy()
		ocl.take()
		h.input(cl, castAt("test_bolt", d.ID()))
		h.sim.Step()
		if len(h.w.Monsters()) != 0 {
			t.Fatal("the bolt did not kill it")
		}
		evs := ocl.take()
		wantGone(t, "watcher", evs, d.ID(), death)
		health := -1
		for i, e := range evs {
			if e.GetCreatureHealth().GetId() == d.ID() && e.GetCreatureHealth().GetHealthPercent() == 0 {
				health = i
			}
			if e.GetCreatureDisappear().GetId() == d.ID() && (health < 0 || health > i) {
				t.Errorf("the death came before the empty health bar: %v", kinds(evs))
			}
		}
	})
	t.Run("despawn", func(t *testing.T) {
		h := monsterHarness(t, []*content.Monster{targetDummyDef()}, spawnAt("dummy", 20, 20, 0, 60))
		ocl, _ := h.join("Watcher", at(22, 22))
		d := onlyMonster(t, h)
		ocl.take()
		h.do(func(*game.TickContext) { h.w.DespawnForTest(d) })
		wantGone(t, "watcher", ocl.take(), d.ID(), despawn)
	})
	t.Run("players", func(t *testing.T) {
		h := condHarness(t, worldtest.Open(t, 0, 0, 64, 64))
		ocl, _ := h.join("Watcher", at(30, 30))
		dcl, dead := h.join("Dead", at(31, 30))
		_, telep := h.join("Traveller", at(32, 30))
		_, ghost := h.join("Ghost", at(33, 30))
		lcl, quit := h.join("Quitter", at(30, 31))
		ccl, cut := h.join("Cut", at(31, 31))
		ocl.take()
		dcl.take()
		h.do(func(ctx *game.TickContext) { h.w.DieForTest(ctx, dead) }) // the temple is (0, 0): far away
		h.do(func(*game.TickContext) { h.w.Teleport(telep, pos(2, 2)) })
		h.do(func(*game.TickContext) { h.w.SetInvisibleForTest(ghost, true) })
		h.input(lcl, logout())
		h.sim.Step()
		h.sim.Command(h.w.Leave(ccl))
		h.sim.Step()
		evs := ocl.take()
		wantGone(t, "watcher", evs, dead.ID(), death)
		wantGone(t, "watcher", evs, telep.ID(), teleport)
		wantGone(t, "watcher", evs, ghost.ID(), teleport)
		wantGone(t, "watcher", evs, quit.ID(), logoutWhy)
		wantGone(t, "watcher", evs, cut.ID(), logoutWhy)
		// The dead player's own client: what it knew is out of view (it moved away).
		wantGone(t, "dead", dcl.take(), quit.ID(), outOfView)
	})
	t.Run("stairs", func(t *testing.T) {
		h := portalHarness(t, 2)
		cl, p := h.join("Delver", at(5, 1))
		ocl, _ := h.join("Watcher", at(5, 5))
		h.sim.RunFor(time.Second)
		ocl.take()
		h.step(cl, S)
		if p.Pos().Z != 8 {
			t.Fatalf("the delver did not go down: %v", p.Pos())
		}
		wantGone(t, "watcher", ocl.take(), p.ID(), teleport)
	})
	t.Run("walking", func(t *testing.T) {
		h := newHarness(t, worldtest.Open(t, 0, 0, 64, 32))
		acl, a := h.join("Still", at(10, 10))
		bcl, b := h.join("Walker", at(26, 10)) // 16 tiles: the margin of the window
		acl.take()
		h.input(bcl, walk(E))
		h.sim.RunTicks(30)
		wantGone(t, "still", acl.take(), b.ID(), outOfView)
		h.input(bcl, walk(W))
		h.sim.RunTicks(30)
		if !a.Knows(b.ID()) {
			t.Fatal("the walker did not come back into view")
		}
		acl.take()
		bcl.take()
		h.input(acl, walk(W)) // now the other one walks away
		h.sim.RunTicks(30)
		wantGone(t, "still", acl.take(), b.ID(), outOfView)
		wantGone(t, "walker", bcl.take(), a.ID(), outOfView)
	})
}

// Invisibility (T3.2): an invisible player that attacks is shown (CreatureAppear) before
// its attack, so no client gets an attack by a creature it does not know; and a monster
// that sees invisible players and bites one is shown only to the bitten player's own
// client: a blow at its empty-looking tile would give it away.
func TestAttackEventsInvisible(t *testing.T) {
	t.Run("attacker", func(t *testing.T) {
		h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(targetDummyDef(), 13, 10))
		cl, p := h.join("Ghost", at(12, 10))
		ocl, _ := h.join("Watcher", at(14, 13))
		d := h.dummy()
		h.castNow(cl, cast("veil"))
		if !p.Invisible() || ocl.batches == nil {
			t.Fatal("the veil did not hide the player")
		}
		h.input(cl, setTarget(d.ID()))
		h.sim.Step()
		if p.Invisible() {
			t.Fatal("attacking did not end the invisibility")
		}
		if len(ocl.strangers) != 0 {
			t.Errorf("the watcher got an attack before p appeared again: %v", ocl.strangers)
		}
		wantAttack(t, "watcher", ocl.take(), p.ID(), melee, d.ID(), pos(13, 10), 0)
	})
	t.Run("target", func(t *testing.T) {
		bat := &content.Monster{ID: "bat", Health: 1000, Speed: 100,
			Behavior: content.MonsterBehavior{Aggressive: true, TargetDistance: 1, SeesInvisible: true},
			Attacks:  []content.MonsterAttack{{Type: "melee", Element: "physical", Min: 0, Max: 0, IntervalMs: 2000, Chance: 1}},
		}
		h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(bat, 14, 10))
		cl, p := h.join("Ghost", at(10, 10))
		ocl, _ := h.join("Watcher", at(10, 14))
		h.castNow(cl, cast("veil"))
		b := h.dummy()
		bitten := false
		h.sim.RunUntil(func() bool {
			bitten = bitten || len(attacksBy(cl.take(), b.ID())) > 0
			return bitten
		}, sim.MaxTicks(200))
		if !bitten || !p.Invisible() {
			t.Fatalf("the bat did not bite the invisible player (bitten %v, invisible %v)", bitten, p.Invisible())
		}
		h.sim.RunTicks(45) // another bite
		if got := attacksBy(ocl.take(), b.ID()); len(got) != 0 {
			t.Errorf("the watcher got the bites at the invisible player: %v", got)
		}
	})
}
