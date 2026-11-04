package session_test

import (
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Conditions (T3.2). Test numbers: every damage condition hits once a second (20
// ticks), so a scenario counts hits by whole seconds.

const condSecond = 20 // ticks

func testConditions() content.ConditionDefs {
	return content.ConditionDefs{
		"poison":    {ID: "poison", Kind: content.ConditionDamage, Element: "earth", IntervalMs: 1000, MaxTicks: 6, Stacking: content.StackAdd, Persists: true},
		"burning":   {ID: "burning", Kind: content.ConditionDamage, Element: "fire", IntervalMs: 1000, MaxTicks: 4, Stacking: content.StackRefresh, Persists: true},
		"shocked":   {ID: "shocked", Kind: content.ConditionDamage, Element: "energy", IntervalMs: 1000, MaxTicks: 4, Stacking: content.StackRefresh},
		"slowed":    {ID: "slowed", Kind: content.ConditionSpeed, SpeedPct: -50, MaxMs: 10000, Stacking: content.StackRefresh, Cancels: []string{"hasted"}, Persists: true},
		"hasted":    {ID: "hasted", Kind: content.ConditionSpeed, SpeedPct: 100, MaxMs: 10000, Stacking: content.StackAdd, Cancels: []string{"slowed"}},
		"invisible": {ID: "invisible", Kind: content.ConditionInvisible, MaxMs: 10000, Stacking: content.StackRefresh},
		"keen_eye":  {ID: "keen_eye", Kind: content.ConditionSkill, Skill: "sword", Amount: 5, MaxMs: 10000, Stacking: content.StackRefresh},
	}
}

func condSpells() content.Spells {
	all := []string{"guardian", "arcanist"}
	spell := func(id string, e content.SpellEffect) *content.Spell {
		return &content.Spell{ID: id, Words: "test " + id, Vocations: all, Level: 1, Mana: 1, Group: "support", Effect: e}
	}
	ss := testSpells()
	for _, s := range []*content.Spell{
		spell("haste", content.SpellEffect{Condition: &content.ConditionApply{ID: "hasted", DurationMs: 4000}}),
		spell("veil", content.SpellEffect{Condition: &content.ConditionApply{ID: "invisible", DurationMs: 8000}}),
		spell("root", content.SpellEffect{Condition: &content.ConditionApply{ID: "slowed", DurationMs: 3000, Range: 4}}),
		spell("purge", content.SpellEffect{Cure: []string{"poison"}}),
		spell("aim", content.SpellEffect{Condition: &content.ConditionApply{ID: "keen_eye", DurationMs: 3000}}),
	} {
		ss[s.ID] = s
	}
	return ss
}

// condHarness is magicHarness with the test conditions and condition spells.
func condHarness(t *testing.T, m *world.Map, opts ...option) *harness {
	t.Helper()
	opts = append([]option{func(c *session.Config) {
		c.Balance.Conditions = testConditions()
		c.Spells = condSpells()
	}}, opts...)
	return newHarness(t, m, append([]option{func(c *session.Config) {
		c.Items = testItems()
		c.Balance.Skills.Base["magic"] = content.SkillBase{StartLevel: 0, BaseTries: magicTries}
	}}, opts...)...)
}

// withMonster adds kind def with one spawn of it at (x, y).
func withMonster(def *content.Monster, x, y int) option {
	return func(c *session.Config) {
		c.Map.Islands()[0].Spawns = []world.Spawn{spawnAt(def.ID, x, y, 0, 60)}
		c.Monsters = content.Monsters{def.ID: def}
	}
}

// apply runs a command that gives p (or m) the condition and steps one tick.
func (h *harness) apply(p *session.Player, m *session.Monster, a content.ConditionApply) bool {
	h.t.Helper()
	ok := false
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) { ok = h.w.ApplyConditionForTest(ctx, p, m, &a, 0) }))
	h.sim.Step()
	return ok
}

// lastConditions returns the ids of the last PlayerConditions in evs (nil if none).
func lastConditions(evs []*pb.ServerMessage) ([]string, bool) {
	all := find(evs, (*pb.ServerMessage).GetPlayerConditions)
	if len(all) == 0 {
		return nil, false
	}
	var ids []string
	for _, c := range all[len(all)-1].GetConditions() {
		ids = append(ids, c.GetConditionId())
	}
	return ids, true
}

// Poison hits every interval for its ticks with the element effect, then ends; the
// client gets its list at each change.
func TestPoisonHitsUntilItEnds(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, p := h.join("Ana", at(10, 10))
	ocl, _ := h.join("Obs", at(12, 10))
	cl.take()
	ocl.take()

	h.apply(p, nil, content.ConditionApply{ID: "poison", Ticks: 3, Damage: 7})
	evs := cl.take()
	if ids, ok := lastConditions(evs); !ok || !slices.Equal(ids, []string{"poison"}) {
		t.Fatalf("conditions after poisoning = %v (sent %v)", ids, ok)
	}
	pc := find(evs, (*pb.ServerMessage).GetPlayerConditions)[0].GetConditions()[0]
	if pc.GetTicks() != 3 || pc.GetRemainingMs() < 2900 || pc.GetRemainingMs() > 3000 {
		t.Errorf("active poison = %v, want 3 hits, ~3 s left", pc)
	}
	start, _ := p.Health()
	for hit := 1; hit <= 3; hit++ {
		h.sim.RunTicks(condSecond)
		if cur, _ := p.Health(); cur != start-7*hit {
			t.Fatalf("health %d after %d hits, want %d", cur, hit, start-7*hit)
		}
	}
	evs = cl.take()
	if ids, ok := lastConditions(evs); !ok || len(ids) != 0 {
		t.Fatalf("conditions after the last hit = %v (sent %v), want an empty list", ids, ok)
	}
	// The observer saw each hit: the earth effect and the number.
	earth := uint32(session.EffectElementBase + 4)
	hits := 0
	for _, e := range find(ocl.take(), (*pb.ServerMessage).GetEffect) {
		if e.GetEffectId() == earth {
			hits++
		}
	}
	if hits != 3 {
		t.Errorf("observer saw %d earth hits, want 3", hits)
	}
	h.sim.RunTicks(3 * condSecond)
	if cur, _ := p.Health(); cur != start-21 {
		t.Errorf("health %d after the poison ended, want %d", cur, start-21)
	}
}

// Stacking: poison (add) sums the hits up to max_ticks and keeps the stronger damage;
// burning (refresh) keeps the most hits left.
func TestConditionStacking(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	_, p := h.join("Ana", at(10, 10))

	h.apply(p, nil, content.ConditionApply{ID: "poison", Ticks: 2, Damage: 3})
	h.apply(p, nil, content.ConditionApply{ID: "poison", Ticks: 3, Damage: 5})
	if got := h.w.ConditionsForTest(p)["poison"]; got != 5 {
		t.Fatalf("poison hits after adding 2+3 = %d, want 5", got)
	}
	h.apply(p, nil, content.ConditionApply{ID: "poison", Ticks: 4, Damage: 1})
	if got := h.w.ConditionsForTest(p)["poison"]; got != 6 {
		t.Fatalf("poison hits = %d, want max_ticks 6", got)
	}
	start, _ := p.Health()
	h.sim.RunTicks(condSecond)
	if cur, _ := p.Health(); start-cur != 5 {
		t.Errorf("poison hit %d, want the stronger 5", start-cur)
	}

	h.apply(p, nil, content.ConditionApply{ID: "burning", Ticks: 3, Damage: 2})
	h.apply(p, nil, content.ConditionApply{ID: "burning", Ticks: 2, Damage: 2})
	if got := h.w.ConditionsForTest(p)["burning"]; got != 3 {
		t.Errorf("burning hits after refresh 3 then 2 = %d, want 3", got)
	}
	h.apply(p, nil, content.ConditionApply{ID: "burning", Ticks: 9, Damage: 2})
	if got := h.w.ConditionsForTest(p)["burning"]; got != 4 {
		t.Errorf("burning hits = %d, want max_ticks 4", got)
	}
}

// A monster's resistance reduces each hit of a damage condition; 100 % is immunity.
// The player who applied it shares the experience.
func TestMonsterConditionResistance(t *testing.T) {
	def := targetDummyDef()
	def.Resistances = map[string]int{"earth": 50, "fire": 100}
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(def, 13, 10))
	h.join("Ana", at(10, 10))
	h.sim.Step()
	m := h.dummy()

	if h.apply(nil, m, content.ConditionApply{ID: "burning", Ticks: 3, Damage: 10}) {
		t.Fatal("a fire-immune monster took burning")
	}
	h.apply(nil, m, content.ConditionApply{ID: "poison", Ticks: 2, Damage: 10})
	h.sim.RunTicks(2 * condSecond)
	if got := h.w.MonsterHealth(m); got != 1000-10 {
		t.Fatalf("dummy health %d after two poison hits at 50 %%, want 990", got)
	}
	if c := m.MonsterConditionsForTest(); len(c) != 0 {
		t.Errorf("monster conditions after the end = %v", c)
	}
}

// A poisoning attack poisons when it hurts; the cure spell removes it.
func TestMonsterPoisonsAndCure(t *testing.T) {
	def := &content.Monster{ID: "spider", Health: 100, Speed: 100,
		Behavior: content.MonsterBehavior{Aggressive: true, TargetDistance: 1},
		Attacks: []content.MonsterAttack{{Type: "distance", Element: "earth", Min: 1, Max: 1, IntervalMs: 2000, Chance: 1, Range: 4,
			Condition: &content.ConditionApply{ID: "poison", Ticks: 4, Damage: 2}}},
	}
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(def, 13, 10))
	cl, p := h.join("Ana", at(10, 10))
	h.sim.RunUntil(func() bool { return h.w.ConditionsForTest(p)["poison"] > 0 }, sim.MaxTicks(200))
	if h.w.ConditionsForTest(p)["poison"] == 0 {
		t.Fatal("the spider did not poison")
	}
	cl.take()
	evs := h.castNow(cl, cast("purge"))
	if _, ok := h.w.ConditionsForTest(p)["poison"]; ok {
		t.Fatalf("poison after the cure (messages %v)", systemKeys(evs))
	}
	if ids, ok := lastConditions(cl.take()); ok && len(ids) != 0 {
		t.Errorf("conditions after cure = %v", ids)
	}
}

// Nothing to cure: refused, no mana spent.
func TestCureWithoutPoison(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, p := h.join("Ana", at(10, 10))
	h.apply(p, nil, content.ConditionApply{ID: "burning", Ticks: 2, Damage: 1})
	mana := h.w.Mana(p)
	if evs := h.castNow(cl, cast("purge")); !hasKey(evs, "magic.nothing_to_cure") || h.w.Mana(p) != mana {
		t.Errorf("cure without poison: messages %v, mana %d → %d", systemKeys(evs), mana, h.w.Mana(p))
	}
	if _, ok := h.w.ConditionsForTest(p)["burning"]; !ok {
		t.Error("the poison cure removed burning")
	}
}

// stepMs walks p one tile east and returns the step's duration.
func (h *harness) stepMs(cl *fakeClient, p *session.Player) uint32 {
	h.t.Helper()
	h.sim.RunUntil(func() bool { return !p.Walking() }, sim.MaxTicks(100))
	h.sim.RunTicks(40) // the previous step is over
	cl.take()
	h.input(cl, walk(E))
	h.sim.Step()
	for _, mv := range find(cl.take(), (*pb.ServerMessage).GetCreatureMove) {
		if mv.GetId() == p.ID() {
			return mv.GetDurationMs()
		}
	}
	h.t.Fatal("no step")
	return 0
}

// Haste and slow change the speed (stats, CreatureSpeed to observers) and with it the
// step duration; each cancels the other; at the end the speed is back to its base.
func TestHasteAndSlowSpeed(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 40, 32))
	cl, p := h.join("Ana", at(10, 10))
	ocl, _ := h.join("Obs", at(10, 12))
	base := p.Speed()
	normal := h.stepMs(cl, p)

	ocl.take()
	evs := h.castNow(cl, cast("haste"))
	if p.Speed() != 2*base {
		t.Fatalf("hasted speed %d, want %d", p.Speed(), 2*base)
	}
	if st := find(evs, (*pb.ServerMessage).GetPlayerStats); len(st) == 0 || st[len(st)-1].GetSpeed() != uint32(2*base) {
		t.Errorf("stats after haste = %v", st)
	}
	if sp := find(ocl.take(), (*pb.ServerMessage).GetCreatureSpeed); len(sp) != 1 || sp[0].GetSpeed() != uint32(2*base) {
		t.Errorf("observer CreatureSpeed = %v", sp)
	}
	if fast := h.stepMs(cl, p); fast >= normal {
		t.Errorf("hasted step %d ms, normal %d ms", fast, normal)
	}

	h.apply(p, nil, content.ConditionApply{ID: "slowed", DurationMs: 8000})
	if _, ok := h.w.ConditionsForTest(p)["hasted"]; ok || p.Speed() != base/2 {
		t.Fatalf("slowed after haste: speed %d, conditions %v", p.Speed(), h.w.ConditionsForTest(p))
	}
	if slow := h.stepMs(cl, p); slow <= normal {
		t.Errorf("slowed step %d ms, normal %d ms", slow, normal)
	}
	h.sim.RunTicks(8 * condSecond)
	if p.Speed() != base || len(h.w.ConditionsForTest(p)) != 0 {
		t.Errorf("after the slow: speed %d, conditions %v", p.Speed(), h.w.ConditionsForTest(p))
	}
}

// Haste stacks by adding time (the test's rule) up to max_ms.
func TestHasteAddsTime(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	_, p := h.join("Ana", at(10, 10))
	h.apply(p, nil, content.ConditionApply{ID: "hasted", DurationMs: 4000})
	h.apply(p, nil, content.ConditionApply{ID: "hasted", DurationMs: 4000})
	if left := h.w.ConditionsForTest(p)["hasted"]; left < 7800 || left > 8000 {
		t.Fatalf("haste left %d ms, want ~8000", left)
	}
	h.apply(p, nil, content.ConditionApply{ID: "hasted", DurationMs: 9000})
	if left := h.w.ConditionsForTest(p)["hasted"]; left > 10000 {
		t.Fatalf("haste left %d ms, more than max_ms", left)
	}
}

// A slowing spell aimed at a monster slows its steps.
func TestRootSlowsMonster(t *testing.T) {
	def := targetDummyDef()
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(def, 13, 10))
	cl, _ := arcanist(t, h, pos(10, 10))
	m := h.dummy()
	evs := h.castNow(cl, castAt("root", m.ID()))
	if m.Speed() != def.Speed/2 || !slices.Contains(m.MonsterConditionsForTest(), "slowed") {
		t.Fatalf("rooted monster speed %d (messages %v)", m.Speed(), systemKeys(evs))
	}
	if sp := find(evs, (*pb.ServerMessage).GetCreatureSpeed); len(sp) != 1 || sp[0].GetId() != m.ID() {
		t.Errorf("CreatureSpeed = %v", sp)
	}
	h.sim.RunTicks(4 * condSecond)
	if m.Speed() != def.Speed {
		t.Errorf("speed %d after the slow, want %d", m.Speed(), def.Speed)
	}
}

// keen_eye raises the combat skill while it lasts, not the trained one.
func TestSkillCondition(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, p := h.join("Ana", at(10, 10))
	base := h.w.Skill(p, "sword").Level
	h.castNow(cl, cast("aim"))
	if got := h.w.CombatSkillForTest(p, "sword"); got != base+5 {
		t.Fatalf("combat sword %d, want %d", got, base+5)
	}
	if h.w.Skill(p, "sword").Level != base {
		t.Errorf("trained sword changed")
	}
	h.sim.RunTicks(4 * condSecond)
	if got := h.w.CombatSkillForTest(p, "sword"); got != base {
		t.Errorf("combat sword %d after the end, want %d", got, base)
	}
}

// knows reports whether cl's player knows creature id, from what it received.
func knowsByEvents(evs []*pb.ServerMessage, id uint32) (appeared, disappeared, moved bool) {
	for _, e := range evs {
		switch {
		case e.GetCreatureAppear().GetCreature().GetId() == id:
			appeared = true
		case e.GetCreatureDisappear() != nil && e.GetCreatureDisappear().GetId() == id:
			disappeared = true
		case e.GetCreatureMove() != nil && e.GetCreatureMove().GetId() == id:
			moved = true
		}
		for _, a := range []*pb.MapArea{e.GetFullMapView().GetArea(), e.GetMapSlice().GetArea()} {
			for _, c := range a.GetCreatures() {
				if c.GetId() == id {
					appeared = true
				}
			}
		}
	}
	return
}

// Information audit (T4.1): an invisible player is never sent to the others. Those who
// saw it get CreatureDisappear; its steps, its hits and a player walking into view do
// not reveal it; its chat carries no position; at the end it appears again.
func TestInvisibilityIsFilteredByServer(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 60, 32))
	cl, p := h.join("Ghost", at(20, 10))
	ocl, o := h.join("Obs", at(22, 10))
	h.checkInvariants()
	cl.take()
	ocl.take()

	h.castNow(cl, cast("veil"))
	if !p.Invisible() {
		t.Fatal("not invisible after the spell")
	}
	if _, gone, _ := knowsByEvents(ocl.take(), p.ID()); !gone || o.Knows(p.ID()) {
		t.Fatalf("observer still knows the invisible player (disappear sent %v)", gone)
	}
	h.checkInvariants()

	// It walks, takes a poison hit and speaks: none of it shows its id or tile.
	h.input(cl, walk(N))
	h.apply(p, nil, content.ConditionApply{ID: "poison", Ticks: 1, Damage: 3})
	h.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "boo"))
	h.sim.RunTicks(2 * condSecond)
	evs := ocl.take()
	if app, _, moved := knowsByEvents(evs, p.ID()); app || moved {
		t.Fatalf("observer got the invisible player (appear %v, move %v)", app, moved)
	}
	for _, e := range evs {
		if hp := e.GetCreatureHealth(); hp != nil && hp.GetId() == p.ID() {
			t.Errorf("observer got the invisible player's health")
		}
		if e.GetEffect() != nil || e.GetFloatingText() != nil {
			t.Errorf("observer got an effect at the invisible player's tile: %v", e)
		}
		if m := e.GetChatMessage(); m != nil && (m.GetPos() != nil) {
			t.Errorf("chat of the invisible player carries its position %v", m.GetPos())
		}
	}
	if chats := find(evs, (*pb.ServerMessage).GetChatMessage); len(chats) != 1 {
		t.Errorf("observer heard %d messages, want the speech by name", len(chats))
	}
	// A player that walks into view (map slices) and one that logs in nearby (full view)
	// are not sent it either.
	ncl, _ := h.join("Late", at(30, 9))
	h.input(ncl, walkPath(W, W, W, W))
	h.sim.RunTicks(4 * condSecond)
	if app, _, _ := knowsByEvents(ncl.take(), p.ID()); app {
		t.Fatal("a player walking in got the invisible player")
	}
	h.checkInvariants()

	// The end: it appears to everyone who sees it.
	h.sim.RunTicks(4 * condSecond)
	if p.Invisible() {
		t.Fatal("still invisible after its duration")
	}
	if app, _, _ := knowsByEvents(ocl.take(), p.ID()); !app || !o.Knows(p.ID()) {
		t.Fatal("observer did not get it back")
	}
	h.checkInvariants()
}

// Casting any other spell ends the invisibility (T3.2 rule); monsters without
// sees_invisible neither pick nor keep an invisible target, those with it do.
func TestInvisibilityBreaksAndMonsters(t *testing.T) {
	def := &content.Monster{ID: "wolfish", Health: 100, Speed: 100,
		Behavior: content.MonsterBehavior{Aggressive: true, TargetDistance: 1},
		Attacks:  []content.MonsterAttack{{Type: "melee", Element: "physical", Min: 0, Max: 0, IntervalMs: 2000, Chance: 1}},
	}
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(def, 14, 10))
	cl, p := h.join("Ghost", at(10, 10))
	h.sim.RunUntil(func() bool { return h.dummy().TargetID() == p.ID() }, sim.MaxTicks(100))
	if h.dummy().TargetID() != p.ID() {
		t.Fatal("the monster did not target the player")
	}
	h.castNow(cl, cast("veil"))
	h.sim.RunTicks(10)
	if h.dummy().TargetID() != 0 {
		t.Fatal("the monster kept an invisible target")
	}
	h.sim.RunTicks(40)
	if h.dummy().TargetID() != 0 {
		t.Fatal("the monster picked an invisible target")
	}
	h.sim.RunTicks(condSecond) // support group cooldown
	h.castNow(cl, cast("haste"))
	if p.Invisible() {
		t.Fatal("casting did not end the invisibility")
	}

	h2 := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(&content.Monster{ID: "bat", Health: 100, Speed: 100,
		Behavior: content.MonsterBehavior{Aggressive: true, TargetDistance: 1, SeesInvisible: true},
		Attacks:  def.Attacks}, 14, 10))
	cl2, p2 := h2.join("Ghost", at(10, 10))
	h2.castNow(cl2, cast("veil"))
	h2.sim.RunUntil(func() bool { return h2.dummy().TargetID() == p2.ID() }, sim.MaxTicks(100))
	if h2.dummy().TargetID() != p2.ID() || !p2.Invisible() {
		t.Fatal("a monster that sees invisible did not target the invisible player")
	}
}

// Persistence: damage conditions and slowed survive a logout with their time left; haste
// and invisibility do not.
func TestConditionsPersist(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, p := h.join("Ana", at(10, 10))
	h.apply(p, nil, content.ConditionApply{ID: "poison", Ticks: 4, Damage: 3})
	h.apply(p, nil, content.ConditionApply{ID: "hasted", DurationMs: 4000})
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	s := h.saves[len(h.saves)-1]
	if !s.Final || len(s.Conditions) != 1 || s.Conditions[0].ID != "poison" || s.Conditions[0].Ticks != 4 || s.Conditions[0].Damage != 3 {
		t.Fatalf("final snapshot conditions = %+v", s.Conditions)
	}

	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: "Bea", Vocation: "guardian", Level: 1, Health: 145,
		HasPos: true, Pos: pos(10, 10), Conditions: []session.ConditionState{
			{ID: "poison", LeftMs: 500, Ticks: 2, Damage: 4},
			{ID: "slowed", LeftMs: 2000},
			{ID: "hasted", LeftMs: 2000}, // does not persist: dropped
			{ID: "gone", LeftMs: 2000},   // unknown: dropped
		}}
	bcl, b := h.joinChar(c)
	if ids, ok := lastConditions(bcl.take()); !ok || !slices.Equal(ids, []string{"poison", "slowed"}) {
		t.Fatalf("loaded conditions = %v", ids)
	}
	if b.Speed() >= 200 {
		t.Errorf("loaded slow did not apply: speed %d", b.Speed())
	}
	start, _ := b.Health()
	h.sim.RunTicks(10) // the first hit is due after the saved 500 ms
	if cur, _ := b.Health(); cur != start-4 {
		t.Errorf("health %d after the resumed hit, want %d", cur, start-4)
	}
}

// Death ends every condition.
func TestDeathClearsConditions(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	_, p := h.join("Ana", at(10, 10))
	h.apply(p, nil, content.ConditionApply{ID: "slowed", DurationMs: 5000})
	h.sim.Command(gameFunc(func() { p.SetHealthForTest(2) }))
	h.apply(p, nil, content.ConditionApply{ID: "poison", Ticks: 3, Damage: 5})
	h.sim.RunTicks(condSecond + 1)
	if len(h.w.ConditionsForTest(p)) != 0 || p.Speed() != 200 {
		t.Fatalf("after death: conditions %v, speed %d", h.w.ConditionsForTest(p), p.Speed())
	}
}

// Review findings: a recast while invisible and the experience of a kill by its poison
// reach only the invisible player's own client.
func TestInvisibleRecastAndExperienceStayHidden(t *testing.T) {
	def := targetDummyDef()
	def.Experience = 50
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32), withMonster(def, 13, 12))
	cl, p := h.join("Ghost", at(10, 10))
	ocl, _ := h.join("Obs", at(12, 10))
	h.sim.Step()
	m := h.dummy()
	h.castNow(cl, cast("veil"))
	ocl.take()

	h.castNow(cl, cast("veil")) // refresh while invisible
	if !p.Invisible() {
		t.Fatal("the recast ended the invisibility")
	}
	if evs := ocl.take(); len(find(evs, (*pb.ServerMessage).GetEffect)) != 0 {
		t.Fatalf("observer got the recast's effect: %v", kinds(evs))
	}

	// The invisible player's poison kills the monster: its experience text stays private.
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
		m.SetHealth(2)
		h.w.ApplyConditionForTest(ctx, nil, m, &content.ConditionApply{ID: "poison", Ticks: 2, Damage: 9}, p.ID())
	}))
	h.sim.RunTicks(condSecond + 2)
	if h.w.MonsterHealth(m) > 0 && len(h.w.Monsters()) == 1 {
		t.Fatal("the poison did not kill the monster")
	}
	if p.Experience() == 0 {
		t.Fatal("no experience for the poisoner")
	}
	for _, f := range find(ocl.take(), (*pb.ServerMessage).GetFloatingText) {
		if f.GetKind() == pb.FloatingTextKind_FLOATING_TEXT_KIND_EXPERIENCE {
			t.Fatalf("observer got the invisible player's experience at %v", f.GetPos())
		}
	}
	if xp := find(cl.take(), (*pb.ServerMessage).GetFloatingText); len(xp) == 0 {
		t.Error("the invisible player did not get its own experience text")
	}
}

// A quick relog (the final snapshot not acknowledged yet) restores the persisting
// conditions from memory; after a logout no condition event is left behind.
func TestConditionsQuickRelogAndLogout(t *testing.T) {
	h := condHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	pending := h.sim.Loop().Scheduler().Len()
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: "Ana", Vocation: "guardian", Level: 1, Health: 145,
		HasPos: true, Pos: pos(10, 10)}
	cl, p := h.joinChar(c)
	h.apply(p, nil, content.ConditionApply{ID: "poison", Ticks: 4, Damage: 2})
	h.apply(p, nil, content.ConditionApply{ID: "slowed", DurationMs: 5000})
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	if n := h.sim.Loop().Scheduler().Len(); n != pending {
		t.Fatalf("%d events pending after the logout, want %d", n, pending)
	}
	_, again := h.joinChar(c) // the row in the database would have no conditions
	got := h.w.ConditionsForTest(again)
	if got["poison"] != 4 || got["slowed"] == 0 || again.Speed() >= 200 {
		t.Fatalf("conditions after a quick relog = %v, speed %d", got, again.Speed())
	}
}
