package session_test

import (
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

const (
	corpseID = 47
	coinID   = 8
)

// testItemDefs are the items of the inventory tests, by numeric id.
var testItemDefs = map[uint16]string{
	corpseID: "{id: creature_remains, kind: container, pickupable: false, container: {slots: 10}}",
	coinID:   "{id: copper_coin, kind: currency, weight: 12, stackable: true, max_stack: 100}",
	swordID:  "{id: test_sword, kind: weapon, weight: 3300, weapon: {type: sword, attack: 13, defense: 9, hands: 1}}",
	axeID:    "{id: test_greataxe, kind: weapon, weight: 9000, weapon: {type: axe, attack: 20, hands: 2}}",
	shieldID: "{id: test_shield, kind: shield, weight: 5000, shield: {defense: 12}}",
	tunicID:  "{id: test_tunic, kind: armor, weight: 6000, armor: {slot: body, armor: 4}}",
	crownID:  "{id: test_crown, kind: armor, weight: 800, armor: {slot: head, armor: 2}, requires: {level: 20}}",
	wandID:   "{id: test_wand, kind: weapon, weight: 1500, weapon: {type: wand, attack: 13}, requires: {vocations: [arcanist]}}",
	packID:   "{id: backpack, kind: container, weight: 1650, container: {slots: 4}}",
	bagID:    "{id: test_bag, kind: container, weight: 500, container: {slots: 2}}",
	salveID:  "{id: test_salve, kind: consumable, weight: 300, stackable: true, max_stack: 100, consumable: {heal_hp: 40}}",
	anvilID:  "{id: test_anvil, kind: material, weight: 500000}",
	grassID:  "{id: grass, kind: ground}",
	waterID:  "{id: test_water, kind: ground, weight: 0}",
}

const (
	swordID  = 60
	axeID    = 61
	shieldID = 62
	tunicID  = 63
	crownID  = 64
	wandID   = 65
	packID   = 66
	bagID    = 67
	salveID  = 68
	anvilID  = 69
	waterID  = 90
	grassID  = worldtest.Grass
)

// testItems decodes testItemDefs (fixed, valid YAML: a decode error leaves a zero item).
func testItems() content.Items {
	out := content.Items{}
	for n, src := range testItemDefs {
		var it content.Item
		_ = yaml.Unmarshal([]byte(src), &it)
		it.Numeric = n
		out[it.ID] = &it
	}
	return out
}

func wolfDef() *content.Monster {
	return &content.Monster{ID: "wolf", Health: 25, Experience: 28, Speed: 190, Armor: 2, Defense: 5,
		Behavior: content.MonsterBehavior{Aggressive: true, FleeAtHealthPct: 10, TargetDistance: 1},
		Attacks:  []content.MonsterAttack{{Type: "melee", Element: "physical", Min: 0, Max: 16, IntervalMs: 2000, Chance: 1}},
		Loot:     []content.LootEntry{{Item: "copper_coin", Chance: 1, Count: []int{1, 8}}},
	}
}

// monsterHarness is a harness on an open 64x64 map with the given spawns.
func monsterHarness(t *testing.T, defs []*content.Monster, spawns ...world.Spawn) *harness {
	t.Helper()
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = spawns
	ms := content.Monsters{}
	for _, d := range defs {
		ms[d.ID] = d
	}
	return newHarness(t, m, func(c *session.Config) {
		c.Monsters = ms
		c.Items = testItems()
	})
}

func spawnAt(id string, x, y int, radius uint8, respawn uint32) world.Spawn {
	return world.Spawn{ID: id + "_spawn", Center: pos(x, y), Radius: radius, RespawnSeconds: respawn,
		Monsters: []world.SpawnMonster{{Monster: id, Count: 1}}}
}

func setTarget(id uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_SetTarget{SetTarget: &pb.SetTarget{CreatureId: id}}}
}

func fightMode(st pb.FightStance, chase bool) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_SetFightMode{SetFightMode: &pb.SetFightMode{Stance: st, Chase: chase}}}
}

func onlyMonster(t *testing.T, h *harness) *session.Monster {
	t.Helper()
	ms := h.w.Monsters()
	if len(ms) != 1 {
		t.Fatalf("tick %d: %d monsters, want 1", h.sim.Tick(), len(ms))
	}
	return ms[0]
}

// A wolf notices a player, chases and bites; the player fights back with its fists
// until the wolf dies: the player gets all the experience, the wolf leaves remains with
// its loot, and every client saw the fight.
func TestWolfDiesAndGivesExperience(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{wolfDef()}, spawnAt("wolf", 20, 20, 0, 60))
	cl, p := h.join("Hunter", at(24, 20))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	if wolf.Kind() != "wolf" || chebyshev(wolf.Pos(), pos(20, 20)) > 1 {
		t.Fatalf("wolf %s at %v", wolf.Kind(), wolf.Pos())
	}
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	h.input(cl, setTarget(wolf.ID()))
	sawChase, sawAttack, sawFlee := false, false, false
	h.sim.RunUntil(func() bool {
		if len(h.w.Monsters()) == 0 {
			return true
		}
		switch wolf.State() {
		case session.StateChase:
			sawChase = true
		case session.StateAttack:
			sawAttack = true
		case session.StateFlee:
			sawFlee = true
		}
		return false
	}, sim.MaxSeconds(120))
	h.sim.Step() // flush
	if !sawChase || !sawAttack {
		t.Errorf("states: chase %v attack %v flee %v", sawChase, sawAttack, sawFlee)
	}
	if p.Experience() != 28 {
		t.Errorf("experience = %d, want 28", p.Experience())
	}
	if p.Target() != 0 {
		t.Errorf("target = %d after the kill", p.Target())
	}
	evs := cl.take()
	var died world.Pos
	var corpses []*session.Corpse
	for _, tu := range find(evs, (*pb.ServerMessage).GetTileUpdate) {
		pp := tu.GetPos()
		q := world.Pos{X: uint16(pp.GetX()), Y: uint16(pp.GetY()), Z: uint8(pp.GetZ())}
		if c := h.w.CorpsesAt(q); len(c) > 0 {
			died, corpses = q, c
		}
		items := tu.GetTile().GetItems()
		if last := items[len(items)-1].GetItemId(); last != corpseID {
			t.Errorf("TileUpdate top item = %d, want remains %d", last, corpseID)
		}
	}
	if len(corpses) != 1 || len(corpses[0].Loot()) != 1 || corpses[0].Loot()[0].GetItemId() != coinID ||
		corpses[0].Loot()[0].GetCount() < 1 || corpses[0].Loot()[0].GetCount() > 8 {
		t.Fatalf("remains at %v: %+v", died, corpses)
	}
	var loot, xp, dmg, health, effects int
	for _, e := range evs {
		switch {
		case e.GetChatMessage().GetLocalized().GetKey() == "combat.loot":
			loot++
			ps := e.GetChatMessage().GetLocalized().GetParams()
			if ps[0].GetContentId() != "wolf" || ps[1].GetItem().GetItemId() != coinID {
				t.Errorf("loot params %v", ps)
			}
		case e.GetFloatingText().GetKind() == pb.FloatingTextKind_FLOATING_TEXT_KIND_EXPERIENCE:
			xp++
			if e.GetFloatingText().GetAmount() != 28 {
				t.Errorf("xp text %d", e.GetFloatingText().GetAmount())
			}
		case e.GetFloatingText().GetKind() == pb.FloatingTextKind_FLOATING_TEXT_KIND_DAMAGE:
			dmg++
		case e.GetCreatureHealth() != nil:
			health++
		case e.GetEffect() != nil:
			effects++
		}
	}
	if loot != 1 || xp != 1 || dmg == 0 || health == 0 || effects == 0 {
		t.Errorf("loot %d, xp %d, damage texts %d, health %d, effects %d", loot, xp, dmg, health, effects)
	}
	if len(find(evs, (*pb.ServerMessage).GetCreatureDisappear)) == 0 {
		t.Error("no CreatureDisappear for the dead wolf")
	}
	// The remains decay after monster_corpse_ms (60 s).
	h.sim.RunFor(61e9)
	if len(h.w.CorpsesAt(died)) != 0 {
		t.Error("remains did not decay")
	}
}

// A monster at its flee threshold runs away from its target instead of attacking.
func TestMonsterFleesWithLowHealth(t *testing.T) {
	def := wolfDef()
	def.Behavior.FleeAtHealthPct = 40
	h := monsterHarness(t, []*content.Monster{def}, spawnAt("wolf", 30, 30, 0, 60))
	_, p := h.join("Bait", at(31, 30))
	h.sim.RunTicks(3)
	wolf := onlyMonster(t, h)
	if wolf.TargetID() != p.ID() {
		t.Fatalf("wolf targets %d, want %d", wolf.TargetID(), p.ID())
	}
	h.sim.Command(gameFunc(func() { wolf.SetHealth(5) }))
	start := wolf.Pos()
	h.sim.RunFor(4e9)
	if wolf.State() != session.StateFlee {
		t.Fatalf("state = %v, want flee", wolf.State())
	}
	if d := max(abs(int(wolf.Pos().X)-int(p.Pos().X)), abs(int(wolf.Pos().Y)-int(p.Pos().Y))); d < 3 {
		t.Errorf("wolf at %v (from %v) is %d tiles from the player, want it to run away", wolf.Pos(), start, d)
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// A respawn waits while a player looks at the spawn tile, and happens once nobody does.
func TestRespawnWaitsWhileWatched(t *testing.T) {
	def := wolfDef()
	def.Behavior.Aggressive = false
	h := monsterHarness(t, []*content.Monster{def}, spawnAt("wolf", 30, 30, 0, 5))
	cl, _ := h.join("Watcher", at(31, 30))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.sim.Command(gameFunc(func() { wolf.SetHealth(1) }))
	h.input(cl, setTarget(wolf.ID()))
	h.sim.RunUntil(func() bool { return len(h.w.Monsters()) == 0 }, sim.MaxSeconds(60))
	h.sim.RunFor(20e9) // well past respawn_seconds: still watched
	if n := len(h.w.Monsters()); n != 0 {
		t.Fatalf("%d monsters respawned in front of the player", n)
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.RunUntil(func() bool { return len(h.w.Monsters()) == 1 }, sim.MaxSeconds(10))
	if got := h.w.Monsters()[0].Pos(); got != pos(30, 30) {
		t.Errorf("respawned at %v", got)
	}
}

// Monsters in sectors without players nearby neither think nor move.
func TestMonstersSleepInInactiveSectors(t *testing.T) {
	m := worldtest.Open(t, 0, 0, 256, 64)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 200, 30, 3, 60)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolfDef()}
		c.Items = testItems()
	})
	h.join("Far", at(10, 30))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	start := wolf.Pos()
	h.sim.RunFor(30e9)
	if wolf.Pos() != start || wolf.State() != session.StateIdle {
		t.Errorf("sleeping wolf moved to %v (state %v)", wolf.Pos(), wolf.State())
	}
	// A player two sectors away wakes it up: it wanders.
	h.join("Near", at(150, 30))
	moved := h.sim.RunUntil(func() bool { return wolf.Pos() != start }, sim.MaxSeconds(30))
	if moved == 0 {
		t.Error("awake wolf never moved")
	}
}

// A passive monster ignores players until one hits it.
func TestPassiveMonsterFightsBack(t *testing.T) {
	def := wolfDef()
	def.Behavior.Aggressive = false
	def.Health = 1000
	h := monsterHarness(t, []*content.Monster{def}, spawnAt("wolf", 30, 30, 0, 60))
	cl, p := h.join("Poker", at(31, 30))
	h.sim.RunFor(3e9)
	wolf := onlyMonster(t, h)
	if wolf.TargetID() != 0 {
		t.Fatalf("passive wolf targets %d", wolf.TargetID())
	}
	h.input(cl, setTarget(wolf.ID()))
	h.sim.RunUntil(func() bool { return wolf.TargetID() == p.ID() }, sim.MaxSeconds(20))
}

// Nobody attacks from or into a protection zone; a defeated player wakes at the temple.
func TestProtectionZoneAndDefeat(t *testing.T) {
	m := worldtest.Open(t, 0, 0, 64, 64)
	s := m.SectorAt(pos(5, 5))
	s.Flags[5*world.SectorSize+5] |= world.FlagProtection
	def := wolfDef()
	def.Attacks[0].Min, def.Attacks[0].Max = 50, 50
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 30, 30, 0, 60)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": def}
		c.Items = testItems()
	})
	safe, _ := h.join("Safe", at(5, 5))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.input(safe, setTarget(wolf.ID()))
	h.sim.Step()
	if got := find(safe.take(), (*pb.ServerMessage).GetChatMessage); len(got) != 1 || got[0].GetLocalized().GetKey() != "combat.cannot_attack" {
		t.Errorf("messages = %v", got)
	}

	_, p := h.join("Victim", at(31, 30))
	h.sim.RunUntil(func() bool { return p.Pos() != pos(31, 30) }, sim.MaxSeconds(30)) // only a defeat moves it
	h.sim.RunUntil(func() bool { return chebyshev(p.Pos(), m.Islands()[0].Temple) <= 3 }, sim.MaxSeconds(30))
	if cur, mx := p.Health(); cur != mx {
		t.Errorf("health after defeat %d/%d", cur, mx)
	}
}

func chebyshev(a, b world.Pos) int {
	return max(abs(int(a.X)-int(b.X)), abs(int(a.Y)-int(b.Y)))
}
