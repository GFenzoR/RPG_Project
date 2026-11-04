package session_test

import (
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Ranger and druid scenarios (T3.1): bows with ammo, spells that scale with distance,
// healing another player and conjuring a stack of arrows.

const (
	bowID    = 72
	arrowID  = 73
	slotAmmo = pb.EquipmentSlot_EQUIPMENT_SLOT_AMMO
)

func init() {
	testItemDefs[bowID] = "{id: test_bow, kind: weapon, weight: 2600, weapon: {type: distance, attack: 2, range: 4, hands: 2, ammo: arrow}, requires: {vocations: [ranger]}}"
	testItemDefs[arrowID] = "{id: test_arrow, kind: ammo, weight: 70, stackable: true, max_stack: 100, ammo: {type: arrow, attack: 9}}"
	testVocations["ranger"] = content.Vocation{ID: "ranger",
		Start:        content.VocationStats{Health: 145, Mana: 400, Capacity: 400000, Speed: 200},
		Regen:        content.Regen{Health: 1, Mana: 1, IntervalMs: 600000},
		SkillFactors: map[string]float64{"distance": 1.1}, Weapons: []string{"distance"}}
	testVocations["druid"] = content.Vocation{ID: "druid",
		Start:        content.VocationStats{Health: 140, Mana: 400, Capacity: 380000, Speed: 200},
		Regen:        content.Regen{Health: 1, Mana: 1, IntervalMs: 600000},
		SkillFactors: map[string]float64{"magic": 1.1}}
}

func rangerSpells() content.Spells {
	ss := testSpells()
	ss["test_shot"] = &content.Spell{ID: "test_shot", Words: "test shot", Vocations: []string{"ranger"}, Level: 1, Mana: 10,
		Group: "attack", CooldownMs: 2000, Effect: content.SpellEffect{Damage: &content.SpellDamage{
			Scaling: content.Scaling{Base: 5, Skill: "distance", PerSkill: 2}, Element: "physical", Range: 4}}}
	ss["test_arrows"] = &content.Spell{ID: "test_arrows", Words: "test arrows", Vocations: []string{"ranger"}, Level: 1, Mana: 10,
		Group: "support", Effect: content.SpellEffect{Conjure: &content.SpellConjure{Item: "test_arrow", Count: 15}}}
	ss["test_mend"] = &content.Spell{ID: "test_mend", Words: "test mend", Vocations: []string{"druid"}, Level: 1, Mana: 20,
		Group: "healing", CooldownMs: 1000, Effect: content.SpellEffect{Heal: &content.SpellHeal{Scaling: content.Scaling{Base: 40}, Range: 3}}}
	return ss
}

func rangedHarness(t *testing.T, m *world.Map, spawns ...world.Spawn) *harness {
	t.Helper()
	m.Islands()[0].Spawns = spawns
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"dummy": targetDummyDef()}
		c.Items = testItems()
		c.Spells = rangerSpells()
		c.Balance.Skills.Base["magic"] = content.SkillBase{StartLevel: 0, BaseTries: magicTries}
		c.Balance.Skills.Base["distance"] = content.SkillBase{StartLevel: 10, BaseTries: 1000}
	})
}

// ranger joins a ranger at p with a bow and arrows arrows (none if 0) and a backpack.
func ranger(t *testing.T, h *harness, p world.Pos, arrows int, skills ...session.SkillState) (*fakeClient, *session.Player) {
	t.Helper()
	nextChar++
	inv := []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack)}, {ItemID: bowID, Count: 1, Slot: int(slotRight)}}
	if arrows > 0 {
		inv = append(inv, session.ItemState{ItemID: arrowID, Count: arrows, Slot: int(slotAmmo)})
	}
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: "Archer", Vocation: "ranger", Level: 1,
		Health: 145, Mana: 400, HasPos: true, Pos: p, Skills: skills, Inventory: inv}
	cl, pl := h.joinChar(c)
	h.sim.Step() // monsters spawn
	cl.take()
	return cl, pl
}

// A bow shoots its target at range every round: each shot spends one arrow from the ammo
// slot, flies as a projectile, trains distance and hurts the target.
func TestBowShootsArrowsAtRange(t *testing.T) {
	h := rangedHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 14, 10, 0, 60))
	cl, p := ranger(t, h, pos(10, 10), 10)
	d := h.dummy()
	h.input(cl, setTarget(d.ID()))
	h.sim.RunTicks(81) // shots at ticks 0, 40, 80
	evs := cl.take()
	if got := h.w.CountItem(p, "test_arrow"); got != 7 {
		t.Fatalf("%d arrows left after 3 shots, want 7", got)
	}
	if got := len(find(evs, (*pb.ServerMessage).GetProjectile)); got != 3 {
		t.Errorf("%d projectiles, want 3", got)
	}
	if got := h.w.Skill(p, "distance").Tries; got != 3 {
		t.Errorf("distance tries %d, want 3", got)
	}
	if h.w.MonsterHealth(d) >= 1000 {
		t.Errorf("3 arrows of up to 11 did no damage")
	}
	if p.Pos() != pos(10, 10) {
		t.Errorf("the ranger moved to %v: in range it shoots from where it stands", p.Pos())
	}
}

// The last arrow empties the ammo slot; with no ammo the bow does not shoot and the
// server says why.
func TestBowWithoutAmmo(t *testing.T) {
	h := rangedHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 13, 10, 0, 60))
	cl, p := ranger(t, h, pos(10, 10), 1)
	d := h.dummy()
	h.input(cl, setTarget(d.ID()))
	h.sim.RunTicks(81)
	evs := cl.take()
	if got := h.w.CountItem(p, "test_arrow"); got != 0 {
		t.Fatalf("%d arrows left, want 0", got)
	}
	if got := len(find(evs, (*pb.ServerMessage).GetProjectile)); got != 1 {
		t.Errorf("%d projectiles, want only the one arrow", got)
	}
	if !slices.Contains(sysKeys(evs), "combat.no_ammo") {
		t.Errorf("no combat.no_ammo message: %v", sysKeys(evs))
	}
	if got := h.w.Skill(p, "distance").Tries; got != 1 {
		t.Errorf("distance tries %d: only a real shot trains", got)
	}
}

// Range and line of sight are the server's: too far (without chasing) or behind a wall,
// no arrow leaves the quiver.
func TestBowRangeAndSight(t *testing.T) {
	for _, c := range []struct {
		name string
		rows []string
		x    int
	}{
		{"out of range", []string{"..........", "..........", ".........."}, 8},
		{"wall", []string{"..........", "...#......", ".........."}, 5},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := rangedHarness(t, worldtest.Map(t, 0, 0, 7, c.rows...), spawnAt("dummy", c.x, 1, 0, 60))
			cl, p := ranger(t, h, pos(1, 1), 10)
			h.input(cl, setTarget(h.dummy().ID()))
			h.sim.RunTicks(81)
			if got := h.w.CountItem(p, "test_arrow"); got != 10 {
				t.Fatalf("%d arrows left, want all 10", got)
			}
			if got := len(find(cl.take(), (*pb.ServerMessage).GetProjectile)); got != 0 {
				t.Errorf("%d projectiles, want 0", got)
			}
		})
	}
}

// A ranger spell adds per_skill for every level of its skill: 5 + 2 × distance.
func TestSpellScalesWithDistance(t *testing.T) {
	for _, c := range []struct {
		distance, want int
	}{{10, 25}, {30, 65}} {
		h := rangedHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 13, 10, 0, 60))
		cl, _ := ranger(t, h, pos(10, 10), 0, session.SkillState{ID: "distance", Level: c.distance})
		d := h.dummy()
		h.castNow(cl, castAt("test_shot", d.ID()))
		if got := 1000 - h.w.MonsterHealth(d); got != c.want {
			t.Errorf("distance %d: shot did %d, want %d", c.distance, got, c.want)
		}
	}
}

// Conjuring arrows puts one stack of count arrows in the backpack.
func TestConjureArrows(t *testing.T) {
	h := rangedHarness(t, worldtest.Open(t, 0, 0, 16, 16))
	cl, p := ranger(t, h, pos(5, 5), 0)
	h.castNow(cl, cast("test_arrows"))
	if got := h.w.CountItem(p, "test_arrow"); got != 15 {
		t.Fatalf("%d arrows after conjuring, want 15", got)
	}
	if got := h.w.Mana(p); got != 390 {
		t.Errorf("mana %d, want 390", got)
	}
}

func druid(h *harness, name string, p world.Pos) (*fakeClient, *session.Player) {
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: name, Vocation: "druid", Level: 1,
		Health: 140, Mana: 400, HasPos: true, Pos: p,
		Inventory: []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack)}}}
	return h.joinChar(c)
}

// Healing another player needs that player as the target, within range and in sight;
// a refused cast spends no mana. The healed player gets its new stats.
func TestHealOther(t *testing.T) {
	rows := []string{"..........", "......#...", ".........."}
	h := rangedHarness(t, worldtest.Map(t, 0, 0, 7, rows...))
	cl, caster := druid(h, "Healer", pos(1, 1))
	fcl, friend := druid(h, "Friend", pos(3, 1))
	_, far := druid(h, "Far", pos(6, 2)) // 5 tiles away, range 3
	_, beside := druid(h, "Beside", pos(4, 0))
	h.sim.Step()
	for _, p := range []*session.Player{caster, friend, far, beside} {
		p.SetHealthForTest(50)
	}
	cl.take()
	fcl.take()

	refused := []struct {
		name string
		msg  *pb.ClientMessage
		key  string
	}{
		{"no target", cast("test_mend"), "magic.no_target"},
		{"self", castAt("test_mend", caster.ID()), "magic.no_target"},
		{"out of range", castAt("test_mend", far.ID()), "magic.out_of_range"},
	}
	for _, c := range refused {
		evs := h.castNow(cl, c.msg)
		if keys := sysKeys(evs); !slices.Contains(keys, c.key) {
			t.Errorf("%s: messages %v, want %s", c.name, keys, c.key)
		}
	}
	if got := h.w.Mana(caster); got != 400 {
		t.Fatalf("refused casts spent mana: %d", got)
	}
	evs := h.castNow(cl, castAt("test_mend", friend.ID()))
	if hp, _ := friend.Health(); hp != 90 {
		t.Fatalf("friend health %d, want 50 + 40", hp)
	}
	if hp, _ := caster.Health(); hp != 50 {
		t.Errorf("the caster healed itself: %d", hp)
	}
	if h.w.Mana(caster) != 380 || len(find(evs, (*pb.ServerMessage).GetProjectile)) != 1 {
		t.Errorf("mana %d, projectiles %d", h.w.Mana(caster), len(find(evs, (*pb.ServerMessage).GetProjectile)))
	}
	if st := find(fcl.take(), (*pb.ServerMessage).GetPlayerStats); len(st) == 0 || st[len(st)-1].GetHealth() != 90 {
		t.Errorf("the friend got no stats with its new health: %v", st)
	}
	h.sim.RunTicks(20) // cooldown
	// By tile, a player next to a wall in sight.
	m := cast("test_mend")
	m.GetCastSpell().Target = &pb.ActionTarget{Target: &pb.ActionTarget_Pos{Pos: &pb.Position{X: 4, Y: 0, Z: 7}}}
	h.castNow(cl, m)
	if hp, _ := beside.Health(); hp != 90 {
		t.Errorf("heal by tile: health %d, want 90", hp)
	}
}

// A wall between the druid and its friend blocks the heal.
func TestHealOtherNeedsSight(t *testing.T) {
	h := rangedHarness(t, worldtest.Map(t, 0, 0, 7, ".....", ".#...", "....."))
	cl, caster := druid(h, "Healer", pos(0, 1))
	_, friend := druid(h, "Friend", pos(2, 1))
	h.sim.Step()
	friend.SetHealthForTest(50)
	cl.take()
	if keys := sysKeys(h.castNow(cl, castAt("test_mend", friend.ID()))); !slices.Contains(keys, "magic.no_sight") {
		t.Errorf("messages %v, want magic.no_sight", keys)
	}
	if hp, _ := friend.Health(); hp != 50 || h.w.Mana(caster) != 400 {
		t.Errorf("health %d, mana %d after a heal through a wall", hp, h.w.Mana(caster))
	}
}

// Arrows go only in the ammo slot, and a bow that requires the ranger is not for others.
func TestAmmoSlot(t *testing.T) {
	h := rangedHarness(t, worldtest.Open(t, 0, 0, 16, 16))
	cl, p := ranger(t, h, pos(5, 5), 0)
	h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["test_arrow"], 20, pos(5, 5)) }))
	h.sim.Step()
	cl.take()
	h.input(cl, moveItem(onTile(pos(5, 5)), arrowID, 1, inSlot(slotLeft), 20))
	h.sim.Step()
	if got := equipped(p)[slotLeft]; got != "" {
		t.Fatalf("arrows went to the left hand: %q", got)
	}
	h.input(cl, moveItem(onTile(pos(5, 5)), arrowID, 1, inSlot(slotAmmo), 20))
	h.sim.Step()
	if got := equipped(p)[slotAmmo]; got != "test_arrow" {
		t.Fatalf("ammo slot holds %q, want test_arrow", got)
	}

	gcl, g := h.join("Knight", at(7, 7)) // a guardian
	h.sim.Command(gameFunc(func() { h.w.DropForTest(testItems()["test_bow"], 1, pos(7, 7)) }))
	h.sim.Step()
	h.input(gcl, moveItem(onTile(pos(7, 7)), bowID, 1, inSlot(slotRight), 1))
	h.sim.Step()
	if got := equipped(g)[slotRight]; got != "" {
		t.Errorf("a guardian equipped the bow: %q", got)
	}
}
