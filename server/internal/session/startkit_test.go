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

// A kit that names a stackable twice gives one stack (the second entry merges into the
// first) and the economy log counts every unit once; the ledger still matches.
func TestStartKitMergesStacks(t *testing.T) {
	g := testVocations["guardian"]
	g.StartKit = []content.KitItem{{Item: "test_salve", Count: 3}, {Item: "test_salve", Count: 2}}
	h := deathHarness(t, func(c *session.Config) {
		c.Balance.Inventory.StartContainer = "backpack"
		c.Vocations = content.Vocations{"guardian": g}
	})
	_, p := h.joinChar(session.Character{ID: 9300, AccountID: 9300, Name: "Stacker", Vocation: "guardian", Level: 1, Health: 145})
	items := p.Equipped(slotBackpack).Items()
	if len(items) != 1 || items[0].Def().ID != "test_salve" || items[0].Count() != 5 {
		t.Fatalf("backpack holds %d piles, want one of 5 salves", len(items))
	}
	if got := kitUnits(h); got[salveID] != 5 {
		t.Errorf("economy log: %d salves, want 5", got[salveID])
	}
	h.sim.Step()
	h.checkInvariants()
}

// What fits neither the backpack nor the pockets is not given: here there is no backpack,
// so the four pockets take four wands and the fifth is left out of the inventory, of the
// economy log and of the save.
func TestStartKitWithoutRoom(t *testing.T) {
	g := testVocations["guardian"]
	g.Weapons = []string{"sword"}
	for range pocketSlots + 1 {
		g.StartKit = append(g.StartKit, content.KitItem{Item: "test_wand"})
	}
	h := deathHarness(t, func(c *session.Config) { c.Vocations = content.Vocations{"guardian": g} })
	_, p := h.joinChar(session.Character{ID: 9301, AccountID: 9301, Name: "Crammed", Vocation: "guardian", Level: 1, Health: 145})
	if n := len(p.Pockets().Items()); n != pocketSlots || h.w.CountItem(p, "test_wand") != pocketSlots {
		t.Fatalf("pockets hold %d, carried %d wands, want %d", n, h.w.CountItem(p, "test_wand"), pocketSlots)
	}
	if got := kitUnits(h); got[wandID] != int32(pocketSlots) {
		t.Errorf("economy log: %d wands, want %d", got[wandID], pocketSlots)
	}
	if len(h.saves) == 0 || len(h.saves[len(h.saves)-1].Inventory) != pocketSlots {
		t.Fatalf("saved %+v, want the %d wands that fit", h.saves, pocketSlots)
	}
	h.sim.Step()
	h.checkInvariants()
}

// The kit is not loot: it does not count as earned in the outlier window (economy.go
// earns), unlike what the character makes afterwards.
func TestStartKitIsNotEarned(t *testing.T) {
	h := kitHarness(t)
	_, p := h.joinChar(session.Character{ID: 9302, AccountID: 9302, Name: "Honest", Vocation: "guardian", Level: 1, Health: 145})
	if n := h.w.EarnedItemsForTest(p); n != 0 {
		t.Errorf("the kit counted as %d earned units", n)
	}
}

// The real kits (data/vocations.yaml): every vocation's character wears each wearable
// piece (the weapon in its hand, the guardian's shield, the ranger's arrows as
// ammunition, the clothes) and carries the rest in the backpack; nothing is left out. A
// death takes or leaves what the death rules say, and gives nothing back.
func TestStartKitRealData(t *testing.T) {
	cfg := dataConfig(t, nil)
	id := int64(9400)
	for _, voc := range []string{"guardian", "arcanist", "ranger", "druid"} {
		h := dataHarness(t)
		id++
		kit := cfg.Vocations[voc].StartKit
		if len(kit) == 0 {
			t.Fatalf("%s has no start_kit", voc)
		}
		_, p := h.joinChar(session.Character{ID: id, AccountID: id, Name: "Kit" + voc, Vocation: voc, Level: 1, Health: 100})
		worn := map[string]int{}
		for s := pb.EquipmentSlot(1); s <= pb.EquipmentSlot_EQUIPMENT_SLOT_AMMO; s++ {
			if it := p.Equipped(s); it != nil {
				worn[it.Def().ID] += it.Count()
			}
		}
		carried := map[string]int{}
		for _, k := range kit {
			def := cfg.Items[k.Item]
			carried[k.Item] = h.w.CountItem(p, k.Item)
			wearable := def.Weapon != nil || def.Shield != nil || def.Armor != nil || def.Ammo != nil
			if wearable && worn[k.Item] != k.Units() {
				t.Errorf("%s: wears %d %s, want %d", voc, worn[k.Item], k.Item, k.Units())
			}
			if !wearable && carried[k.Item] != k.Units() {
				t.Errorf("%s: carries %d %s, want %d", voc, carried[k.Item], k.Item, k.Units())
			}
		}
		if def := cfg.Items[kit[0].Item]; def.Weapon == nil || p.Equipped(slotRight) == nil || p.Equipped(slotRight).Def().ID != def.ID {
			t.Errorf("%s: the first piece, %s, is not the weapon in its hand", voc, kit[0].Item)
		}
		given := len(h.entries(session.EconStartKit))
		h.sim.Step()
		h.kill(p)
		if n := len(h.entries(session.EconStartKit)); n != given {
			t.Errorf("%s: the death gave the kit again (%d entries, was %d)", voc, n, given)
		}
		for item, had := range carried {
			if n := h.w.CountItem(p, item); n > had {
				t.Errorf("%s: after the death it carries %d %s, had %d", voc, n, item, had)
			}
		}
		h.sim.Step() // the ledger is reconciled every tick here: a mismatch fails the test
	}
	if two := cfg.Items["short_bow"].Weapon.Hands; two != 2 {
		t.Fatalf("the short bow takes %d hands: this test expects the ranger's two-handed bow", two)
	}
}

// A character made before the kits existed (it has a position, so no kit) still starts
// Chapter 1 armed: the harbor master hands the class weapon to whoever does not carry
// it, once, with the coins; one that carries it gets the coins only.
func TestHarborMasterArmsTheUnarmed(t *testing.T) {
	for voc, weapon := range map[string]string{
		"guardian": "rusty_cutlass", "arcanist": "spark_wand", "ranger": "short_bow", "druid": "sapling_staff",
	} {
		h := dataHarness(t)
		old := session.Character{ID: 9500, AccountID: 9500, Name: "Veteran", Vocation: voc, Level: 1, Health: 100,
			HasPos: true, Pos: pos(10, 10), InventoryLoaded: true}
		cl, p := h.joinChar(old)
		cl.take()
		if h.w.CountItem(p, weapon) != 0 {
			t.Fatalf("%s: an old character got the kit", voc)
		}
		master := h.npc("harbor_master")
		d := h.lastDialog(h.send(cl, talkMsg(master.ID())))
		d = h.lastDialog(h.pick(cl, d, "npc.harbor_master.opt_shipwreck"))
		if len(d.Options) != 2 {
			t.Fatalf("%s: offer options %v, want one accept and the refusal", voc, d.Options)
		}
		h.pick(cl, d, "dialog.accept")
		if n := h.w.CountItem(p, weapon); n != 1 || h.w.Money(p) < 30 {
			t.Errorf("%s: accepted with %d %s and %d coins, want the weapon and the coins", voc, n, weapon, h.w.Money(p))
		}
		// The new character of the same vocation carries its weapon: coins only.
		cl2, q := h.joinFresh(session.Character{ID: 9501, AccountID: 9501, Name: "Rookie", Vocation: voc, Level: 1, Health: 100}, pos(10, 11))
		d = h.lastDialog(h.send(cl2, talkMsg(master.ID())))
		d = h.lastDialog(h.pick(cl2, d, "npc.harbor_master.opt_shipwreck"))
		if len(d.Options) != 2 {
			t.Fatalf("%s: a new character's offer options %v", voc, d.Options)
		}
		h.pick(cl2, d, "dialog.accept")
		if n := h.w.CountItem(q, weapon); n != 1 || h.w.Money(q) != h.w.Money(p) {
			t.Errorf("%s: a new character accepted with %d %s and %d coins (the old one %d)", voc, n, weapon, h.w.Money(q), h.w.Money(p))
		}
	}
}
