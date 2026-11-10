package session_test

import (
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// chapterThreeHarness is dataHarness with the Brasal NPCs of the Isla Volcánica (T5.5),
// the forest druid (who keeps the ember root) and spawns of the Chapter 3 monsters.
func chapterThreeHarness(t *testing.T) *harness {
	t.Helper()
	return dataHarnessWith(t, func(cfg *session.Config) {
		is := cfg.Map.Islands()[0]
		is.NPCs = append(is.NPCs,
			world.NPCPlacement{NPC: "bosque_druid", Pos: pos(20, 10)},
			world.NPCPlacement{NPC: "volcan_keeper", Pos: pos(20, 14)},
			world.NPCPlacement{NPC: "volcan_smith", Pos: pos(23, 10)},
			world.NPCPlacement{NPC: "volcan_forge_echo", Pos: pos(23, 14)},
			world.NPCPlacement{NPC: "volcan_priest", Pos: pos(17, 11)},
			world.NPCPlacement{NPC: "volcan_ferryman", Pos: pos(17, 13)},
		)
	},
		world.Spawn{ID: "hounds", Center: pos(40, 44), Radius: 3, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "ash_hound", Count: 10}}},
		world.Spawn{ID: "delvers", Center: pos(44, 12), Radius: 3, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "obsidian_delver", Count: 10}}},
		world.Spawn{ID: "warden", Center: pos(30, 44), Radius: 1, RespawnSeconds: 600,
			Monsters: []world.SpawnMonster{{Monster: "slagbound_warden", Count: 1}}},
	)
}

// Chapter 3 end to end: only whoever found the ember root in Chapter 2 hears the keeper
// out, at level 30; clear the hounds (kill), bring scales (gather + deliver), ask the smith
// (talk). At 35, thin the delvers (kill), bring a chart (gather + deliver) and open the
// sealed gate with the root (go to a place + open); the druid hands over the root, one at a
// time, until then. At 40, defeat the warden (kill) and return its seal for the flag of Chapter 4.
func TestChapterThreePlayable(t *testing.T) {
	h := chapterThreeHarness(t)
	c := session.Character{ID: 930, AccountID: 930, Name: "Stoker", Vocation: "guardian", Level: 29, Health: 1000, Mana: 100}
	cl, p := h.joinFresh(c, pos(20, 12))
	druid, keeper, smith, echo := h.npc("bosque_druid"), h.npc("volcan_keeper"), h.npc("volcan_smith"), h.npc("volcan_forge_echo")
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	arm := func(weapon, shield string) { p.EquipForTest(items[weapon], items[shield]) }
	hasOption := func(npc *session.NPC, key string) bool {
		d := h.lastDialog(h.send(cl, talkMsg(npc.ID())))
		for _, o := range d.Options {
			if o.Text.Key == key {
				return true
			}
		}
		return false
	}
	step := func(id string) string { _, s := h.w.QuestState(p, id); return s }
	setLevel := func(l int) {
		h.sim.Command(gameFunc(func() { h.w.SetLevelForTest(p, l) }))
		h.sim.Step()
	}
	give := func(id string, n int) {
		h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(20, 12)); h.w.GiveForTest(p, id, n) }))
		h.sim.Step()
		cl.take()
	}

	// Without the root of Chapter 2 nobody talks about the forge.
	if hasOption(keeper, "npc.volcan_keeper.opt_root") || hasOption(druid, "npc.bosque_druid.opt_take_root") {
		t.Fatal("Chapter 3 offered before Chapter 2")
	}
	h.sim.Command(gameFunc(func() { p.SetStorageForTest("flag.ember_root_found", 1) }))
	h.sim.Step()
	// Without the root in hand the keeper sends you to the druid, who hands over one, and
	// only one.
	if hasOption(keeper, "npc.volcan_keeper.opt_root") || !hasOption(keeper, "npc.volcan_keeper.opt_root_missing") {
		t.Fatal("the keeper takes the chapter without the root")
	}
	d := h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	if d = h.lastDialog(h.pick(cl, d, "npc.bosque_druid.opt_take_root")); d.Text.Key != "npc.bosque_druid.ch3_root_given" || h.w.CountItem(p, "ember_root") != 1 {
		t.Fatalf("root: %s, %d roots", d.Text.Key, h.w.CountItem(p, "ember_root"))
	}
	if hasOption(druid, "npc.bosque_druid.opt_take_root") {
		t.Fatal("the druid hands over a second root")
	}
	// Level 29: the offer shows but there is no accept.
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_root"))
	for _, o := range d.Options {
		if o.Text.Key == "dialog.accept" {
			t.Fatal("level 29 can accept Chapter 3")
		}
	}
	setLevel(30)
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_root"))
	if evs := h.pick(cl, d, "dialog.accept"); !messageKeys(evs)["dialog.quest_started"] {
		t.Fatalf("accept: %v", messageKeys(evs))
	}

	// Part 1: hounds, scales, smith.
	h.sim.Command(gameFunc(func() { arm("embersteel_sabre", "elmwood_shield"); h.w.Teleport(p, pos(37, 44)) }))
	h.huntRested(cl, p, "ash_hound", 10)
	if s := step("ch3_embers"); s != "gather_scales" {
		t.Fatalf("after ten hounds the step is %q", s)
	}
	give("salamander_scale", max(0, 5-h.w.CountItem(p, "salamander_scale")))
	if s := step("ch3_embers"); s != "gather_scales" {
		t.Fatalf("with five scales the step is %q", s)
	}
	if hasOption(smith, "npc.volcan_smith.opt_ch3_marks") {
		t.Fatal("the smith answers before the lantern")
	}
	give("salamander_scale", 1)
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	if d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_give_scales")); d.Text.Key != "npc.volcan_keeper.ch3_lantern" || h.w.CountItem(p, "salamander_scale") != 0 {
		t.Fatalf("deliver: %s, %d scales left", d.Text.Key, h.w.CountItem(p, "salamander_scale"))
	}
	money, xp := h.w.Money(p), p.Experience()
	d = h.lastDialog(h.send(cl, talkMsg(smith.ID())))
	if evs := h.pick(cl, d, "npc.volcan_smith.opt_ch3_marks"); !messageKeys(evs)["dialog.quest_completed"] {
		t.Fatalf("smith: %v", messageKeys(evs))
	}
	if s, _ := h.w.QuestState(p, "ch3_embers"); s != quest.Completed || h.w.Money(p)-money != 800 || p.Experience()-xp != 14000 {
		t.Fatalf("part 1: %v, +%d coins, +%d xp", s, h.w.Money(p)-money, p.Experience()-xp)
	}

	// Part 2 needs level 35.
	setLevel(34)
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_delvers"))
	for _, o := range d.Options {
		if o.Text.Key == "dialog.accept" {
			t.Fatal("level 34 can accept part 2")
		}
	}
	setLevel(35)
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_delvers"))
	h.pick(cl, d, "dialog.accept")
	if s := step("ch3_gate"); s != "thin_delvers" {
		t.Fatalf("part 2: %q", s)
	}
	h.sim.Command(gameFunc(func() { arm("embersteel_sabre", "embersteel_shield"); h.w.Teleport(p, pos(40, 12)) }))
	h.huntRested(cl, p, "obsidian_delver", 10)
	if h.w.CountItem(p, "delver_chart") == 0 {
		give("delver_chart", 1) // the drop itself is loot
	} else {
		h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(20, 12)) }))
		h.sim.Step()
		cl.take()
	}
	if s := step("ch3_gate"); s != "deliver_chart" {
		t.Fatalf("with a chart the step is %q", s)
	}
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_progress"))
	h.pick(cl, d, "npc.volcan_keeper.opt_give_chart")
	if s := step("ch3_gate"); s != "open_gate" {
		t.Fatalf("after the chart the step is %q", s)
	}
	if !hasOption(echo, "npc.volcan_forge_echo.opt_open") || hasOption(echo, "npc.volcan_forge_echo.opt_no_root") {
		t.Fatal("the gate does not take the root")
	}
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_progress"))
	if d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_gate_hint")); d.Text.Key != "npc.volcan_keeper.ch3_gate_hint" {
		t.Fatalf("gate hint: %s", d.Text.Key)
	}
	money, xp = h.w.Money(p), p.Experience()
	d = h.lastDialog(h.send(cl, talkMsg(echo.ID())))
	evs := h.pick(cl, d, "npc.volcan_forge_echo.opt_open")
	if !messageKeys(evs)["dialog.quest_completed"] || h.lastDialog(evs).Text.Key != "npc.volcan_forge_echo.ch3_gate_opened" {
		t.Fatalf("gate: %v", messageKeys(evs))
	}
	if h.w.CountItem(p, "ember_root") != 0 || h.w.Money(p)-money != 1100 || p.Experience()-xp != 22000 {
		t.Fatalf("part 2 rewards: root %d, +%d coins, +%d xp", h.w.CountItem(p, "ember_root"), h.w.Money(p)-money, p.Experience()-xp)
	}

	// Once the gate is open the root is spent and the druid keeps no more.
	if hasOption(druid, "npc.bosque_druid.opt_take_root") {
		t.Fatal("the druid hands over a root after the gate")
	}
	// Part 3 needs level 40, and the echo gives it.
	d = h.lastDialog(h.send(cl, talkMsg(echo.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_forge_echo.opt_warden"))
	for _, o := range d.Options {
		if o.Text.Key == "dialog.accept" {
			t.Fatal("level 35 can accept part 3")
		}
	}
	setLevel(40)
	d = h.lastDialog(h.send(cl, talkMsg(echo.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_forge_echo.opt_warden"))
	h.pick(cl, d, "dialog.accept")
	if s := step("ch3_warden"); s != "defeat_warden" {
		t.Fatalf("part 3: %q", s)
	}
	// The fight itself is TestVolcanBalance's: this fresh character has base sword skill,
	// which barely scratches the warden's armour, so it starts nearly broken.
	h.sim.Command(gameFunc(func() {
		arm("embersteel_sabre", "embersteel_shield")
		h.w.Teleport(p, pos(27, 44))
		for _, m := range h.w.Monsters() {
			if m.Kind() == "slagbound_warden" {
				m.SetHealth(20)
			}
		}
	}))
	h.huntRested(cl, p, "slagbound_warden", 1)
	if s := step("ch3_warden"); s != "take_seal" {
		t.Fatalf("after the warden the step is %q", s)
	}
	give("forge_seal", 1) // it lies in the warden's remains; taking it is looting
	// Only copper coins exist: empty the purse so the 2000 of the reward fit the backpack.
	h.sim.Command(gameFunc(func() { h.w.SpendForTest(p, h.w.Money(p)) }))
	h.sim.Step()
	money, xp = h.w.Money(p), p.Experience()
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_warden"))
	evs = h.pick(cl, d, "npc.volcan_keeper.opt_give_seal")
	if !messageKeys(evs)["dialog.quest_completed"] || h.lastDialog(evs).Text.Key != "npc.volcan_keeper.ch3_seal_read" {
		t.Fatalf("seal: %v", messageKeys(evs))
	}
	if h.w.CountItem(p, "forge_seal") != 0 || h.w.Money(p)-money != 2000 || p.Experience()-xp != 36000 || p.Storage("flag.lost_expedition_lead") != 1 {
		t.Fatalf("rewards: seal %d, +%d coins, +%d xp", h.w.CountItem(p, "forge_seal"), h.w.Money(p)-money, p.Experience()-xp)
	}
	if hasOption(keeper, "npc.volcan_keeper.opt_warden") || hasOption(keeper, "npc.volcan_keeper.opt_progress") || hasOption(echo, "npc.volcan_forge_echo.opt_warden") {
		t.Fatal("finished chapter still offered")
	}
}

// The Brasal smith buys the island's materials and the priest heals and blesses like the
// other temples.
func TestBrasalNPCs(t *testing.T) {
	h := chapterThreeHarness(t)
	c := session.Character{ID: 931, AccountID: 931, Name: "Ashwalker", Vocation: "guardian", Level: 30, Health: 500, Mana: 100}
	cl, _ := h.joinFresh(c, pos(20, 12))
	d := h.lastDialog(h.send(cl, talkMsg(h.npc("volcan_priest").ID())))
	if d = h.lastDialog(h.pick(cl, d, "npc.volcan_priest.opt_heal")); d.Text.Key != "npc.volcan_priest.healed" {
		t.Fatalf("priest: %s", d.Text.Key)
	}
	d = h.lastDialog(h.send(cl, talkMsg(h.npc("volcan_ferryman").ID())))
	if d = h.lastDialog(h.pick(cl, d, "npc.volcan_ferryman.opt_island")); d.Text.Key != "npc.volcan_ferryman.island" {
		t.Fatalf("ferryman: %s", d.Text.Key)
	}
}
