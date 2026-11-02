package session_test

import (
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

const (
	rodID     = 80
	pickID    = 81
	fishID    = 82
	oreID     = 83
	stoneID   = 84
	plainID   = worldtest.Floor     // plain water (the '~' of the drawings): no fish
	shoalID   = worldtest.FishWater // water with fish
	veinID    = worldtest.Vein
	gatherGap = 30 // ticks of gathering.use_interval_ms (1500 ms)
)

// gatherItemDefs: a vein that always succeeds (2 charges, 10 s to refill) and a shoal
// whose chance grows with fishing.
var gatherItemDefs = map[uint16]string{
	rodID:   "{id: fishing_rod, kind: tool, weight: 800, tool: {use: fishing}}",
	pickID:  "{id: pickaxe, kind: tool, weight: 4500, tool: {use: mining}}",
	fishID:  "{id: raw_fish, kind: consumable, weight: 500, stackable: true, max_stack: 100}",
	oreID:   "{id: iron_ore, kind: material, weight: 2000, stackable: true, max_stack: 100}",
	stoneID: "{id: rough_stone, kind: material, weight: 1200, stackable: true, max_stack: 100}",
	plainID: "{id: water_shallow, kind: ground}",
	shoalID: `{id: water_shoal, kind: ground, resource: {tool: fishing, skill: fishing, reach: 3, charges: 5,
		regen_ms: 240000, chance: {base: 0.2, per_level: 0.015, max: 0.7}, drops: [{item: raw_fish, weight: 1}]}}`,
	veinID: `{id: iron_vein, kind: decoration, pickupable: false, resource: {tool: mining, skill: mining, charges: 2,
		regen_ms: 10000, chance: {base: 1, per_level: 0, max: 1},
		drops: [{item: iron_ore, weight: 1}, {item: rough_stone, weight: 1, count: [2, 3]}]}}`,
}

func gatherHarness(t *testing.T, m *world.Map, afkMs int) *harness {
	t.Helper()
	items := testItems()
	for n, src := range gatherItemDefs {
		var it content.Item
		if err := yaml.Unmarshal([]byte(src), &it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = n
		items[it.ID] = &it
	}
	return newHarness(t, m, func(c *session.Config) {
		c.Items = items
		c.Balance.Skills.Base["fishing"] = content.SkillBase{StartLevel: 10, BaseTries: 22}
		c.Balance.Skills.Base["mining"] = content.SkillBase{StartLevel: 1, BaseTries: 20}
		c.Balance.Gathering.UseIntervalMs = 1500
		c.Balance.Gathering.AFK.AfterMs, c.Balance.Gathering.AFK.Factor = afkMs, 0.25
	})
}

// gatherer joins a character at p holding tool in the right hand and an empty backpack.
func gatherer(h *harness, p world.Pos, tool uint16) (*fakeClient, *session.Player) {
	nextChar++
	c := withPack(nextChar, p)
	c.Inventory = append(c.Inventory, session.ItemState{ItemID: tool, Count: 1, Slot: int(slotRight)})
	return h.joinChar(c)
}

func useOn(tool uint16, target world.Pos) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_UseItemOn{UseItemOn: &pb.UseItemOn{
		From: inSlot(slotRight), ItemId: uint32(tool),
		To: &pb.ActionTarget{Target: &pb.ActionTarget_Pos{Pos: &pb.Position{X: uint32(target.X), Y: uint32(target.Y), Z: uint32(target.Z)}}},
	}}}
}

// try sends one UseItemOn, runs a tick and returns what the client heard.
func (h *harness) try(cl *fakeClient, tool uint16, target world.Pos) []*pb.ServerMessage {
	h.input(cl, useOn(tool, target))
	h.sim.Step()
	return cl.take()
}

func packCount(p *session.Player, id uint16) int {
	n := 0
	for _, it := range p.Equipped(slotBackpack).Items() {
		if it.Def().Numeric == id {
			n += it.Count()
		}
	}
	return n
}

func effects(evs []*pb.ServerMessage) []uint32 {
	var out []uint32
	for _, e := range find(evs, (*pb.ServerMessage).GetEffect) {
		out = append(out, e.GetEffectId())
	}
	return out
}

// Fishing trains the fishing skill with every cast, caught or not: 22 casts take it
// from 10 to 11. Casting over several fish tiles keeps them from running out.
func TestFishingRaisesSkill(t *testing.T) {
	h := gatherHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"..T...",
		"ffff..",
	), 0)
	cl, p := gatherer(h, pos(2, 1), rodID)
	cl.take()
	caught, missed := 0, 0
	for i := range 22 {
		evs := h.try(cl, rodID, pos(i%4, 2))
		switch {
		case hasKey(evs, "gather.got"):
			caught++
		case hasKey(evs, "gather.failed"):
			missed++
		default:
			t.Fatalf("cast %d: messages %v", i, systemKeys(evs))
		}
		h.sim.RunTicks(gatherGap)
	}
	if s := h.w.Skill(p, "fishing"); s.Level != 11 {
		t.Fatalf("fishing after 22 casts = %+v, want level 11", s)
	}
	if caught == 0 || missed == 0 || packCount(p, fishID) != caught {
		t.Fatalf("caught %d, missed %d, fish in backpack %d", caught, missed, packCount(p, fishID))
	}
}

// Plain water has no fish: nothing happens and fishing does not train. Neither does a
// pickaxe on water, a cast out of reach, or a second cast before use_interval_ms.
func TestNoFishingInPlainWater(t *testing.T) {
	h := gatherHarness(t, worldtest.Map(t, 0, 0, 7,
		"..T.....",
		"~~f.....",
	), 0)
	cl, p := gatherer(h, pos(2, 0), rodID)
	cl.take()
	if evs := h.try(cl, rodID, pos(0, 1)); !hasKey(evs, "gather.nothing") || len(effects(evs)) != 0 {
		t.Fatalf("plain water: messages %v, effects %v", systemKeys(evs), effects(evs))
	}
	if evs := h.try(cl, rodID, pos(7, 0)); !hasKey(evs, "gather.nothing") {
		t.Fatalf("grass: messages %v", systemKeys(evs))
	}
	if s := h.w.Skill(p, "fishing"); s.Tries != 0 || packCount(p, fishID) != 0 {
		t.Fatalf("fishing in plain water trained %+v or caught %d", s, packCount(p, fishID))
	}
	if evs := h.try(cl, rodID, pos(2, 1)); len(effects(evs)) != 1 {
		t.Fatalf("shoal: messages %v", systemKeys(evs))
	}
	if evs := h.try(cl, rodID, pos(2, 1)); !hasKey(evs, "gather.not_ready") {
		t.Fatalf("second cast in a row: messages %v", systemKeys(evs))
	}
	if s := h.w.Skill(p, "fishing"); s.Tries != 1 {
		t.Fatalf("fishing = %+v, want 1 try", s)
	}

	// A pickaxe on a vein from four tiles away: too far.
	h2 := gatherHarness(t, worldtest.Map(t, 0, 0, 7, "T...v"), 0)
	cl2, _ := gatherer(h2, pos(0, 0), pickID)
	if evs := h2.try(cl2, pickID, pos(4, 0)); !hasKey(evs, "inventory.too_far") {
		t.Fatalf("vein out of reach: messages %v", systemKeys(evs))
	}
}

// A vein runs out after its charges and grows back regen_ms after the last swing,
// through the scheduler. Every swing trains mining.
func TestVeinDepletesAndRegenerates(t *testing.T) {
	h := gatherHarness(t, worldtest.Map(t, 0, 0, 7,
		"T.",
		"v.",
	), 0)
	vein := pos(0, 1)
	cl, p := gatherer(h, pos(0, 0), pickID)
	cl.take()
	if h.w.ResourceLeft(vein) != -1 {
		t.Fatal("untouched vein should be full")
	}
	for i := range 2 {
		evs := h.try(cl, pickID, vein)
		if !hasKey(evs, "gather.got") || len(effects(evs)) != 1 || effects(evs)[0] != 5 {
			t.Fatalf("swing %d: messages %v, effects %v", i, systemKeys(evs), effects(evs))
		}
		h.sim.RunTicks(gatherGap)
	}
	if h.w.ResourceLeft(vein) != 0 || packCount(p, oreID)+packCount(p, stoneID) < 2 {
		t.Fatalf("after 2 swings: left %d, ore %d, stone %d", h.w.ResourceLeft(vein), packCount(p, oreID), packCount(p, stoneID))
	}
	if evs := h.try(cl, pickID, vein); !hasKey(evs, "gather.depleted") {
		t.Fatalf("spent vein: messages %v", systemKeys(evs))
	}
	if s := h.w.Skill(p, "mining"); s.Tries != 2 {
		t.Fatalf("mining = %+v, want 2 tries (a spent vein does not train)", s)
	}
	h.sim.RunFor(10 * time.Second)
	if h.w.ResourceLeft(vein) != -1 {
		t.Fatalf("vein did not grow back: left %d", h.w.ResourceLeft(vein))
	}
	if evs := h.try(cl, pickID, vein); !hasKey(evs, "gather.got") {
		t.Fatalf("grown vein: messages %v", systemKeys(evs))
	}
}

// Gathering for gathering.afk.after_ms without leaving the tile earns a quarter of the
// tries; a step resets it.
func TestGatheringAFK(t *testing.T) {
	h := gatherHarness(t, worldtest.Map(t, 0, 0, 7,
		"T...",
		"ffff",
	), 3000) // 60 ticks
	cl, p := gatherer(h, pos(0, 0), rodID)
	cl.take()
	for i := range 6 { // at 0, 30: full tries; at 60, 90, 120, 150: a quarter each
		h.try(cl, rodID, pos(i%4, 1))
		h.sim.RunTicks(gatherGap - 1)
	}
	if s := h.w.Skill(p, "fishing"); s.Tries != 3 {
		t.Fatalf("fishing = %+v, want 2 + 4 × 0.25 = 3 tries", s)
	}
	h.input(cl, walk(E))
	h.sim.RunTicks(gatherGap)
	h.try(cl, rodID, pos(2, 1))
	if s := h.w.Skill(p, "fishing"); s.Tries != 4 {
		t.Fatalf("after a step: fishing = %+v, want a full try (4)", s)
	}
}
