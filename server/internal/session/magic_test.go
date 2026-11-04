package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Magic scenarios (T1.9). The test spells have no spread, so every number is exact.

const (
	runeID      = 70
	energyWand  = 71
	magicTries  = 20 // magic level 0 → 1 costs 20 mana in these tests
	arcanistMax = 600
)

func init() {
	testItemDefs[runeID] = "{id: test_rune, kind: rune, weight: 100, rune: {spell: test_bolt, charges: 3, magic_level: 0}}"
	testItemDefs[energyWand] = "{id: test_energy_wand, kind: weapon, weight: 1500, weapon: {type: wand, attack: 10, range: 3, element: energy}}"
	testVocations["arcanist"] = content.Vocation{ID: "arcanist",
		Start:        content.VocationStats{Health: 140, Mana: arcanistMax, Capacity: 380000, Speed: 200},
		Regen:        content.Regen{Health: 1, Mana: 3, IntervalMs: 600000},
		SkillFactors: map[string]float64{"fist": 1.45, "magic": 1.1}}
}

func testSpells() content.Spells {
	dmg := func(el string, base float64, rng, radius int) *content.SpellDamage {
		return &content.SpellDamage{Scaling: content.Scaling{Base: base}, Element: el, Range: rng, Radius: radius}
	}
	arc := []string{"arcanist"}
	return content.Spells{
		"test_bolt": {ID: "test_bolt", Words: "test bolt", Vocations: arc, Level: 1, Mana: 10, Group: "attack",
			CooldownMs: 2000, GroupCooldownMs: 1000, Effect: content.SpellEffect{Damage: dmg("energy", 10, 4, 0)}},
		"test_ring": {ID: "test_ring", Words: "test ring", Vocations: arc, Level: 1, Mana: 20, Group: "attack",
			CooldownMs: 4000, GroupCooldownMs: 1000, Effect: content.SpellEffect{Damage: dmg("fire", 10, 0, 2)}},
		"test_heal": {ID: "test_heal", Words: "test heal", Vocations: arc, Level: 1, Mana: 5, Group: "healing",
			CooldownMs: 1000, GroupCooldownMs: 1000, Effect: content.SpellEffect{Heal: &content.SpellHeal{Scaling: content.Scaling{Base: 30}}}},
		"test_master": {ID: "test_master", Words: "test master", Vocations: arc, Level: 1, MagicLevel: 5, Mana: 1,
			Group: "support", Effect: content.SpellEffect{Heal: &content.SpellHeal{Scaling: content.Scaling{Base: 1}}}},
		"test_conjure": {ID: "test_conjure", Words: "test conjure", Vocations: arc, Level: 1, Mana: 30, Group: "support",
			CooldownMs: 1000, Effect: content.SpellEffect{Conjure: &content.SpellConjure{Item: "test_rune"}}},
	}
}

// targetDummyDef is a passive target with resistances: energy 50 %, fire weakness 20 %.
func targetDummyDef() *content.Monster {
	return &content.Monster{ID: "dummy", Health: 1000, Speed: 100,
		Behavior:    content.MonsterBehavior{TargetDistance: 1},
		Attacks:     []content.MonsterAttack{{Type: "melee", Element: "physical", IntervalMs: 2000, Chance: 1}},
		Resistances: map[string]int{"energy": 50, "fire": -20},
	}
}

// magicHarness is a world drawn by rows with the test spells and a dummy at each spawn.
func magicHarness(t *testing.T, m *world.Map, spawns ...world.Spawn) *harness {
	t.Helper()
	m.Islands()[0].Spawns = spawns
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"dummy": targetDummyDef()}
		c.Items = testItems()
		c.Spells = testSpells()
		c.Balance.Skills.Base["magic"] = content.SkillBase{StartLevel: 0, BaseTries: magicTries}
		c.Balance.Combat.WandMinFactor = 1 // wand hits are exact
	})
}

// arcanist joins an arcanist with full mana and a backpack at p. It does not target
// the monster (that would add melee hits): spells name their target.
func arcanist(t *testing.T, h *harness, p world.Pos) (*fakeClient, *session.Player) {
	t.Helper()
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: "Mage", Vocation: "arcanist", Level: 1,
		Health: 140, Mana: arcanistMax, HasPos: true, Pos: p,
		Inventory: []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack)}}}
	cl, pl := h.joinChar(c)
	h.sim.Step() // monsters spawn
	cl.take()
	return cl, pl
}

func cast(id string) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_CastSpell{CastSpell: &pb.CastSpell{Spell: &pb.CastSpell_SpellId{SpellId: id}}}}
}

// castAt casts id on creature target.
func castAt(id string, target uint32) *pb.ClientMessage {
	m := cast(id)
	m.GetCastSpell().Target = &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: target}}
	return m
}

func say(ch pb.ChatChannel, text string) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_Say{Say: &pb.Say{Channel: ch, Text: text}}}
}

func (h *harness) dummy() *session.Monster {
	h.t.Helper()
	ms := h.w.Monsters()
	if len(ms) != 1 {
		h.t.Fatalf("%d monsters, want 1", len(ms))
	}
	return ms[0]
}

// castNow sends m, runs one tick and returns the events.
func (h *harness) castNow(cl *fakeClient, m *pb.ClientMessage) []*pb.ServerMessage {
	h.input(cl, m)
	h.sim.Step()
	return cl.take()
}

// Own cooldown and group cooldown: a spell waits for both, other groups are free.
func TestSpellCooldowns(t *testing.T) {
	h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 13, 10, 0, 60))
	cl, p := arcanist(t, h, pos(10, 10))
	m := h.dummy()

	evs := h.castNow(cl, castAt("test_bolt", h.dummy().ID()))
	if got := h.w.MonsterHealth(m); got != 995 { // 10 energy − 50 %
		t.Fatalf("dummy health %d after a bolt, want 995 (messages %v)", got, systemKeys(evs))
	}
	cds := find(evs, (*pb.ServerMessage).GetSpellCooldown)
	if len(cds) != 1 || cds[0].GetCooldownMs() != 2000 || cds[0].GetGroupCooldownMs() != 1000 || cds[0].GetGroup() != "attack" {
		t.Fatalf("SpellCooldown = %v", cds)
	}
	if prj := find(evs, (*pb.ServerMessage).GetProjectile); len(prj) != 1 || prj[0].GetProjectileId() != session.ProjectileElementBase+3 {
		t.Errorf("projectiles %v, want one energy projectile", prj)
	}
	if h.w.Mana(p) != arcanistMax-10 {
		t.Errorf("mana %d", h.w.Mana(p))
	}

	// Same spell right away: blocked, nothing spent.
	if evs := h.castNow(cl, castAt("test_bolt", h.dummy().ID())); !hasKey(evs, "magic.not_ready") || h.w.MonsterHealth(m) != 995 {
		t.Fatalf("second bolt: health %d, messages %v", h.w.MonsterHealth(m), systemKeys(evs))
	}
	// Another group is not blocked.
	if evs := h.castNow(cl, cast("test_heal")); hasKey(evs, "magic.not_ready") || h.w.Mana(p) != arcanistMax-15 {
		t.Fatalf("heal during the attack cooldown: mana %d, messages %v", h.w.Mana(p), systemKeys(evs))
	}
	// Another attack spell waits for the group cooldown (1 s).
	if evs := h.castNow(cl, cast("test_ring")); !hasKey(evs, "magic.not_ready") {
		t.Fatalf("ring inside the group cooldown: %v", systemKeys(evs))
	}
	h.sim.RunTicks(20)
	cl.take()
	if evs := h.castNow(cl, cast("test_ring")); hasKey(evs, "magic.not_ready") || h.w.MonsterHealth(m) != 983 { // 10 fire + 20 %
		t.Fatalf("ring after the group cooldown: health %d, messages %v", h.w.MonsterHealth(m), systemKeys(evs))
	}
	// The bolt's own 2 s cooldown has not run out yet (the ring restarted the group's).
	h.sim.RunTicks(20)
	cl.take()
	if evs := h.castNow(cl, castAt("test_bolt", h.dummy().ID())); hasKey(evs, "magic.not_ready") || h.w.MonsterHealth(m) != 978 {
		t.Fatalf("bolt after its cooldown: health %d, messages %v", h.w.MonsterHealth(m), systemKeys(evs))
	}
}

// A wall between the caster and the target blocks a bolt (nothing is spent) and shields
// the monster from an area spell.
func TestSpellBlockedByWall(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"........",
		"........",
		"...#....",
		"........",
	)
	h := magicHarness(t, m, spawnAt("dummy", 4, 2, 0, 60))
	cl, p := arcanist(t, h, pos(2, 2))
	d := h.dummy()

	evs := h.castNow(cl, castAt("test_bolt", h.dummy().ID()))
	if !hasKey(evs, "magic.no_sight") || h.w.MonsterHealth(d) != 1000 || h.w.Mana(p) != arcanistMax {
		t.Fatalf("bolt through a wall: health %d, mana %d, messages %v", h.w.MonsterHealth(d), h.w.Mana(p), systemKeys(evs))
	}
	if len(find(evs, (*pb.ServerMessage).GetSpellCooldown)) != 0 || len(find(evs, (*pb.ServerMessage).GetProjectile)) != 0 {
		t.Errorf("a blocked bolt started a cooldown or flew")
	}
	evs = h.castNow(cl, cast("test_ring"))
	if h.w.MonsterHealth(d) != 1000 || h.w.Mana(p) != arcanistMax-20 {
		t.Fatalf("ring behind a wall: health %d, mana %d, messages %v", h.w.MonsterHealth(d), h.w.Mana(p), systemKeys(evs))
	}
	for _, e := range find(evs, (*pb.ServerMessage).GetEffect) {
		if e.GetPos().GetX() == 4 && e.GetPos().GetY() == 2 {
			t.Errorf("the ring drew an effect behind the wall")
		}
	}
}

// The magic level rises with the mana spent, not with the number of casts.
func TestMagicLevelRisesWithManaSpent(t *testing.T) {
	h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, p := arcanist(t, h, pos(10, 10))
	if lv := h.w.Skill(p, "magic").Level; lv != 0 {
		t.Fatalf("magic level %d at start", lv)
	}
	if evs := h.castNow(cl, cast("test_master")); !hasKey(evs, "magic.magic_level_required") {
		t.Fatalf("spell above the magic level: %v", systemKeys(evs))
	}
	var evs []*pb.ServerMessage
	for range 4 { // 4 heals × 5 mana = 20 tries
		evs = append(evs, h.castNow(cl, cast("test_heal"))...)
		h.sim.RunTicks(20)
		evs = append(evs, cl.take()...)
	}
	if s := h.w.Skill(p, "magic"); s.Level != 1 || s.Tries != 0 {
		t.Fatalf("magic after 20 mana = %+v, want level 1", s)
	}
	if !hasKey(evs, "progress.skill_up") {
		t.Errorf("no skill_up message: %v", systemKeys(evs))
	}
	if h.w.Mana(p) != arcanistMax-20 {
		t.Errorf("mana %d", h.w.Mana(p))
	}
}

// Resistances: energy −50 % and a fire weakness +20 % (exact with no spread), and the
// effect drawn on a magic hit is the element's.
func TestResistanceApplied(t *testing.T) {
	h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 12, 10, 0, 60))
	cl, _ := arcanist(t, h, pos(10, 10))
	d := h.dummy()
	evs := h.castNow(cl, castAt("test_bolt", h.dummy().ID()))
	if got := h.w.MonsterHealth(d); got != 995 {
		t.Fatalf("energy bolt: health %d, want 995", got)
	}
	hasEffect := func(evs []*pb.ServerMessage, id uint32) bool {
		for _, e := range find(evs, (*pb.ServerMessage).GetEffect) {
			if e.GetEffectId() == id {
				return true
			}
		}
		return false
	}
	if !hasEffect(evs, session.EffectElementBase+3) {
		t.Errorf("no energy effect on the hit")
	}
	h.sim.RunTicks(20)
	cl.take()
	evs = h.castNow(cl, cast("test_ring"))
	if got := h.w.MonsterHealth(d); got != 983 {
		t.Fatalf("fire ring: health %d, want 983", got)
	}
	if !hasEffect(evs, session.EffectElementBase+1) {
		t.Errorf("no fire effect")
	}
}

// Words said on the say channel cast (any case and spacing); other channels do not.
func TestSayCastsSpell(t *testing.T) {
	h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, p := arcanist(t, h, pos(10, 10))
	h.castNow(cl, say(pb.ChatChannel_CHAT_CHANNEL_YELL, "test heal"))
	if h.w.Mana(p) != arcanistMax {
		t.Fatalf("yelling the words cast the spell")
	}
	h.castNow(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "  Test   HEAL "))
	if h.w.Mana(p) != arcanistMax-5 {
		t.Fatalf("saying the words did not cast: mana %d", h.w.Mana(p))
	}
	// A guardian knows no arcanist spell.
	gcl, _ := h.join("Guard", at(14, 14))
	gcl.take()
	if evs := h.castNow(gcl, cast("test_heal")); !hasKey(evs, "magic.vocation") {
		t.Errorf("guardian cast: %v", systemKeys(evs))
	}
}

// Conjuring puts a rune with all its charges in the backpack; each use on the target
// casts the rune's spell for free and spends a charge, and the last one removes it.
func TestConjureAndUseRune(t *testing.T) {
	h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 12, 10, 0, 60))
	cl, p := arcanist(t, h, pos(10, 10))
	d := h.dummy()
	pack := openPack(t, h, cl)
	evs := h.castNow(cl, cast("test_conjure"))
	bp := p.Equipped(slotBackpack)
	if len(bp.Items()) != 1 || bp.Items()[0].Count() != 3 || !hasKey(evs, "magic.conjured") {
		t.Fatalf("backpack %v, messages %v", bp.Items(), systemKeys(evs))
	}
	if ups := find(evs, (*pb.ServerMessage).GetContainerUpdate); len(ups) != 1 || ups[0].GetItems()[0].GetCount() != 3 {
		t.Fatalf("ContainerUpdate = %v", ups)
	}
	mana := h.w.Mana(p)
	useOn := func() []*pb.ServerMessage {
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
			From: inContainer(pack, 0), ItemId: runeID,
			To: &pb.ActionTarget{Target: &pb.ActionTarget_CreatureId{CreatureId: d.ID()}}}}})
		h.sim.Step()
		evs := cl.take()
		h.sim.RunTicks(20) // group cooldown
		return append(evs, cl.take()...)
	}
	for i := range 3 {
		evs := useOn()
		if want := 1000 - 5*(i+1); h.w.MonsterHealth(d) != want {
			t.Fatalf("use %d: health %d, want %d (messages %v)", i+1, h.w.MonsterHealth(d), want, systemKeys(evs))
		}
	}
	if h.w.Mana(p) != mana {
		t.Errorf("runes spent mana: %d → %d", mana, h.w.Mana(p))
	}
	if len(bp.Items()) != 0 {
		t.Fatalf("rune with no charges left is still there: %v", bp.Items())
	}
}

// A wand shoots its element at range in line of sight, every attack round.
func TestWandShootsAtRange(t *testing.T) {
	h := magicHarness(t, worldtest.Open(t, 0, 0, 32, 32), spawnAt("dummy", 13, 10, 0, 60))
	cl, p := arcanist(t, h, pos(10, 10))
	p.EquipForTest(testItems()["test_energy_wand"], nil)
	d := h.dummy()
	h.input(cl, setTarget(d.ID()))
	h.sim.RunTicks(41)
	evs := cl.take()
	if got := h.w.MonsterHealth(d); got != 1000-5*2 { // two rounds of 10 energy − 50 %
		t.Fatalf("dummy health %d after 2 s of wand shots", got)
	}
	if len(find(evs, (*pb.ServerMessage).GetProjectile)) == 0 {
		t.Errorf("no projectiles")
	}
}

// A monster's distance attack flies at range with a projectile, but not through a wall.
func TestMonsterDistanceAttackNeedsSight(t *testing.T) {
	archer := &content.Monster{ID: "archer", Health: 1000, Speed: 100,
		Behavior: content.MonsterBehavior{Aggressive: true, TargetDistance: 3},
		Attacks:  []content.MonsterAttack{{Type: "distance", Element: "earth", Min: 5, Max: 5, IntervalMs: 2000, Chance: 1, Range: 3}},
	}
	for _, c := range []struct {
		name string
		rows []string
		hit  bool
	}{
		{"open", []string{".......", ".......", "......."}, true},
		{"wall", []string{".......", "...#...", "......."}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := worldtest.Map(t, 0, 0, 7, c.rows...)
			m.Islands()[0].Spawns = []world.Spawn{spawnAt("archer", 5, 1, 0, 60)}
			h := newHarness(t, m, func(cfg *session.Config) {
				cfg.Monsters = content.Monsters{"archer": archer}
				cfg.Items = testItems()
			})
			cl, p := h.join("Target", at(2, 1))
			h.sim.RunTicks(10)
			evs := cl.take()
			hp, _ := p.Health()
			if got := hp < 145; got != c.hit {
				t.Fatalf("hit = %v (health %d), want %v", got, hp, c.hit)
			}
			if got := len(find(evs, (*pb.ServerMessage).GetProjectile)) > 0; got != c.hit {
				t.Errorf("projectile = %v, want %v", got, c.hit)
			}
		})
	}
}
