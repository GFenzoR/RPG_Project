package session_test

import (
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// kitHarness is a death harness whose guardian has a start_kit (docs/02 "Equipo
// inicial"): a sword and a shield, a tunic, a crown it cannot wear yet (level 20), an
// arcanist's wand it cannot wield and three salves.
func kitHarness(t *testing.T) *harness {
	t.Helper()
	g := testVocations["guardian"]
	g.Weapons = []string{"sword", "axe", "club"}
	g.StartKit = []content.KitItem{
		{Item: "test_sword"}, {Item: "test_shield"}, {Item: "test_tunic"}, {Item: "test_crown"},
		{Item: "test_wand"}, {Item: "test_salve", Count: 3},
	}
	return deathHarness(t, func(c *session.Config) {
		c.Balance.Inventory.StartContainer = "backpack"
		c.Vocations = content.Vocations{"guardian": g}
	})
}

// kitUnits counts the start_kit economy entries by item id.
func kitUnits(h *harness) map[uint16]int32 {
	out := map[uint16]int32{}
	for _, e := range h.entries(session.EconStartKit) {
		out[e.ItemID] += e.Count
	}
	return out
}

// A new character gets its vocation's kit once: each piece in the slot it fits, the rest
// in the backpack; the economy log says so and the ledger matches. It is saved at once,
// and neither a death nor a relog (from the unsaved snapshot or from the saved row) gives
// it again.
func TestStartKitGivenOnce(t *testing.T) {
	h := kitHarness(t)
	fresh := session.Character{ID: 9100, AccountID: 9100, Name: "Rookie", Vocation: "guardian", Level: 1, Health: 145}
	cl, p := h.joinChar(fresh)
	want := map[pb.EquipmentSlot]string{
		slotRight: "test_sword", slotLeft: "test_shield", pb.EquipmentSlot_EQUIPMENT_SLOT_ARMOR: "test_tunic",
		slotBackpack: "backpack",
	}
	if got := equipped(p); len(got) != len(want) {
		t.Fatalf("equipped %v, want %v", got, want)
	} else {
		for s, id := range want {
			if got[s] != id {
				t.Errorf("slot %v: %q, want %q", s, got[s], id)
			}
		}
	}
	bp := p.Equipped(slotBackpack)
	inPack := map[string]int{}
	for _, it := range bp.Items() {
		inPack[it.Def().ID] += it.Count()
	}
	if len(inPack) != 3 || inPack["test_crown"] != 1 || inPack["test_wand"] != 1 || inPack["test_salve"] != 3 {
		t.Errorf("backpack holds %v, want the crown, the wand and 3 salves", inPack)
	}
	got := kitUnits(h)
	for id, n := range map[uint16]int32{swordID: 1, shieldID: 1, tunicID: 1, crownID: 1, wandID: 1, salveID: 3} {
		if got[id] != n {
			t.Errorf("economy log: %d units of item %d, want %d (%v)", got[id], id, n, got)
		}
	}
	if len(h.saves) == 0 || len(h.saves[len(h.saves)-1].Inventory) != 4 {
		t.Fatalf("the kit was not saved at once: %+v", h.saves)
	}
	h.sim.Step()
	h.checkInvariants()
	given := len(h.entries(session.EconStartKit))

	// A death: no kit (and, as before, no backpack).
	h.kill(p)
	if n := len(h.entries(session.EconStartKit)); n != given {
		t.Errorf("the death gave the kit again (%d entries, was %d)", n, given)
	}

	// Relog before the database acknowledged: the unsaved snapshot, no second kit.
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	cl, _ = h.joinChar(fresh)
	if n := len(h.entries(session.EconStartKit)); n != given {
		t.Errorf("a relog gave the kit again (%d entries, was %d)", n, given)
	}

	// A later login from the saved row (it has a position now), even with nothing carried.
	for _, empty := range []bool{false, true} {
		h.sim.Command(h.w.Leave(cl))
		h.sim.Step()
		last := h.saves[len(h.saves)-1]
		h.sim.Command(h.w.Saved(last.CharacterID, last.Seq))
		h.sim.Step()
		row := fresh
		row.HasPos, row.Pos, row.Inventory = true, last.Pos, last.Inventory
		if empty {
			row.Inventory = nil
		}
		var q *session.Player
		cl, q = h.joinChar(row)
		if n := len(h.entries(session.EconStartKit)); n != given {
			t.Errorf("a login from the saved row gave the kit again (%d entries, was %d)", n, given)
		}
		if empty && len(equipped(q)) != 0 {
			t.Errorf("a character that emptied its hands got %v", equipped(q))
		}
	}
	h.checkInvariants()
}

// Another vocation's kit is its own; a vocation without one starts with the backpack only.
func TestStartKitIsTheVocations(t *testing.T) {
	g := testVocations["guardian"]
	a := g
	a.ID, a.Weapons = "arcanist", []string{"wand"}
	a.StartKit = []content.KitItem{{Item: "test_wand"}, {Item: "test_salve", Count: 2}}
	h := deathHarness(t, func(c *session.Config) {
		c.Balance.Inventory.StartContainer = "backpack"
		c.Vocations = content.Vocations{"guardian": g, "arcanist": a}
	})
	_, p := h.joinChar(session.Character{ID: 9200, AccountID: 9200, Name: "Sparky", Vocation: "arcanist", Level: 1, Health: 140})
	if got := p.Equipped(slotRight); got == nil || got.Def().ID != "test_wand" {
		t.Errorf("the arcanist's right hand: %v", got)
	}
	_, q := h.joinChar(session.Character{ID: 9201, AccountID: 9201, Name: "Plain", Vocation: "guardian", Level: 1, Health: 145})
	if got := equipped(q); len(got) != 1 || got[slotBackpack] != "backpack" {
		t.Errorf("a vocation without a kit wears %v", got)
	}
	h.checkInvariants()
}

// A kit naming an unknown item, or more than a stack, refuses to start.
func TestStartKitChecked(t *testing.T) {
	for _, kit := range [][]content.KitItem{{{Item: "nothing_here"}}, {{Item: "test_sword", Count: 2}}, {{Item: "test_salve", Count: 101}}} {
		g := testVocations["guardian"]
		g.StartKit = kit
		_, err := session.New(session.Config{Map: worldtest.Open(t, 0, 0, 8, 8), Balance: testBalance(), Items: testItems(),
			Vocations: content.Vocations{"guardian": g}, Save: func(session.Snapshot) bool { return true }})
		if err == nil || !strings.Contains(err.Error(), "start_kit") {
			t.Errorf("kit %v: session.New = %v, want a start_kit error", kit, err)
		}
	}
}
