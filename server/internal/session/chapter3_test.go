package session_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// forgeGate is the sealed gate of the Chapter 3 map: the north wall of the forge room
// (27–33 × 41–47 inside rock walls), where the warden stands.
var forgeGate = pos(30, 40)

// chapterThreeHarness is dataHarness with the Cinderstead NPCs of Karvask (T5.5),
// the forest druid (who keeps the ember root), spawns of the Chapter 3 monsters and the
// forge room with the real forge gate, locked with the ember key (docs/02 "Puertas con
// llave").
func chapterThreeHarness(t *testing.T) *harness {
	t.Helper()
	return dataHarnessWith(t, func(cfg *session.Config) {
		dirt, wall := cfg.Items["dirt"].Numeric, cfg.Items["rock_wall"].Numeric
		const blocks = world.FlagBlocksMovement | world.FlagBlocksSight
		for i := 26; i <= 34; i++ {
			for _, p := range []world.Pos{pos(i, 40), pos(i, 48), pos(26, i+14), pos(34, i+14)} {
				worldtest.SetTile(t, cfg.Map, p, dirt, blocks, wall)
			}
		}
		worldtest.SetTile(t, cfg.Map, forgeGate, dirt, blocks, cfg.Items["forge_gate"].Numeric)
		// The antechamber of the sealed gate (a reach step of ch3_gate) is the tile north of it.
		gate := cfg.Quests["ch3_gate"]
		placeReach(gate.Steps[gate.StepIndex("reach_gate")].CompleteWhen.Reach, pos(30, 39), 0)
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
	// A realistic purse and pack: coins from hunting and a few tools and supplies.
	h.sim.Command(gameFunc(func() {
		h.w.GiveForTest(p, "copper_coin", 1450)
		for _, id := range []string{"pickaxe", "rope", "smithing_hammer", "ship_biscuit"} {
			h.w.GiveForTest(p, id, 1)
		}
	}))
	h.sim.Step()
	cl.take()
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
	// Lose the root (a death, say): the smith cannot read it and sends you to the druid,
	// who replaces it.
	h.sim.Command(gameFunc(func() { h.w.TakeForTest(p, "ember_root", 1) }))
	h.sim.Step()
	d = h.lastDialog(h.send(cl, talkMsg(smith.ID())))
	if d = h.lastDialog(h.pick(cl, d, "npc.volcan_smith.opt_ch3_marks")); d.Text.Key != "npc.volcan_smith.ch3_no_root" {
		t.Fatalf("smith without the root: %s", d.Text.Key)
	}
	d = h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	h.pick(cl, d, "npc.bosque_druid.opt_take_root")
	if h.w.CountItem(p, "ember_root") != 1 {
		t.Fatal("the druid did not replace the root")
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
	if s := step("ch3_gate"); s != "reach_gate" {
		t.Fatalf("after the chart the step is %q", s)
	}
	// The echo has nothing to open before the player gets down there.
	if hasOption(echo, "npc.volcan_forge_echo.opt_open") {
		t.Fatal("the echo opens the gate before reach_gate")
	}
	// Down at the sealed gate: arriving next to it is the reach step; the gate does not let
	// anyone through, and the root is no key.
	gateID := uint32(items["forge_gate"].Numeric)
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(30, 38)) }))
	h.sim.Step()
	if s := step("ch3_gate"); s != "reach_gate" {
		t.Fatalf("one tile short of the antechamber the step is %q", s)
	}
	cl.take()
	h.input(cl, walkPath(S, S))
	h.sim.RunFor(3 * time.Second)
	if p.Pos() != pos(30, 39) {
		t.Fatalf("walked into the sealed gate: at %v", p.Pos())
	}
	if evs := cl.take(); step("ch3_gate") != "open_gate" || !messageKeys(evs)["dialog.quest_updated"] {
		t.Fatalf("at the gate the step is %q (%v)", step("ch3_gate"), messageKeys(evs))
	}
	if evs := h.send(cl, useItem(onTile(forgeGate), gateID, 1)); !hasKey(evs, "door.locked") || h.w.Walkable(forgeGate) {
		t.Fatalf("the gate with the root only: %v", systemKeys(evs))
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(20, 12)) }))
	h.sim.Step()
	cl.take()
	if !hasOption(echo, "npc.volcan_forge_echo.opt_open") || hasOption(echo, "npc.volcan_forge_echo.opt_no_root") {
		t.Fatal("the gate does not take the root")
	}
	// Lose it again at the gate: it stays shut, and the druid replaces it while ch3_gate runs.
	h.sim.Command(gameFunc(func() { h.w.TakeForTest(p, "ember_root", 1) }))
	h.sim.Step()
	if hasOption(echo, "npc.volcan_forge_echo.opt_open") || !hasOption(echo, "npc.volcan_forge_echo.opt_no_root") {
		t.Fatal("the gate opens without the root")
	}
	d = h.lastDialog(h.send(cl, talkMsg(druid.ID())))
	h.pick(cl, d, "npc.bosque_druid.opt_take_root")
	if h.w.CountItem(p, "ember_root") != 1 || hasOption(druid, "npc.bosque_druid.opt_take_root") {
		t.Fatal("the druid did not replace the root once")
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
	// The echo shapes the root into the ember key; a lost key is shaped again, one at a time.
	if h.w.CountItem(p, "ember_key") != 1 || hasOption(echo, "npc.volcan_forge_echo.opt_lost_key") {
		t.Fatalf("ember keys after the gate: %d", h.w.CountItem(p, "ember_key"))
	}
	h.sim.Command(gameFunc(func() { h.w.TakeForTest(p, "ember_key", 1) }))
	h.sim.Step()
	d = h.lastDialog(h.send(cl, talkMsg(echo.ID())))
	if d = h.lastDialog(h.pick(cl, d, "npc.volcan_forge_echo.opt_lost_key")); d.Text.Key != "npc.volcan_forge_echo.key_reshaped" || h.w.CountItem(p, "ember_key") != 1 {
		t.Fatalf("lost key: %s, %d keys", d.Text.Key, h.w.CountItem(p, "ember_key"))
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
	// The ember key opens the gate (it stays in the pack) and the forge room is open.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(30, 39)) }))
	h.sim.Step()
	cl.take()
	if evs := h.send(cl, useItem(onTile(forgeGate), gateID, 1)); !hasKey(evs, "door.unlocked") || !h.w.Walkable(forgeGate) || h.w.CountItem(p, "ember_key") != 1 {
		t.Fatalf("the gate with the ember key: %v", systemKeys(evs))
	}
	h.input(cl, walkPath(S, S, S))
	h.sim.RunFor(3 * time.Second)
	// Past the gate: the third step may meet a monster of the forge room (where they stand
	// depends on the fights before, so on every number of the kit).
	if at := p.Pos(); at.X != forgeGate.X || at.Y <= forgeGate.Y || at.Z != forgeGate.Z {
		t.Fatalf("through the forge gate: at %v", at)
	}
	h.sim.Command(gameFunc(func() {
		arm("embersteel_sabre", "embersteel_shield")
		for _, m := range h.w.Monsters() {
			if m.Kind() == "slagbound_warden" {
				m.SetHealth(20)
			}
		}
	}))
	h.huntRested(cl, p, "slagbound_warden", 1)
	// The seal is a quest drop (each_player, content audit m9): it goes straight to the
	// pack of whoever hurt the warden and needs it, so take_seal is done at once.
	if s := step("ch3_warden"); s != "return_seal" || h.w.CountItem(p, "forge_seal") != 1 {
		t.Fatalf("after the warden the step is %q, %d seals", s, h.w.CountItem(p, "forge_seal"))
	}
	give("forge_seal", 0) // back to Cinderstead
	money, xp = h.w.Money(p), p.Experience()
	d = h.lastDialog(h.send(cl, talkMsg(keeper.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_keeper.opt_warden"))
	evs = h.pick(cl, d, "npc.volcan_keeper.opt_give_seal")
	if messageKeys(evs)["dialog.item_on_floor"] {
		t.Fatal("the reward fell on the floor")
	}
	if !messageKeys(evs)["dialog.quest_completed"] || h.lastDialog(evs).Text.Key != "npc.volcan_keeper.ch3_seal_read" {
		t.Fatalf("seal: %v", messageKeys(evs))
	}
	if h.w.CountItem(p, "forge_seal") != 0 || h.w.Money(p)-money != 2000 || p.Experience()-xp != 36000 || p.Storage("flag.lost_expedition_lead") != 1 {
		t.Fatalf("rewards: seal %d, +%d coins, +%d xp", h.w.CountItem(p, "forge_seal"), h.w.Money(p)-money, p.Experience()-xp)
	}
	if hasOption(keeper, "npc.volcan_keeper.opt_warden") || hasOption(keeper, "npc.volcan_keeper.opt_progress") || hasOption(echo, "npc.volcan_forge_echo.opt_warden") {
		t.Fatal("finished chapter still offered")
	}
	// Handed in, the seal is done with: another warden gives no more (content audit m9).
	var warden *session.Monster
	h.sim.RunUntil(func() bool { // Cinderstead is out of sight of the forge: it respawns
		for _, m := range h.w.Monsters() {
			if m.Kind() == "slagbound_warden" {
				warden = m
			}
		}
		return warden != nil
	}, sim.MaxSeconds(700))
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
		warden.SetHealth(10)
		h.w.DamageMonsterForTest(ctx, warden, p, 10)
	}))
	h.sim.Step()
	for _, m := range h.w.Monsters() {
		if m == warden {
			t.Fatal("the second warden did not die")
		}
	}
	if n := h.w.CountItem(p, "forge_seal"); n != 0 || len(h.w.GroundAt(p.Pos())) != 0 {
		t.Fatalf("a warden after the quest gave %d seals (or one at the feet)", n)
	}
}

// The Cinderstead smith sells every line of its shop to a normal pack (paying breaks the big
// coins and the change fits) and buys the island's materials; the priest heals and
// blesses like the other temples; the captain has a travel node.
func TestCindersteadNPCs(t *testing.T) {
	h := chapterThreeHarness(t)
	c := session.Character{ID: 931, AccountID: 931, Name: "Ashwalker", Vocation: "guardian", Level: 45, Health: 500, Mana: 100}
	cl, p := h.joinFresh(c, pos(20, 12))
	h.sim.Command(gameFunc(func() {
		h.w.GiveForTest(p, "gold_coin", 3) // the whole smithy (lote 11 added the shield) and the blessings
		h.w.GiveForTest(p, "copper_coin", 250)
		h.w.GiveForTest(p, "ash_pelt", 3)
		for _, id := range []string{"pickaxe", "rope", "ship_biscuit"} {
			h.w.GiveForTest(p, id, 1)
		}
	}))
	h.sim.Step()
	cl.take()
	smith := h.npc("volcan_smith")
	d := h.lastDialog(h.send(cl, talkMsg(smith.ID())))
	shops := find(h.pick(cl, d, "dialog.trade"), (*pb.ServerMessage).GetShopOpen)
	if len(shops) != 1 {
		t.Fatal("no shop")
	}
	money := h.w.Money(p)
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	byNum := items.ByNumeric()
	for _, o := range shops[0].Offers {
		if o.BuyPrice == 0 {
			continue
		}
		evs := h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopBuy{ShopBuy: &pb.ShopBuy{DialogId: d.DialogId, ItemId: o.ItemId, Count: 1}}})
		if !messageKeys(evs)["shop.bought"] || messageKeys(evs)["dialog.item_on_floor"] {
			t.Fatalf("buying item %d for %d: %v", o.ItemId, o.BuyPrice, messageKeys(evs))
		}
		money -= int64(o.BuyPrice)
		if h.w.Money(p) != money {
			t.Fatalf("after item %d: money %d, want %d", o.ItemId, h.w.Money(p), money)
		}
		// The band 4 kit and the forge's temper stones are more lines than one pack holds:
		// each bought piece leaves so the next one is about money, not room.
		def := byNum[uint16(o.ItemId)]
		if def == nil {
			t.Fatalf("item %d not in data/items", o.ItemId)
		}
		h.sim.Command(gameFunc(func() { h.w.TakeForTest(p, def.ID, 1) }))
		h.sim.Step()
	}
	pelt := itemNum(t, h, p, "ash_pelt")
	evs := h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopSell{ShopSell: &pb.ShopSell{DialogId: d.DialogId, ItemId: pelt, Count: 3}}})
	if !messageKeys(evs)["shop.sold"] || h.w.Money(p) != money+60 || h.w.CountItem(p, "ash_pelt") != 0 {
		t.Fatalf("selling pelts: %v, money %d", messageKeys(evs), h.w.Money(p))
	}

	priest := h.npc("volcan_priest")
	d = h.lastDialog(h.send(cl, talkMsg(priest.ID())))
	if d = h.lastDialog(h.pick(cl, d, "npc.volcan_priest.opt_heal")); d.Text.Key != "npc.volcan_priest.healed" {
		t.Fatalf("priest: %s", d.Text.Key)
	}
	money = h.w.Money(p)
	d = h.lastDialog(h.send(cl, talkMsg(priest.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_priest.opt_blessings"))
	// Content audit M6: a blessing costs 50 + 20 per level, and each option says how much.
	const blessPrice = 50 + 20*45
	for _, o := range d.Options {
		if ps := o.Text.Params; o.Text.Key != "dialog.back" && (len(ps) != 1 || ps[0].Name != "price" || ps[0].GetNumber() != blessPrice) {
			t.Fatalf("option %s params %v, want price %d", o.Text.Key, ps, blessPrice)
		}
	}
	// A level gained while the node is open: an option without a price still runs...
	h.sim.Command(gameFunc(func() { h.w.SetLevelForTest(p, 46) }))
	h.sim.Step()
	evs = h.pick(cl, d, "dialog.back")
	if d = h.lastDialog(evs); messageKeys(evs)["dialog.price_changed"] || d.Text.Key != "npc.volcan_priest.greet" {
		t.Fatalf("back after a level up: %v, node %s", messageKeys(evs), d.Text.Key)
	}
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_priest.opt_blessings"))
	if got := d.Options[0].Text.Params[0].GetNumber(); got != blessPrice+20 {
		t.Fatalf("price at level 46 = %d", got)
	}
	// ...but a blessing whose shown price is stale is refused without charging and the node
	// comes again with the new price (50 + 20 × 47).
	h.sim.Command(gameFunc(func() { h.w.SetLevelForTest(p, 47) }))
	h.sim.Step()
	evs = h.pick(cl, d, "npc.puerto_priest.bless_shore")
	d = h.lastDialog(evs)
	if !messageKeys(evs)["dialog.price_changed"] || h.w.Money(p) != money || d.Text.Key != "npc.volcan_priest.blessings" ||
		d.Options[0].Text.Params[0].GetNumber() != blessPrice+40 {
		t.Fatalf("stale price: %v, money %d, node %s %v", messageKeys(evs), h.w.Money(p), d.Text.Key, d.Options[0].Text.Params)
	}
	if d = h.lastDialog(h.pick(cl, d, "npc.puerto_priest.bless_shore")); d.Text.Key != "npc.volcan_priest.blessed" || h.w.Money(p) != money-blessPrice-40 {
		t.Fatalf("blessing: %s, money %d", d.Text.Key, h.w.Money(p))
	}
	d = h.lastDialog(h.pick(cl, d, "npc.volcan_priest.opt_more"))
	if evs := h.pick(cl, d, "npc.puerto_priest.bless_shore"); !messageKeys(evs)["dialog.already_blessed"] || h.w.Money(p) != money-blessPrice-40 {
		t.Fatalf("second blessing: %v", messageKeys(evs))
	}

	d = h.lastDialog(h.send(cl, talkMsg(h.npc("volcan_ferryman").ID())))
	if d = h.lastDialog(h.pick(cl, d, "dialog.ask_travel")); d.Text.Key != "npc.volcan_ferryman.travel" {
		t.Fatalf("ferryman: %s", d.Text.Key)
	}
}
