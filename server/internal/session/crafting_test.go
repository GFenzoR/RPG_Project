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
	stationID = worldtest.Vein // the 'v' of the drawings is the station (or the tree)
	hammerID  = 120
	ingotID   = 121
	logID     = 122
	bladeID   = 123
	axeToolID = 124
	craftGap  = 60 // ticks of the recipes' time_ms (3000 ms)
)

var craftItemDefs = map[uint16]string{
	stationID: "{id: test_forge, kind: decoration, pickupable: false, blocks_movement: true}",
	hammerID:  "{id: smithing_hammer, kind: tool, weight: 2600, tool: {use: smithing}}",
	oreID:     "{id: iron_ore, kind: material, weight: 2000, stackable: true, max_stack: 100}",
	ingotID:   "{id: iron_ingot, kind: material, weight: 1600, stackable: true, max_stack: 100}",
	logID:     "{id: birch_log, kind: material, weight: 1800, stackable: true, max_stack: 100}",
	bladeID:   "{id: test_blade, kind: weapon, weight: 3000, weapon: {type: sword, attack: 14, hands: 1}}",
}

// craftRecipes: a coin-flip ingot at level 1 without a tool, and a blade that needs the
// hammer and smithing 5.
var craftRecipes = content.Recipes{
	"ingot": {ID: "ingot", Craft: "smithing", Station: "test_forge", Level: 1, TimeMs: 3000, XP: 2,
		Inputs: []content.RecipeStack{{Item: "iron_ore", Count: 2}, {Item: "birch_log", Count: 1}},
		Output: content.RecipeStack{Item: "iron_ingot", Count: 1}, BaseSuccess: 0.5},
	"blade": {ID: "blade", Craft: "smithing", Station: "test_forge", Tool: "smithing", Level: 5, TimeMs: 3000, XP: 1,
		Inputs: []content.RecipeStack{{Item: "iron_ingot", Count: 1}},
		Output: content.RecipeStack{Item: "test_blade", Count: 1}, BaseSuccess: 1},
}

func craftHarness(t *testing.T, m *world.Map) *harness {
	t.Helper()
	items := testItems()
	for n, src := range craftItemDefs {
		var it content.Item
		if err := yaml.Unmarshal([]byte(src), &it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = n
		items[it.ID] = &it
	}
	return newHarness(t, m, func(c *session.Config) {
		c.Items = items
		c.Recipes = craftRecipes
		c.Balance.Skills.Base["smithing"] = content.SkillBase{StartLevel: 1, BaseTries: 20}
		c.Balance.Gathering.UseIntervalMs = 1500
	})
}

// crafter joins a character at p whose backpack (4 slots) holds pack.
func crafter(h *harness, p world.Pos, pack ...session.ItemState) (*fakeClient, *session.Player) {
	nextChar++
	cl, pl := h.joinChar(withPack(nextChar, p, pack...))
	cl.take()
	return cl, pl
}

func stack(id uint16, n, slot int) session.ItemState {
	return session.ItemState{ItemID: id, Count: n, Slot: slot}
}

func craftMsg(recipe string, station world.Pos) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_Craft{Craft: &pb.Craft{
		RecipeId: recipe, Station: &pb.Position{X: uint32(station.X), Y: uint32(station.Y), Z: uint32(station.Z)},
	}}}
}

func (h *harness) craft(cl *fakeClient, recipe string, station world.Pos) []*pb.ServerMessage {
	h.input(cl, craftMsg(recipe, station))
	h.sim.Step()
	return cl.take()
}

var forgeMap = []string{
	"v...",
	"....",
	"....",
}

// Every attempt spends the inputs and trains smithing; with a seeded rand the 50%
// recipe both succeeds and fails, and the same seed gives the same results.
func TestCraftSuccessAndFailureSeeded(t *testing.T) {
	run := func() []bool {
		h := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...))
		cl, p := crafter(h, pos(1, 0), stack(oreID, 20, 0), stack(logID, 10, 1))
		var got []bool
		for i := range 10 {
			evs := h.craft(cl, "ingot", pos(0, 0))
			switch {
			case hasKey(evs, "craft.done"):
				got = append(got, true)
			case hasKey(evs, "craft.failed"):
				got = append(got, false)
			default:
				t.Fatalf("attempt %d: messages %v", i, systemKeys(evs))
			}
			h.sim.RunTicks(craftGap)
		}
		done := 0
		for _, ok := range got {
			if ok {
				done++
			}
		}
		if packCount(p, oreID) != 0 || packCount(p, logID) != 0 || packCount(p, ingotID) != done {
			t.Fatalf("ore %d, logs %d, ingots %d (made %d)", packCount(p, oreID), packCount(p, logID), packCount(p, ingotID), done)
		}
		if s := h.w.Skill(p, "smithing"); s.Level != 2 { // 20 tries = level 1 -> 2
			t.Fatalf("smithing after 10 attempts × 2 xp = %+v, want level 2", s)
		}
		if done == 0 || done == len(got) {
			t.Fatalf("results %v: want both successes and failures", got)
		}
		h.checkInvariants()
		return got
	}
	a, b := run(), run()
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("same seed, different results: %v vs %v", a, b)
		}
	}
}

// Missing an input, the level, the tool, the station or the distance: nothing is taken
// and nothing trains.
func TestCraftRejectsWithoutChanges(t *testing.T) {
	h := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...))
	cl, p := crafter(h, pos(1, 0), stack(oreID, 1, 0), stack(logID, 3, 1), stack(ingotID, 2, 2))
	cases := []struct {
		recipe  string
		station world.Pos
		key     string
	}{
		{"ingot", pos(0, 0), "craft.missing"},    // 1 ore of 2
		{"blade", pos(0, 0), "craft.level"},      // smithing 1 of 5
		{"ingot", pos(1, 1), "craft.no_station"}, // grass
		{"nope", pos(0, 0), "inventory.not_possible"},
	}
	for _, c := range cases {
		if evs := h.craft(cl, c.recipe, c.station); !hasKey(evs, c.key) {
			t.Errorf("%s at %v: messages %v, want %s", c.recipe, c.station, systemKeys(evs), c.key)
		}
	}
	if packCount(p, oreID) != 1 || packCount(p, logID) != 3 || packCount(p, ingotID) != 2 || h.w.Skill(p, "smithing").Tries != 0 {
		t.Fatalf("a rejected craft changed something: ore %d, logs %d, ingots %d, smithing %+v",
			packCount(p, oreID), packCount(p, logID), packCount(p, ingotID), h.w.Skill(p, "smithing"))
	}

	// Two tiles away from the forge: too far.
	h2 := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...))
	cl2, p2 := crafter(h2, pos(2, 0), stack(oreID, 2, 0), stack(logID, 1, 1))
	if evs := h2.craft(cl2, "ingot", pos(0, 0)); !hasKey(evs, "inventory.too_far") || packCount(p2, oreID) != 2 {
		t.Fatalf("from two tiles: messages %v, ore %d", systemKeys(evs), packCount(p2, oreID))
	}
}

// The blade needs the hammer: without it, no_tool; carried in the backpack, it works.
func TestCraftNeedsTool(t *testing.T) {
	h := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...))
	cl, p := crafter(h, pos(1, 0), stack(ingotID, 2, 0))
	h.w.TrainForTest(p, "smithing", 200) // well above level 5
	if evs := h.craft(cl, "blade", pos(0, 0)); !hasKey(evs, "craft.no_tool") || packCount(p, ingotID) != 2 {
		t.Fatalf("without hammer: messages %v", systemKeys(evs))
	}
	h.w.GiveForTest(p, "smithing_hammer", 1)
	evs := h.craft(cl, "blade", pos(0, 0))
	if !hasKey(evs, "craft.done") || packCount(p, bladeID) != 1 || packCount(p, ingotID) != 1 {
		t.Fatalf("with hammer: messages %v, blades %d", systemKeys(evs), packCount(p, bladeID))
	}
	// The window refreshes with what is left.
	if opens := find(evs, (*pb.ServerMessage).GetStationOpen); len(opens) != 1 {
		t.Fatalf("StationOpen after a craft = %v", opens)
	}
}

// One attempt per time_ms (and gathering waits too); a full backpack or not enough
// capacity rejects the craft before anything is spent.
func TestCraftIntervalAndRoom(t *testing.T) {
	h := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...))
	cl, p := crafter(h, pos(1, 0), stack(oreID, 10, 0), stack(logID, 5, 1))
	if evs := h.craft(cl, "ingot", pos(0, 0)); !hasKey(evs, "craft.done") && !hasKey(evs, "craft.failed") {
		t.Fatalf("first: messages %v", systemKeys(evs))
	}
	h.sim.RunTicks(craftGap - 2)
	if evs := h.craft(cl, "ingot", pos(0, 0)); !hasKey(evs, "craft.not_ready") || packCount(p, oreID) != 8 {
		t.Fatalf("before time_ms: messages %v, ore %d", systemKeys(evs), packCount(p, oreID))
	}
	h.sim.Step()
	if evs := h.craft(cl, "ingot", pos(0, 0)); hasKey(evs, "craft.not_ready") {
		t.Fatalf("after time_ms: messages %v", systemKeys(evs))
	}

	// Four full slots and an output that would need a fifth.
	h2 := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...))
	cl2, p2 := crafter(h2, pos(1, 0), stack(oreID, 2, 0), stack(logID, 1, 1), stack(swordID, 1, 2), stack(shieldID, 1, 3))
	if evs := h2.craft(cl2, "ingot", pos(0, 0)); !hasKey(evs, "craft.no_room") || packCount(p2, oreID) != 2 || packCount(p2, logID) != 1 {
		t.Fatalf("full backpack: messages %v, ore %d, logs %d", systemKeys(evs), packCount(p2, oreID), packCount(p2, logID))
	}
	if h2.w.Skill(p2, "smithing").Tries != 0 {
		t.Fatal("a craft rejected for room trained")
	}

	// Room in the backpack but no capacity left for the ingot (the inputs' weight counts).
	h3 := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...))
	cl3, p3 := crafter(h3, pos(1, 0), stack(oreID, 2, 0), stack(logID, 1, 1))
	h3.w.SetCapacityForTest(p3, p3.Carried()) // exactly full: 5800 g of inputs free, 1600 g needed
	if evs := h3.craft(cl3, "ingot", pos(0, 0)); hasKey(evs, "craft.no_room") {
		t.Fatalf("the inputs' weight should make room: messages %v", systemKeys(evs))
	}
	h3.sim.RunTicks(craftGap)
	h3.w.SetCapacityForTest(p3, 1_000_000)
	h3.w.GiveForTest(p3, "iron_ore", 2)
	h3.w.GiveForTest(p3, "birch_log", 1)
	h3.w.SetCapacityForTest(p3, p3.Carried()-5800+1599)
	if evs := h3.craft(cl3, "ingot", pos(0, 0)); !hasKey(evs, "craft.no_room") {
		t.Fatalf("one gram short: messages %v", systemKeys(evs))
	}
}

// Using a station within reach opens it; a plain map item cannot be used; from afar,
// too far.
func TestStationOpen(t *testing.T) {
	h := craftHarness(t, worldtest.Map(t, 0, 0, 7,
		"v..#",
		"....",
	))
	cl, p := crafter(h, pos(1, 1), stack(oreID, 3, 0), stack(swordID, 1, 1))
	h.w.GiveForTest(p, "smithing_hammer", 1)
	cl.take()
	h.input(cl, useItem(onTile(pos(0, 0)), stationID, 1))
	h.sim.Step()
	opens := find(cl.take(), (*pb.ServerMessage).GetStationOpen)
	if len(opens) != 1 || opens[0].GetItemId() != stationID || opens[0].GetPos().GetX() != 0 {
		t.Fatalf("StationOpen = %v", opens)
	}
	// Only the inputs of the station's recipes, and the tools carried.
	if o := opens[0].GetOwned(); len(o) != 1 || o[0].GetItemId() != oreID || o[0].GetCount() != 3 {
		t.Fatalf("owned = %v", o)
	}
	if tl := opens[0].GetTools(); len(tl) != 1 || tl[0] != "smithing" {
		t.Fatalf("tools = %v", tl)
	}
	h.input(cl, useItem(onTile(pos(3, 0)), worldtest.Wall, 1))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.cannot_use") {
		t.Fatalf("wall: messages %v", systemKeys(evs))
	}
	h.input(cl, useItem(onTile(pos(0, 0)), stationID+1, 1)) // stale view
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.not_possible") {
		t.Fatalf("wrong item id: messages %v", systemKeys(evs))
	}

	far, _ := crafter(h, pos(3, 1))
	h.input(far, useItem(onTile(pos(0, 0)), stationID, 1))
	h.sim.Step()
	if evs := far.take(); !hasKey(evs, "inventory.too_far") || len(find(evs, (*pb.ServerMessage).GetStationOpen)) != 0 {
		t.Fatalf("far: messages %v", systemKeys(evs))
	}
}

// A recipe whose station, input or craft is unknown stops the World from starting.
func TestRecipesChecked(t *testing.T) {
	bad := []content.Recipe{
		{ID: "a", Craft: "smithing", Station: "nope", Inputs: []content.RecipeStack{{Item: "iron_ore", Count: 1}}, Output: content.RecipeStack{Item: "iron_ingot", Count: 1}},
		{ID: "a", Craft: "smithing", Station: "test_forge", Inputs: []content.RecipeStack{{Item: "nope", Count: 1}}, Output: content.RecipeStack{Item: "iron_ingot", Count: 1}},
		{ID: "a", Craft: "smithing", Station: "iron_ore", Inputs: []content.RecipeStack{{Item: "iron_ore", Count: 1}}, Output: content.RecipeStack{Item: "iron_ingot", Count: 1}},
		{ID: "a", Craft: "baking", Station: "test_forge", Inputs: []content.RecipeStack{{Item: "iron_ore", Count: 1}}, Output: content.RecipeStack{Item: "iron_ingot", Count: 1}},
	}
	for i, r := range bad {
		items := testItems()
		for n, src := range craftItemDefs {
			var it content.Item
			_ = yaml.Unmarshal([]byte(src), &it)
			it.Numeric = n
			items[it.ID] = &it
		}
		cfg := session.Config{Map: worldtest.Map(t, 0, 0, 7, "v."), Balance: testBalance(), Vocations: testVocations,
			Items: items, Recipes: content.Recipes{"a": &r}, Save: func(session.Snapshot) bool { return true }}
		cfg.Balance.Skills.Base["smithing"] = content.SkillBase{StartLevel: 1, BaseTries: 20}
		if _, err := session.New(cfg); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

// Woodcutting is gathering (T3.4): an axe on a tree gives logs, trains woodcutting and
// the tree runs out and grows back like a vein.
func TestWoodcutting(t *testing.T) {
	items := testItems()
	for n, src := range map[uint16]string{
		axeToolID: "{id: felling_axe, kind: tool, weight: 3900, tool: {use: woodcutting}}",
		logID:     "{id: birch_log, kind: material, weight: 1800, stackable: true, max_stack: 100}",
		stationID: `{id: birch_tree, kind: decoration, pickupable: false, resource: {tool: woodcutting, skill: woodcutting,
			charges: 3, regen_ms: 20000, chance: {base: 1, per_level: 0, max: 1}, drops: [{item: birch_log, weight: 1}]}}`,
	} {
		var it content.Item
		if err := yaml.Unmarshal([]byte(src), &it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = n
		items[it.ID] = &it
	}
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, "v.", ".."), func(c *session.Config) {
		c.Items = items
		c.Balance.Skills.Base["woodcutting"] = content.SkillBase{StartLevel: 1, BaseTries: 20}
		c.Balance.Gathering.UseIntervalMs = 1500
	})
	tree := pos(0, 0)
	cl, p := gatherer(h, pos(1, 1), axeToolID)
	cl.take()
	for i := range 3 {
		if evs := h.try(cl, axeToolID, tree); !hasKey(evs, "gather.got") {
			t.Fatalf("chop %d: messages %v", i, systemKeys(evs))
		}
		h.sim.RunTicks(gatherGap)
	}
	if evs := h.try(cl, axeToolID, tree); !hasKey(evs, "gather.depleted") {
		t.Fatalf("bare tree: messages %v", systemKeys(evs))
	}
	if packCount(p, logID) != 3 || h.w.Skill(p, "woodcutting").Tries != 3 {
		t.Fatalf("logs %d, woodcutting %+v", packCount(p, logID), h.w.Skill(p, "woodcutting"))
	}
	h.sim.RunFor(20 * time.Second)
	if h.w.ResourceLeft(tree) != -1 {
		t.Fatal("the tree did not grow back")
	}
	if evs := h.try(cl, axeToolID, tree); !hasKey(evs, "gather.got") {
		t.Fatalf("grown back: messages %v", systemKeys(evs))
	}
}
