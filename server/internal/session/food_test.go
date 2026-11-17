package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Food (content audit m2): consumable.food_ms of the well_fed condition, added up to its
// max_ms; while it lasts, the vocation regeneration is regen_pct % stronger.
const (
	breadID = 95
	stewID  = 96
)

func init() {
	testItemDefs[breadID] = "{id: test_bread, kind: consumable, weight: 200, stackable: true, max_stack: 100, consumable: {food_ms: 120000}}"
	testItemDefs[stewID] = "{id: test_stew, kind: consumable, weight: 700, stackable: true, max_stack: 100, consumable: {food_ms: 90000, heal_hp: 10}}"
}

func withFood(c *session.Config) {
	c.Items = testItems()
	c.Balance.Inventory.UseCooldownMs = 1000
	c.Balance.Conditions = content.ConditionDefs{"well_fed": {ID: "well_fed", Kind: content.ConditionRegen,
		RegenPct: 100, MaxMs: 300000, Stacking: content.StackAdd, Persists: true}}
}

// Eating feeds and is shown as a condition; fed, a guardian regenerates twice as much
// (3 health and 1 mana every 7 s become 6 and 2).
func TestFoodDoublesRegeneration(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), withFood)
	c := withPack(9101, pos(10, 10), session.ItemState{ItemID: breadID, Count: 3})
	c.Health, c.Mana = 100, 10
	cl, p := h.joinChar(c)
	pack := openPack(t, h, cl)
	h.input(cl, useItem(inContainer(pack, 0), breadID, 0))
	h.sim.Step()
	evs := cl.take()
	if !hasKey(evs, "inventory.ate") {
		t.Fatalf("messages %v", systemKeys(evs))
	}
	if left := h.w.ConditionsForTest(p)["well_fed"]; left < 119000 || left > 120000 {
		t.Fatalf("well_fed left %d ms, want ~120000", left)
	}
	conds := find(evs, (*pb.ServerMessage).GetPlayerConditions)
	if len(conds) != 1 || len(conds[0].GetConditions()) != 1 || conds[0].GetConditions()[0].GetConditionId() != "well_fed" {
		t.Fatalf("PlayerConditions = %v", conds)
	}
	// The first regeneration comes 7 s after the login (two ticks are gone).
	h.sim.RunTicks(7000/50 - 3)
	if hp, _ := p.Health(); hp != 100 {
		t.Fatalf("health %d before the first interval", hp)
	}
	h.sim.RunTicks(1)
	if hp, _ := p.Health(); hp != 106 || h.w.Mana(p) != 12 {
		t.Fatalf("fed regeneration: health %d mana %d, want 106 and 12", hp, h.w.Mana(p))
	}
}

// Pure food past max_ms is refused without eating it (nor starting the cooldown); food
// that also heals is always eaten, its time capped. The condition ends on its own.
func TestFoodFullStomach(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), withFood)
	c := withPack(9102, pos(10, 10), session.ItemState{ItemID: breadID, Count: 3},
		session.ItemState{ItemID: stewID, Count: 1})
	c.Health = 100
	cl, p := h.joinChar(c)
	pack := openPack(t, h, cl)
	eat := func(slot, item uint32) []*pb.ServerMessage {
		h.input(cl, useItem(inContainer(pack, slot), item, 0))
		h.sim.Step()
		evs := cl.take()
		h.sim.RunTicks(1000 / 50) // the consumable cooldown
		return evs
	}
	eat(0, breadID)
	eat(0, breadID) // ~119 s left + 120 s: fits under 300 s
	if left := h.w.ConditionsForTest(p)["well_fed"]; left < 230000 || left > 240000 {
		t.Fatalf("well_fed left %d ms after two breads", left)
	}
	evs := eat(0, breadID)
	if !hasKey(evs, "inventory.full_stomach") || h.w.CountItem(p, "test_bread") != 1 {
		t.Fatalf("a third bread: messages %v, %d breads left", systemKeys(evs), h.w.CountItem(p, "test_bread"))
	}
	// Refused: no cooldown, so the stew goes down right away, and it heals.
	h.input(cl, useItem(inContainer(pack, 0), breadID, 0))
	h.input(cl, useItem(inContainer(pack, 1), stewID, 0))
	h.sim.Step()
	if hp, _ := p.Health(); hp != 110 || h.w.CountItem(p, "test_stew") != 0 {
		t.Fatalf("stew: health %d, %d stews left", hp, h.w.CountItem(p, "test_stew"))
	}
	if left := h.w.ConditionsForTest(p)["well_fed"]; left > 300000 || left < 299000 {
		t.Fatalf("well_fed left %d ms, want capped at 300000", left)
	}
	h.sim.RunTicks(300000 / 50)
	if _, ok := h.w.ConditionsForTest(p)["well_fed"]; ok {
		t.Fatal("well_fed did not end")
	}
}
