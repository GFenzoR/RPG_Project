package session_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// The forge (docs/02 "Forja", refine.go): an attempt at the anvil spends the stones of the
// item's band, gold × the level it aims at and, if asked, the protection; up to +4 it never
// fails, after that a failure breaks the item or, protected, costs it one level. Every
// test checks what was spent, exactly once, and what the log and the save say.

const (
	temperID    = 140
	bigTemperID = 141
	amberID     = 142
	ringID      = 143
	refineGap   = 20 // ticks of testForge's time_ms (1000 ms)
)

var refineItemDefs = map[uint16]string{
	stationID:   "{id: test_forge, kind: decoration, pickupable: false, blocks_movement: true}",
	temperID:    "{id: test_stone, kind: material, weight: 100, stackable: true, max_stack: 100, tradeable: true}",
	bigTemperID: "{id: test_big_stone, kind: material, weight: 100, stackable: true, max_stack: 100, tradeable: true}",
	amberID:     "{id: test_amber, kind: material, weight: 10, stackable: true, max_stack: 100, tradeable: true}",
	ringID:      "{id: test_ring, kind: armor, weight: 100, armor: {slot: ring, armor: 0}}",
}

// testForge is data/balance.yaml's table with two bands of test stones: the crown
// (requires level 20) is of the second.
func testForge() content.Forge {
	return content.Forge{Enabled: true, Station: "test_forge", TimeMs: 1000, SafeLevel: 4, Protection: "test_amber",
		SmithingBonus: content.SmithingBonus{Skill: "smithing", PerLevels: 6, Max: 5}, JewelryPct: 10,
		Levels: []content.ForgeLevel{{Chance: 100, Stones: 1}, {Chance: 100, Stones: 1}, {Chance: 100, Stones: 1},
			{Chance: 100, Stones: 1}, {Chance: 70, Stones: 2}, {Chance: 55, Stones: 2}, {Chance: 40, Stones: 2},
			{Chance: 25, Stones: 3}, {Chance: 15, Stones: 3}, {Chance: 8, Stones: 3}},
		Bands: []content.ForgeBand{
			{Level: 1, Stone: "test_stone", Gold: 1, Attack: 1, Armor: 0.5, Defense: 1},
			{Level: 10, Stone: "test_big_stone", Gold: 2, Attack: 2, Armor: 1, Defense: 2},
		}}
}

// refineItems are the inventory test items with the forge's, and copper coins of worth 1.
func refineItems(t testing.TB) content.Items {
	t.Helper()
	items := testItems()
	for n, src := range refineItemDefs {
		var it content.Item
		if err := yaml.Unmarshal([]byte(src), &it); err != nil {
			t.Fatal(err)
		}
		it.Numeric = n
		items[it.ID] = &it
	}
	coin := *items["copper_coin"]
	if err := yaml.Unmarshal([]byte("{currency: {worth: 1}}"), &coin); err != nil {
		t.Fatal(err)
	}
	items["copper_coin"] = &coin
	return items
}

// withForge turns the forge on with testForge (after the items, so other options can
// change the table).
func withForge(c *session.Config) {
	c.Balance.Forge = testForge()
	c.Balance.Skills.Base["smithing"] = content.SkillBase{StartLevel: 1, BaseTries: 20}
}

// refineHarness is the anvil 'v' at (0, 0) of forgeMap.
func refineHarness(t *testing.T, opts ...option) *harness {
	t.Helper()
	return newHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...), append([]option{func(c *session.Config) {
		c.Items = refineItems(t)
		withForge(c)
	}}, opts...)...)
}

var anvilPos = pos(0, 0)

func refinedMods(attr string, v, r int) session.Mods {
	return session.Mods{Attr: attr, Value: v, Refine: r}
}

// rolledAt is a saved instance of item id with attribute attr of value v at refine level r.
func rolledAt(id uint16, slot int, attr string, v, r int) session.ItemState {
	return session.ItemState{ItemID: id, Count: 1, Slot: slot, Mods: refinedMods(attr, v, r)}
}

// forger joins a character next to the anvil wielding a sword (attack 2) at refine level
// r, its 4-slot backpack holding 30 stones, 5 ambers and 100 copper, and skills.
func forger(h *harness, r int, skills ...session.SkillState) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: "Smith", Vocation: "guardian", Level: 1,
		Health: 145, Mana: 20, Pos: pos(1, 0), HasPos: true, InventoryLoaded: true, Skills: skills,
		Inventory: []session.ItemState{
			rolledAt(swordID, int(slotRight), "attack", 2, r),
			{ItemID: packID, Count: 1, Slot: int(slotBackpack), Items: []session.ItemState{
				stack(temperID, 30, 0), stack(amberID, 5, 1), stack(coinID, 100, 2)}},
		}}
	cl, p := h.joinChar(c)
	cl.take()
	return cl, p
}

// refineMsg is an attempt on the piece of item at from as the client saw it (mods).
func refineMsg(from *pb.ItemLocation, item uint32, mods session.Mods, protect bool) *pb.ClientMessage {
	var m *pb.ItemMods
	if !mods.Zero() {
		m = &pb.ItemMods{Attribute: mods.Attr, Value: int32(mods.Value), Refine: uint32(mods.Refine)}
	}
	return &pb.ClientMessage{Message: &pb.ClientMessage_Refine{Refine: &pb.Refine{
		Station: posMsgOf(anvilPos), Item: from, ItemId: item, Mods: m, Protect: protect,
	}}}
}

// swordAt are the mods of forger's sword at refine level r.
func swordAt(r int) session.Mods { return refinedMods("attack", 2, r) }

func posMsgOf(p world.Pos) *pb.Position {
	return &pb.Position{X: uint32(p.X), Y: uint32(p.Y), Z: uint32(p.Z)}
}

// refineSword sends one attempt on forger's wielded sword at level and waits out the pace.
func (h *harness) refineSword(cl *fakeClient, level int, protect bool) []*pb.ServerMessage {
	h.input(cl, refineMsg(inSlot(slotRight), swordID, swordAt(level), protect))
	h.sim.Step()
	evs := cl.take()
	h.sim.RunTicks(refineGap)
	return evs
}

func refineResult(t *testing.T, evs []*pb.ServerMessage) *pb.RefineResult {
	t.Helper()
	rs := find(evs, (*pb.ServerMessage).GetRefineResult)
	if len(rs) != 1 {
		t.Fatalf("RefineResult %v (messages %v)", rs, systemKeys(evs))
	}
	return rs[0]
}

func effectsAt(evs []*pb.ServerMessage, p world.Pos) []uint32 {
	var out []uint32
	for _, e := range find(evs, (*pb.ServerMessage).GetEffect) {
		if e.GetPos().GetX() == uint32(p.X) && e.GetPos().GetY() == uint32(p.Y) {
			out = append(out, e.GetEffectId())
		}
	}
	return out
}

// spent is what p carries of stones, ambers and money.
type spent struct {
	stones, ambers int
	money          int64
}

func (h *harness) carried(p *session.Player) spent {
	return spent{h.w.CountItem(p, "test_stone"), h.w.CountItem(p, "test_amber"), h.w.Money(p)}
}

// forgeLog sums the forge's economy entries: money, stones, ambers and the sword's
// instances (with their mods, in order).
func (h *harness) forgeLog() (gold int64, stones, ambers int32, swords []session.EconomyEntry) {
	for _, e := range h.economy {
		if e.Kind != session.EconForge {
			continue
		}
		switch e.ItemID {
		case 0:
			gold += e.Amount
		case temperID:
			stones += e.Count
		case amberID:
			ambers += e.Count
		case swordID:
			swords = append(swords, e)
		}
	}
	return gold, stones, ambers, swords
}

// Up to +4 every attempt succeeds, whatever the roll and whatever the table says (here the
// safe levels' chances are 0, a table the content check would refuse: the safe level alone
// keeps them sure), and spends one stone and gold × the level: four attempts take a plain
// sword to +4 with sparks on the anvil, and its attack grows with each level at once (it
// is worn). A safe level is not saved at once (going back to before it gives nothing): the
// next save, here the logout's, has it.
func TestRefineSafeLevelsNeverFail(t *testing.T) {
	h := refineHarness(t, func(c *session.Config) {
		for i := range 4 {
			c.Balance.Forge.Levels[i].Chance = 0
		}
	})
	cl, p := forger(h, 0)
	_, _, atk0, _, _ := h.w.GearForTest(p, "sword")
	before, saves := h.carried(p), len(h.saves)
	for level := range 4 {
		evs := h.refineSword(cl, level, true) // the protection is ignored where nothing can fail
		r := refineResult(t, evs)
		if r.GetOutcome() != pb.RefineOutcome_REFINE_OUTCOME_SUCCESS || r.GetLevel() != uint32(level+1) ||
			itemMods(r.GetItem()) != refinedMods("attack", 2, level+1) {
			t.Fatalf("attempt +%d: %v", level+1, r)
		}
		if fx := effectsAt(evs, anvilPos); !slices.Equal(fx, []uint32{session.EffectRefine}) {
			t.Fatalf("attempt +%d effects %v", level+1, fx)
		}
		if !hasKey(evs, "refine.success") || len(find(evs, (*pb.ServerMessage).GetStationOpen)) != 1 {
			t.Fatalf("attempt +%d: %v", level+1, kinds(evs))
		}
		if _, _, atk, _, _ := h.w.GearForTest(p, "sword"); atk != atk0+level+1 {
			t.Fatalf("attack at +%d: %d, want %d", level+1, atk, atk0+level+1)
		}
	}
	after := h.carried(p)
	if before.stones-after.stones != 4 || before.ambers != after.ambers || before.money-after.money != 1+2+3+4 {
		t.Fatalf("spent %+v -> %+v", before, after)
	}
	gold, stones, ambers, swords := h.forgeLog()
	if gold != -10 || stones != -4 || ambers != 0 || len(swords) != 8 {
		t.Fatalf("log: gold %d stones %d ambers %d swords %v", gold, stones, ambers, swords)
	}
	// Each level change is the instance out with its old mods and in with the new ones.
	for i, e := range swords {
		want := refinedMods("attack", 2, i/2+i%2)
		if e.Mods != want || (i%2 == 0) != (e.Count == -1) {
			t.Fatalf("entry %d: %+v, want %+v", i, e, want)
		}
	}
	if len(h.saves) != saves {
		t.Fatalf("%d saves after the safe attempts", len(h.saves)-saves)
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	inv := h.saves[len(h.saves)-1].Inventory
	if i := slices.IndexFunc(inv, func(s session.ItemState) bool { return s.ItemID == swordID }); i < 0 ||
		inv[i].Mods != refinedMods("attack", 2, 4) {
		t.Fatalf("saved %+v", inv)
	}
}

// From +5 to +10, at each level: a success raises it, a failure breaks it (it is gone,
// the log says so) and a protected failure costs one level and the amber. Stones, the
// amber and gold go exactly once; the outcome is forced through the table's chance (100
// or 0), so the seeded roll does not decide.
func TestRefineOutcomesAtEachLevel(t *testing.T) {
	type outcome struct {
		name    string
		chance  int
		protect bool
		want    pb.RefineOutcome
		key     string
		effect  uint32
	}
	outcomes := []outcome{
		{"success", 100, false, pb.RefineOutcome_REFINE_OUTCOME_SUCCESS, "refine.success", session.EffectRefine},
		{"protected success", 100, true, pb.RefineOutcome_REFINE_OUTCOME_SUCCESS, "refine.success", session.EffectRefine},
		{"break", 0, false, pb.RefineOutcome_REFINE_OUTCOME_BROKEN, "refine.broken", session.EffectShatter},
		{"protected", 0, true, pb.RefineOutcome_REFINE_OUTCOME_PROTECTED, "refine.protected", session.EffectShatter},
	}
	for target := 5; target <= 10; target++ {
		for _, o := range outcomes {
			t.Run(fmt.Sprintf("+%d %s", target, o.name), func(t *testing.T) {
				h := refineHarness(t, func(c *session.Config) { c.Balance.Forge.Levels[target-1].Chance = o.chance })
				cl, p := forger(h, target-1)
				before, saves := h.carried(p), len(h.saves)
				_, _, atk0, _, _ := h.w.GearForTest(p, "sword")
				evs := h.refineSword(cl, target-1, o.protect)
				r := refineResult(t, evs)
				level := map[pb.RefineOutcome]int{pb.RefineOutcome_REFINE_OUTCOME_SUCCESS: target,
					pb.RefineOutcome_REFINE_OUTCOME_PROTECTED: target - 2}[o.want]
				if r.GetOutcome() != o.want || r.GetLevel() != uint32(level) || !hasKey(evs, o.key) {
					t.Fatalf("result %v, messages %v", r, systemKeys(evs))
				}
				if fx := effectsAt(evs, anvilPos); !slices.Equal(fx, []uint32{o.effect}) {
					t.Fatalf("effects %v", fx)
				}
				swords := h.w.ItemsForTest(p, "test_sword")
				switch o.want {
				case pb.RefineOutcome_REFINE_OUTCOME_BROKEN:
					if len(swords) != 0 || p.Equipped(slotRight) != nil || r.GetItem().GetMods() != nil {
						t.Fatalf("the sword is still there: %v", swords)
					}
				default:
					if len(swords) != 1 || swords[0].Mods() != refinedMods("attack", 2, level) ||
						itemMods(r.GetItem()) != swords[0].Mods() {
						t.Fatalf("sword %v, result %v", swords, r)
					}
					if _, _, atk, _, _ := h.w.GearForTest(p, "sword"); atk != atk0+level-(target-1) {
						t.Fatalf("attack %d, before %d", atk, atk0)
					}
				}
				after := h.carried(p)
				stones, ambers := testForge().Levels[target-1].Stones, 0
				if o.protect {
					ambers = 1
				}
				if before.stones-after.stones != stones || before.ambers-after.ambers != ambers ||
					before.money-after.money != int64(target) {
					t.Fatalf("spent %+v -> %+v", before, after)
				}
				gold, ls, la, logged := h.forgeLog()
				if gold != -int64(target) || ls != -int32(stones) || la != -int32(ambers) {
					t.Fatalf("log gold %d stones %d ambers %d", gold, ls, la)
				}
				old := refinedMods("attack", 2, target-1)
				switch o.want {
				case pb.RefineOutcome_REFINE_OUTCOME_BROKEN:
					if len(logged) != 1 || logged[0].Count != -1 || logged[0].Mods != old {
						t.Fatalf("broken in the log: %+v", logged)
					}
				default:
					if len(logged) != 2 || logged[0].Mods != old || logged[1].Mods != refinedMods("attack", 2, level) {
						t.Fatalf("level change in the log: %+v", logged)
					}
				}
				// Saved right away, as it is now.
				if len(h.saves) != saves+1 {
					t.Fatalf("%d saves after the attempt", len(h.saves)-saves)
				}
				inv := h.saves[len(h.saves)-1].Inventory
				hasSword := slices.ContainsFunc(inv, func(s session.ItemState) bool { return s.ItemID == swordID })
				if hasSword == (o.want == pb.RefineOutcome_REFINE_OUTCOME_BROKEN) {
					t.Fatalf("saved inventory %+v", inv)
				}
			})
		}
	}
}

// With the real table the seeded roll decides: the same seed gives the same outcomes, and
// a run from +4 with the protection both climbs and falls back (this seed: one protected
// failure among four successes), and ends at the level they add up to.
func TestRefineSeededRolls(t *testing.T) {
	run := func() ([]pb.RefineOutcome, int) {
		h := refineHarness(t)
		cl, p := forger(h, 4)
		var got []pb.RefineOutcome
		for range 5 { // 5 ambers: protected every time
			sword := p.Equipped(slotRight)
			r := refineResult(t, h.refineSword(cl, sword.Mods().Refine, true))
			got = append(got, r.GetOutcome())
		}
		if n := h.w.CountItem(p, "test_amber"); n != 0 {
			t.Fatalf("%d ambers left", n)
		}
		return got, p.Equipped(slotRight).Mods().Refine
	}
	a, level := run()
	if b, _ := run(); !slices.Equal(a, b) {
		t.Fatalf("same seed, other outcomes: %v vs %v", a, b)
	}
	want := 4
	for _, o := range a {
		switch o {
		case pb.RefineOutcome_REFINE_OUTCOME_SUCCESS:
			want++
		case pb.RefineOutcome_REFINE_OUTCOME_PROTECTED:
			want--
		default:
			t.Fatalf("a protected attempt broke the sword: %v", a)
		}
	}
	if !slices.Contains(a, pb.RefineOutcome_REFINE_OUTCOME_SUCCESS) ||
		!slices.Contains(a, pb.RefineOutcome_REFINE_OUTCOME_PROTECTED) || level != want {
		t.Fatalf("outcomes %v, level %d (want %d)", a, level, want)
	}
}

// The smithing bonus adds its points where an attempt can fail: at smithing 30, +5 points
// turn a 95 % attempt into a sure one.
func TestRefineSmithingBonus(t *testing.T) {
	h := refineHarness(t, func(c *session.Config) { c.Balance.Forge.Levels[4].Chance = 95 })
	cl, p := forger(h, 4, session.SkillState{ID: "smithing", Level: 30})
	sword := p.Equipped(slotRight)
	for i := range 20 {
		r := refineResult(t, h.refineSword(cl, 4, false))
		if r.GetOutcome() != pb.RefineOutcome_REFINE_OUTCOME_SUCCESS {
			t.Fatalf("attempt %d at smithing 30: %v", i, r)
		}
		h.sim.Command(gameFunc(func() {
			sword.SetModsForTest(refinedMods("attack", 2, 4))
			h.w.GiveForTest(p, "test_stone", 2)
			h.w.GiveForTest(p, "copper_coin", 5)
		}))
		h.sim.Step()
	}
}

// The skill of the bonus is data (forge.smithing_bonus.skill): named mining, mining's level
// gives it and smithing's does not. +1 point per level up to 30: at mining 30 the 70 % of
// +5 is sure, at mining 1 (smithing 30) it is 71 %.
func TestRefineBonusSkillIsData(t *testing.T) {
	h := refineHarness(t, func(c *session.Config) {
		c.Balance.Forge.SmithingBonus = content.SmithingBonus{Skill: "mining", PerLevels: 1, Max: 30}
		c.Balance.Skills.Base["mining"] = content.SkillBase{StartLevel: 1, BaseTries: 20}
	})
	cl, p := forger(h, 4, session.SkillState{ID: "mining", Level: 30}, session.SkillState{ID: "smithing", Level: 1})
	sword := p.Equipped(slotRight)
	for i := range 20 {
		if r := refineResult(t, h.refineSword(cl, 4, false)); r.GetOutcome() != pb.RefineOutcome_REFINE_OUTCOME_SUCCESS {
			t.Fatalf("attempt %d at mining 30: %v", i, r)
		}
		h.sim.Command(gameFunc(func() {
			sword.SetModsForTest(refinedMods("attack", 2, 4))
			h.w.GiveForTest(p, "test_stone", 2)
			h.w.GiveForTest(p, "copper_coin", 5)
		}))
		h.sim.Step()
	}
	// A skill the balance does not know stops the server.
	cfg := session.Config{Map: worldtest.Map(t, 0, 0, 7, forgeMap...), Balance: testBalance(), Vocations: testVocations,
		Items: refineItems(t), Save: func(session.Snapshot) bool { return true }}
	withForge(&cfg)
	cfg.Balance.Forge.SmithingBonus.Skill = "juggling"
	if _, err := session.New(cfg); err == nil || !strings.Contains(err.Error(), "juggling") {
		t.Fatalf("an unknown bonus skill: %v", err)
	}
}

// Looking at a refined piece names its level ("+7 sword": the stack goes with its mods)
// and says its numbers with what the level adds; a plain one says the item's own.
func TestLookSaysTheRefineLevel(t *testing.T) {
	h := refineHarness(t)
	look := func(cl *fakeClient, from *pb.ItemLocation, id uint32) (*pb.ItemStack, map[string]int64) {
		t.Helper()
		h.input(cl, lookAt(from, id, 0))
		h.sim.Step()
		msgs := find(cl.take(), (*pb.ServerMessage).GetChatMessage)
		if len(msgs) != 1 {
			t.Fatalf("look: %v", msgs)
		}
		nums := map[string]int64{}
		var item *pb.ItemStack
		for _, prm := range msgs[0].GetLocalized().GetParams() {
			if prm.GetItem() != nil {
				item = prm.GetItem()
			} else {
				nums[prm.GetName()] = prm.GetNumber()
			}
		}
		return item, nums
	}
	plainCl, _ := forger(h, 0)
	plain, base := look(plainCl, inSlot(slotRight), swordID)
	if itemMods(plain) != refinedMods("attack", 2, 0) {
		t.Fatalf("plain sword %v", plain)
	}
	cl, _ := forger(h, 7)
	item, nums := look(cl, inSlot(slotRight), swordID)
	// Band 1 adds 1 attack a level: +7 is 7 more; the defense stays.
	if itemMods(item) != refinedMods("attack", 2, 7) || nums["attack"] != base["attack"]+7 || nums["defense"] != base["defense"] {
		t.Fatalf("+7 sword %v %v, plain %v", item, nums, base)
	}
}

// A +10 cannot go further; nothing is spent.
func TestRefineTopLevel(t *testing.T) {
	h := refineHarness(t)
	cl, p := forger(h, 10)
	before := h.carried(p)
	evs := h.refineSword(cl, 10, false)
	if !hasKey(evs, "refine.top_level") || len(find(evs, (*pb.ServerMessage).GetRefineResult)) != 0 {
		t.Fatalf("messages %v", systemKeys(evs))
	}
	if h.carried(p) != before || p.Equipped(slotRight).Mods().Refine != 10 {
		t.Fatal("something was spent or changed")
	}
}

// Every refusal leaves everything as it was.
func TestRefineRefusals(t *testing.T) {
	h := refineHarness(t)
	cl, p := forger(h, 0)
	win := openPack(t, h, cl)
	try := func(name, key string, m *pb.ClientMessage) {
		t.Helper()
		before := h.carried(p)
		h.input(cl, m)
		h.sim.Step()
		evs := cl.take()
		h.sim.RunTicks(refineGap)
		if !hasKey(evs, key) || len(find(evs, (*pb.ServerMessage).GetRefineResult)) != 0 {
			t.Fatalf("%s: messages %v", name, systemKeys(evs))
		}
		if h.carried(p) != before || p.Equipped(slotRight).Mods().Refine != 0 {
			t.Fatalf("%s: something was spent", name)
		}
	}
	try("stale level", "inventory.not_possible", refineMsg(inSlot(slotRight), swordID, swordAt(3), false))
	try("other item", "inventory.not_possible", refineMsg(inSlot(slotRight), tunicID, session.Mods{}, false))
	try("stones", "refine.not_refinable", refineMsg(inContainer(win, 0), temperID, session.Mods{}, false))
	try("backpack", "refine.not_refinable", refineMsg(inSlot(slotBackpack), packID, session.Mods{}, false))
	far := refineMsg(inSlot(slotRight), swordID, swordAt(0), false)
	far.GetRefine().Station = posMsgOf(pos(3, 2))
	try("no anvil there", "craft.no_station", far)

	// No stones of the band: the crown asks for the second band's.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "test_crown", 1) }))
	h.sim.Step()
	cl.take()
	try("other band", "refine.no_stones", refineMsg(inContainer(win, 3), crownID, session.Mods{}, false))

	// The protection asked for and not carried (only where the attempt can fail).
	h.sim.Command(gameFunc(func() {
		h.w.TakeForTest(p, "test_amber", 5)
		p.Equipped(slotRight).SetModsForTest(refinedMods("attack", 2, 4))
	}))
	h.sim.Step()
	cl.take()
	before := h.carried(p)
	h.input(cl, refineMsg(inSlot(slotRight), swordID, swordAt(4), true))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "refine.no_protection") || h.carried(p) != before {
		t.Fatalf("no amber: %v", systemKeys(evs))
	}
	h.sim.Command(gameFunc(func() { p.Equipped(slotRight).SetModsForTest(refinedMods("attack", 2, 0)) }))
	h.sim.Step()

	// Too poor.
	h.sim.Command(gameFunc(func() { h.w.TakeForTest(p, "copper_coin", 100) }))
	h.sim.Step()
	cl.take()
	try("money", "refine.no_money", refineMsg(inSlot(slotRight), swordID, swordAt(0), false))
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "copper_coin", 50) }))
	h.sim.Step()
	cl.take()

	// The pace: a second attempt right after the first is refused.
	h.input(cl, refineMsg(inSlot(slotRight), swordID, swordAt(0), false))
	h.sim.Step()
	h.input(cl, refineMsg(inSlot(slotRight), swordID, swordAt(1), false))
	h.sim.Step()
	if evs := cl.take(); len(find(evs, (*pb.ServerMessage).GetRefineResult)) != 1 || !hasKey(evs, "refine.not_ready") {
		t.Fatalf("pace: %v", systemKeys(evs))
	}
	// The same click twice: the second one names the old level and does nothing.
	h.sim.RunTicks(refineGap)
	h.input(cl, refineMsg(inSlot(slotRight), swordID, swordAt(0), false))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.not_possible") || p.Equipped(slotRight).Mods().Refine != 1 {
		t.Fatalf("repeated click: %v", systemKeys(evs))
	}

	// Walked away from the anvil.
	h.sim.RunTicks(refineGap)
	h.send(cl, walk(E))
	h.sim.RunTicks(40)
	cl.take()
	try2 := h.carried(p)
	h.input(cl, refineMsg(inSlot(slotRight), swordID, swordAt(1), false))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.too_far") || h.carried(p) != try2 {
		t.Fatalf("too far: %v", systemKeys(evs))
	}
}

// An item on the floor (Refine has no stack index: a tile names its ground) or in a
// container lying there (a corpse, a chest) is not the player's to refine; for the
// container the answer says only what it carries is refined.
func TestRefineNotFromTheGround(t *testing.T) {
	h := refineHarness(t)
	cl, p := forger(h, 0)
	h.send(cl, moveItem(inSlot(slotRight), swordID, 0, onTile(pos(1, 1)), 1))
	before := h.carried(p)
	m := refineMsg(onTile(pos(1, 1)), swordID, swordAt(0), false)
	h.input(cl, m)
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "inventory.not_possible") || h.carried(p) != before {
		t.Fatalf("ground: %v", systemKeys(evs))
	}
	if g := h.w.GroundAt(pos(1, 1)); len(g) != 1 || g[0].Mods().Refine != 0 {
		t.Fatalf("ground %v", g)
	}

	// A bag on the floor, opened, with the sword in it. The database has the throw first
	// (lote 16: until then the sword is reserved to the smith and goes into no stranger's
	// bag on the street).
	h.sim.Command(h.w.Saved(p.CharacterID(), 1<<62))
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("test_bag"), 1, pos(2, 1)) }))
	h.sim.Step()
	opens := find(h.send(cl, useItem(onTile(pos(2, 1)), bagID, 1)), (*pb.ServerMessage).GetContainerOpen)
	if len(opens) != 1 {
		t.Fatal("the bag did not open")
	}
	bag := opens[0].GetContainerId()
	h.send(cl, moveItem(onTile(pos(1, 1)), swordID, 1, inContainer(bag, 0), 1))
	if g := h.w.GroundAt(pos(1, 1)); len(g) != 0 {
		t.Fatalf("the sword stayed on the floor: %v", g)
	}
	h.input(cl, refineMsg(inContainer(bag, 0), swordID, swordAt(0), false))
	h.sim.Step()
	if evs := cl.take(); !hasKey(evs, "refine.not_carried") || h.carried(p) != before {
		t.Fatalf("a bag on the floor: %v", systemKeys(evs))
	}
}

// A click sent again before the result of a break (lag): the broken piece was the first
// of the backpack, the others moved up, and the message names the first place with the
// broken piece's mods. Another roll at the same level in that place now is not the piece
// the player chose: refused, nothing spent. A piece the same in every way is
// interchangeable: refined.
func TestRefineAfterABreakNamesTheBrokenPiece(t *testing.T) {
	for _, same := range []bool{false, true} {
		t.Run(fmt.Sprintf("same mods %v", same), func(t *testing.T) {
			h := refineHarness(t, func(c *session.Config) { c.Balance.Forge.Levels[4].Chance = 0 })
			next := refinedMods("attack", 3, 4)
			if same {
				next = swordAt(4)
			}
			nextChar++
			cl, p := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Smith", Vocation: "guardian",
				Level: 1, Health: 145, Mana: 20, Pos: pos(1, 0), HasPos: true, InventoryLoaded: true,
				Inventory: []session.ItemState{{ItemID: packID, Count: 1, Slot: int(slotBackpack), Items: []session.ItemState{
					rolledAt(swordID, 0, "attack", 2, 4), {ItemID: swordID, Count: 1, Slot: 1, Mods: next},
					stack(temperID, 30, 2), stack(coinID, 100, 3)}}}})
			cl.take()
			win := openPack(t, h, cl)
			first := refineMsg(inContainer(win, 0), swordID, swordAt(4), false)
			h.input(cl, first)
			h.sim.Step()
			if r := refineResult(t, cl.take()); r.GetOutcome() != pb.RefineOutcome_REFINE_OUTCOME_BROKEN {
				t.Fatalf("first attempt %v", r)
			}
			if s := h.w.ItemsForTest(p, "test_sword"); len(s) != 1 || s[0].Mods() != next {
				t.Fatalf("swords left %v", s)
			}
			h.sim.RunTicks(refineGap)
			before := h.carried(p)
			h.input(cl, first) // the same click, sent before the result came
			h.sim.Step()
			evs := cl.take()
			if same {
				if r := refineResult(t, evs); r.GetOutcome() != pb.RefineOutcome_REFINE_OUTCOME_BROKEN {
					t.Fatalf("the identical piece: %v", r)
				}
				return
			}
			if !hasKey(evs, "inventory.not_possible") || len(find(evs, (*pb.ServerMessage).GetRefineResult)) != 0 {
				t.Fatalf("another roll in its place: %v", systemKeys(evs))
			}
			if s := h.w.ItemsForTest(p, "test_sword"); h.carried(p) != before || len(s) != 1 || s[0].Mods() != next {
				t.Fatalf("spent %+v -> %+v, swords %v", before, h.carried(p), s)
			}
		})
	}
}

// What refine levels give the worn gear: a weapon's attack, an armor piece's armor, a
// shield's defense (each floor(level × the band's value)) and a jewel a share of its
// attribute; the backpack's refined items add nothing.
func TestRefinedGearChangesTheFormulas(t *testing.T) {
	h := refineHarness(t, withAttributes(t))
	join := func(inv ...session.ItemState) *session.Player {
		nextChar++
		_, p := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Worn", Vocation: "guardian",
			Level: 20, Health: 145, Mana: 20, Pos: pos(1+int(nextChar%3), 2), HasPos: true, InventoryLoaded: true,
			Inventory: inv})
		return p
	}
	pack := func(items ...session.ItemState) session.ItemState {
		return session.ItemState{ItemID: packID, Count: 1, Slot: int(slotBackpack), Items: items}
	}
	ring := int(pb.EquipmentSlot_EQUIPMENT_SLOT_RING)
	head := int(pb.EquipmentSlot_EQUIPMENT_SLOT_HEAD)
	plain := join(rolledAt(swordID, int(slotRight), "max_mana", 5, 0), rolledAt(shieldID, int(slotLeft), "max_mana", 5, 0),
		rolledAt(tunicID, int(slotArmor), "max_mana", 5, 0), rolledAt(crownID, head, "max_mana", 5, 0),
		rolledAt(ringID, ring, "max_health", 20, 0),
		pack(rolledAt(swordID, 0, "attack", 7, 9)))
	armor0, def0, atk0, _, _ := h.w.GearForTest(plain, "sword")
	_, max0 := plain.Health()
	p := join(rolledAt(swordID, int(slotRight), "max_mana", 5, 7), rolledAt(shieldID, int(slotLeft), "max_mana", 5, 5),
		rolledAt(tunicID, int(slotArmor), "max_mana", 5, 5), rolledAt(crownID, head, "max_mana", 5, 3),
		rolledAt(ringID, ring, "max_health", 20, 5),
		pack(rolledAt(swordID, 0, "attack", 7, 9)))
	armor, def, atk, _, _ := h.w.GearForTest(p, "sword")
	// Sword +7: 7 attack; shield +5: 5 defense; tunic +5: floor(2.5) armor; crown +3 (the
	// second band): 3 armor; ring +5: 50 % of 20 health.
	if atk != atk0+7 || def != def0+5 || armor != armor0+2+3 {
		t.Fatalf("attack %d/%d defense %d/%d armor %d/%d", atk, atk0, def, def0, armor, armor0)
	}
	if _, maxHP := p.Health(); maxHP != max0+10 {
		t.Fatalf("max health %d, plain %d", maxHP, max0)
	}
}

// The trade window: an offered item cannot be refined (it stays what the partner saw);
// nothing is spent.
func TestRefineNotWhileOffered(t *testing.T) {
	h := newMarketHarness(t, func(c *session.Config) {
		for id, def := range refineItems(t) {
			if c.Items[id] == nil && def.Numeric != boardID { // the board is the anvil here
				c.Items[id] = def
			}
		}
		withForge(c)
		c.Balance.Forge.Station = "market_board"
	})
	ca, a := h.trader("Ana", pos(1, 0), rolledAt(swordID, 0, "attack", 2, 0), stack(temperID, 5, 1), stack(coinID, 50, 2))
	cb, b := h.trader("Beto", pos(2, 0), stack(salveID, 4, 0))
	wa, wb := openPack(t, h.harness, ca), openPack(t, h.harness, cb)
	h.send(ca, tradeReq(b.ID(), inContainer(wa, 0), swordID))
	cb.take()
	if u := lastTrade(h.send(cb, tradeReq(a.ID(), inContainer(wb, 0), salveID))); len(u.GetPartnerOffer()) != 1 {
		t.Fatalf("trade %v", u)
	}
	ca.take()
	before := h.carried(a)
	evs := h.send(ca, refineMsg(inContainer(wa, 0), swordID, swordAt(0), false))
	if !hasKey(evs, "refine.in_trade") || h.carried(a) != before {
		t.Fatalf("offered: %v", systemKeys(evs))
	}
	if s := h.w.ItemsForTest(a, "test_sword"); len(s) != 1 || s[0].Mods().Refine != 0 {
		t.Fatalf("sword %v", s)
	}
	// Out of the trade, it can.
	h.send(ca, tradeCancel)
	h.sim.RunTicks(refineGap)
	evs = h.send(ca, refineMsg(inContainer(wa, 0), swordID, swordAt(0), false))
	if r := refineResult(t, evs); r.GetOutcome() != pb.RefineOutcome_REFINE_OUTCOME_SUCCESS {
		t.Fatalf("after the trade: %v", r)
	}
}

// The market: a sell offer takes the instance out of the backpack, so it cannot be
// refined while listed; nothing is spent.
func TestRefineNotWhileListed(t *testing.T) {
	h := newMarketHarness(t, func(c *session.Config) {
		for id, def := range refineItems(t) {
			if c.Items[id] == nil && def.Numeric != boardID { // the board is the anvil here
				c.Items[id] = def
			}
		}
		withForge(c)
		c.Balance.Forge.Station = "market_board"
	})
	cs, s := h.atBoard("Sela", pos(1, 0), rolledAt(swordID, 0, "attack", 2, 3), stack(temperID, 5, 1), stack(coinID, 50, 2))
	win := openPack(t, h.harness, cs)
	create := marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Create{Create: &pb.MarketCreate{
		Side: pb.MarketSide_MARKET_SIDE_SELL, ItemId: swordID, Amount: 1, Price: 30,
		Mods: &pb.ItemMods{Attribute: "attack", Value: 2, Refine: 3}}}})
	if !hasKey(h.send(cs, create), "market.created") {
		t.Fatal("not listed")
	}
	before := h.carried(s)
	evs := h.send(cs, refineMsg(inContainer(win, 0), swordID, swordAt(3), false))
	if !hasKey(evs, "inventory.not_possible") || h.carried(s) != before {
		t.Fatalf("listed: %v", systemKeys(evs))
	}
	if m := h.w.MarketOfferModsForTest(h.w.MarketOffers(s.CharacterID())[0]); m != refinedMods("attack", 2, 3) {
		t.Fatalf("offer %+v", m)
	}
}

// A disconnect in the same tick as an attempt: the attempt either happened in full before
// the final save or not at all (the player had left); never twice, never half. The
// economy ledger reconciles at every tick (newHarness fails on a mismatch).
func TestRefineAndDisconnect(t *testing.T) {
	for _, leaveFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("leave first %v", leaveFirst), func(t *testing.T) {
			h := refineHarness(t, func(c *session.Config) { c.Balance.Forge.Levels[4].Chance = 0 })
			cl, _ := forger(h, 4)
			if leaveFirst {
				h.sim.Command(h.w.Leave(cl))
				h.input(cl, refineMsg(inSlot(slotRight), swordID, swordAt(4), false))
			} else {
				h.input(cl, refineMsg(inSlot(slotRight), swordID, swordAt(4), false))
				h.sim.Command(h.w.Leave(cl))
			}
			h.sim.Step()
			final := h.saves[len(h.saves)-1]
			swords, stones, coins := 0, 0, 0
			var walk func([]session.ItemState)
			walk = func(items []session.ItemState) {
				for _, s := range items {
					switch s.ItemID {
					case swordID:
						swords++
					case temperID:
						stones += s.Count
					case coinID:
						coins += s.Count
					}
					walk(s.Items)
				}
			}
			walk(final.Inventory)
			want := [3]int{0, 28, 95} // broke: no sword, 2 stones and 5 copper spent
			if leaveFirst {
				want = [3]int{1, 30, 100}
			}
			if got := [3]int{swords, stones, coins}; got != want {
				t.Fatalf("final save: swords, stones, coins %v, want %v", got, want)
			}
			gold, ls, _, logged := h.forgeLog()
			if leaveFirst != (gold == 0 && ls == 0 && len(logged) == 0) {
				t.Fatalf("log gold %d stones %d swords %v", gold, ls, logged)
			}
		})
	}
}

// The anvil's window counts the forge's stones and protection and says the money.
func TestAnvilShowsTheForgeMaterials(t *testing.T) {
	h := refineHarness(t)
	cl, _ := forger(h, 0)
	evs := h.send(cl, useItem(onTile(anvilPos), stationID, 1))
	opens := find(evs, (*pb.ServerMessage).GetStationOpen)
	if len(opens) != 1 || opens[0].GetMoney() != 100 {
		t.Fatalf("StationOpen %v", opens)
	}
	owned := map[uint32]uint32{}
	for _, s := range opens[0].GetOwned() {
		owned[s.GetItemId()] = s.GetCount()
	}
	if owned[temperID] != 30 || owned[amberID] != 5 {
		t.Fatalf("owned %v", owned)
	}
}
