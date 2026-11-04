package session_test

import (
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// dataHarness runs the real content of data/ (NPCs, quests, items, monsters, balance)
// on an open 64x64 map with Puerto's NPCs placed around (10, 10) and the given spawns.
func dataHarness(t *testing.T, spawns ...world.Spawn) *harness {
	t.Helper()
	return dataHarnessWith(t, nil, spawns...)
}

// dataHarnessWith is dataHarness with a last change to the config (nil = none).
func dataHarnessWith(t *testing.T, edit func(*session.Config), spawns ...world.Spawn) *harness {
	t.Helper()
	cfg := dataConfig(t, nil, spawns...)
	h := &harness{t: t}
	cfg.Save = func(s session.Snapshot) bool { h.saves = append(h.saves, s); return true }
	if edit != nil {
		edit(&cfg)
	}
	w, err := session.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	h.w = w
	mv, fight, flush := w.Systems()
	h.sim = sim.New(t, sim.WithSeed(11), sim.WithSystems(mv, fight, flush))
	return h
}

// dataConfig is the config of dataHarness, with routes as its boat routes.
func dataConfig(t *testing.T, routes content.BoatRoutes, spawns ...world.Spawn) session.Config {
	t.Helper()
	dir := filepath.Join("..", "..", "..", "data")
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	bal, err := content.LoadBalance(dir)
	must(err)
	vocs, err := content.LoadVocations(dir)
	must(err)
	items, err := content.LoadItems(dir)
	must(err)
	monsters, err := content.LoadMonsters(dir)
	must(err)
	npcs, err := content.LoadNPCs(dir)
	must(err)
	quests, err := content.LoadQuests(dir)
	must(err)
	m := worldtest.Open(t, 0, 0, 64, 64)
	is := m.Islands()[0]
	is.Spawns = spawns
	is.NPCs = []world.NPCPlacement{
		{NPC: "harbor_master", Pos: pos(8, 10)},
		{NPC: "puerto_foreman", Pos: pos(8, 14)},
		{NPC: "puerto_provisioner", Pos: pos(12, 10)},
		{NPC: "puerto_priest", Pos: pos(12, 14)},
	}
	return session.Config{
		Map: m, Balance: bal, Vocations: vocs, Items: items, Monsters: monsters,
		NPCs: npcs, Quests: quests, BoatRoutes: routes,
		Save: func(session.Snapshot) bool { return true },
	}
}

// joinFresh logs in a character that never played (it gets the starting backpack at the
// temple) and moves it to pos.
func (h *harness) joinFresh(c session.Character, at world.Pos) (*fakeClient, *session.Player) {
	h.t.Helper()
	cl, p := h.joinChar(c)
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, at) }))
	h.sim.Step()
	cl.take()
	return cl, p
}

func (h *harness) npc(kind string) *session.NPC {
	h.t.Helper()
	for _, n := range h.w.NPCs() {
		if n.Kind() == kind {
			return n
		}
	}
	h.t.Fatalf("no NPC %s", kind)
	return nil
}

func talkMsg(id uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_NpcTalk{NpcTalk: &pb.NpcTalk{CreatureId: id}}}
}

func chooseMsg(dialog, option uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_DialogChoose{DialogChoose: &pb.DialogChoose{DialogId: dialog, OptionId: option}}}
}

// send runs one client message and returns what the client got in that tick.
func (h *harness) send(cl *fakeClient, m *pb.ClientMessage) []*pb.ServerMessage {
	h.input(cl, m)
	h.sim.Step()
	return cl.take()
}

// lastDialog returns the last DialogOpen of evs (failing if there is none).
func (h *harness) lastDialog(evs []*pb.ServerMessage) *pb.DialogOpen {
	h.t.Helper()
	ds := find(evs, (*pb.ServerMessage).GetDialogOpen)
	if len(ds) == 0 {
		h.t.Fatalf("no DialogOpen in %v", kinds(evs))
	}
	return ds[len(ds)-1]
}

// pick chooses the visible option whose text key is key and returns the next window.
func (h *harness) pick(cl *fakeClient, d *pb.DialogOpen, key string) []*pb.ServerMessage {
	h.t.Helper()
	for _, o := range d.Options {
		if o.Text.Key == key {
			return h.send(cl, chooseMsg(d.DialogId, o.OptionId))
		}
	}
	h.t.Fatalf("dialog %s has no option %s", d.Text.Key, key)
	return nil
}

func messageKeys(evs []*pb.ServerMessage) map[string]bool {
	out := map[string]bool{}
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		out[m.GetLocalized().GetKey()] = true
	}
	return out
}

// hunt fights the monsters of kind until n of them died, with chase on.
func (h *harness) hunt(cl *fakeClient, p *session.Player, kind string, n int) {
	h.t.Helper()
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	for killed := 0; killed < n; killed++ {
		var target *session.Monster
		h.sim.RunUntil(func() bool {
			for _, m := range h.w.Monsters() {
				if m.Kind() == kind {
					target = m
					return true
				}
			}
			return false
		}, sim.MaxSeconds(120))
		// The test is about the quest, not about surviving a pack: rest between fights.
		h.sim.Command(gameFunc(func() { h.w.RestoreForTest(p) }))
		h.input(cl, setTarget(target.ID()))
		h.sim.RunUntil(func() bool {
			for _, m := range h.w.Monsters() {
				if m == target {
					return false
				}
			}
			return true
		}, sim.MaxSeconds(300))
	}
	h.sim.Step()
}

// Chapter 1 end to end, as a guardian: accept ch1_shipwreck from the harbor master,
// hunt six wolves and five gloom bats, get the bosun's logbook from the foreman and
// hand it in for the guardian's reward and the quest rewards. Progress is saved.
func TestChapterOnePlayable(t *testing.T) {
	h := dataHarness(t,
		world.Spawn{ID: "wolves", Center: pos(40, 44), Radius: 3, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "wolf", Count: 6}}},
		world.Spawn{ID: "bats", Center: pos(44, 12), Radius: 3, RespawnSeconds: 60,
			Monsters: []world.SpawnMonster{{Monster: "gloom_bat", Count: 5}}},
	)
	c := session.Character{ID: 900, AccountID: 900, Name: "Castaway", Vocation: "guardian", Level: 20, Health: 1000, Mana: 100}
	cl, p := h.joinFresh(c, pos(10, 10))
	h.sim.Step()
	cl.take()
	master, foreman := h.npc("harbor_master"), h.npc("puerto_foreman")
	if !p.Knows(master.ID()) {
		t.Fatal("the client does not know the harbor master")
	}

	// Accept the quest: the guardian's kit and the first step.
	d := h.lastDialog(h.send(cl, talkMsg(master.ID())))
	if d.Text.Key != "npc.harbor_master.greet" || d.NpcCreatureId != master.ID() {
		t.Fatalf("greet: %+v", d)
	}
	d = h.lastDialog(h.pick(cl, d, "npc.harbor_master.opt_shipwreck"))
	if len(d.Options) != 2 { // one accept (the guardian's) and decline
		t.Fatalf("offer options %v", d.Options)
	}
	evs := h.pick(cl, d, "dialog.accept")
	if !messageKeys(evs)["dialog.quest_started"] || h.w.CountItem(p, "rusty_cutlass") != 1 || h.w.CountItem(p, "ship_biscuit") != 1 {
		t.Fatalf("accept: messages %v, cutlass %d", messageKeys(evs), h.w.CountItem(p, "rusty_cutlass"))
	}
	if s, step := h.w.QuestState(p, "ch1_shipwreck"); s != quest.InProgress || step != "clear_wolves" {
		t.Fatalf("quest %v %q", s, step)
	}
	d = h.lastDialog(evs)
	h.pick(cl, d, "dialog.bye")
	if evs := h.send(cl, talkMsg(master.ID())); h.lastDialog(evs).Options[0].Text.Key != "npc.harbor_master.opt_ch1_wolves" {
		t.Fatal("the greeting should now ask about the wolves")
	}

	// Walking away closes the dialog.
	h.input(cl, walkPath(E, E, E, E))
	h.sim.RunFor(5e9)
	if evs := cl.take(); len(find(evs, (*pb.ServerMessage).GetDialogClose)) != 1 {
		t.Fatalf("walking away: %v", kinds(evs))
	}

	// Wolves, then bats.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(36, 44)) }))
	h.hunt(cl, p, "wolf", 6)
	if _, step := h.w.QuestState(p, "ch1_shipwreck"); step != "mine_bats" {
		t.Fatalf("after six wolves the step is %q", step)
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(40, 12)) }))
	h.hunt(cl, p, "gloom_bat", 5)
	if _, step := h.w.QuestState(p, "ch1_shipwreck"); step != "talk_foreman" {
		t.Fatalf("after five bats the step is %q", step)
	}

	// The foreman hands over the logbook.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(9, 13)) }))
	h.sim.Step()
	cl.take()
	d = h.lastDialog(h.send(cl, talkMsg(foreman.ID())))
	h.pick(cl, d, "npc.puerto_foreman.opt_ch1_bosun")
	if _, step := h.w.QuestState(p, "ch1_shipwreck"); step != "return_logbook" || h.w.CountItem(p, "bosun_logbook") != 1 {
		t.Fatalf("after the foreman: step %q", step)
	}

	// Hand it in: the guardian gets the iron sword, plus 800 xp, 150 coins and the route.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(9, 11)) }))
	h.sim.Step()
	cl.take()
	money, xp := h.w.Money(p), p.Experience()
	d = h.lastDialog(h.send(cl, talkMsg(master.ID())))
	for _, o := range d.Options {
		if o.OptionId == 6 { // the arcanist's branch is hidden
			t.Fatal("the guardian sees the arcanist's option")
		}
	}
	evs = h.pick(cl, d, "npc.harbor_master.opt_ch1_logbook")
	if s, _ := h.w.QuestState(p, "ch1_shipwreck"); s != quest.Completed {
		t.Fatalf("quest state %v", s)
	}
	if !messageKeys(evs)["dialog.quest_completed"] || h.lastDialog(evs).Text.Key != "npc.harbor_master.ch1_logbook_read" {
		t.Fatalf("hand in: %v", messageKeys(evs))
	}
	if h.w.CountItem(p, "iron_sword") != 1 || h.w.CountItem(p, "bosun_logbook") != 0 {
		t.Fatal("logbook not swapped for the iron sword")
	}
	if h.w.Money(p)-money != 150 || p.Experience()-xp != 800 || p.Storage("flag.forest_route_unlocked") != 1 {
		t.Fatalf("rewards: +%d coins, +%d xp, flag %d", h.w.Money(p)-money, p.Experience()-xp, p.Storage("flag.forest_route_unlocked"))
	}

	// Saved with the character.
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	last := h.saves[len(h.saves)-1]
	if !last.Final || last.Storage["quest.ch1_shipwreck"] != int64(quest.Completed) || last.Storage["flag.forest_route_unlocked"] != 1 {
		t.Fatalf("final snapshot storage %v", last.Storage)
	}
}

// The arcanist accepts the same quest and gets coins instead of a weapon; options are
// checked again on the server.
func TestArcanistBranchAndStaleOptions(t *testing.T) {
	h := dataHarness(t)
	c := session.Character{ID: 901, AccountID: 901, Name: "Mage", Vocation: "arcanist", Level: 1, Health: 100, Mana: 100}
	cl, p := h.joinFresh(c, pos(10, 10))
	master := h.npc("harbor_master")
	d := h.lastDialog(h.send(cl, talkMsg(master.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.harbor_master.opt_shipwreck"))
	// The guardian's accept (option 1) is hidden: choosing it anyway does nothing.
	if evs := h.send(cl, chooseMsg(d.DialogId, 1)); h.w.Money(p) != 0 || h.lastDialog(evs).Text.Key != "npc.harbor_master.ch1_offer" {
		t.Fatal("a hidden option ran")
	}
	h.pick(cl, d, "dialog.accept")
	if h.w.Money(p) != 25 || h.w.CountItem(p, "rusty_cutlass") != 0 {
		t.Fatalf("arcanist kit: %d coins", h.w.Money(p))
	}
	// A stale dialog id is ignored; option 0 closes.
	if evs := h.send(cl, chooseMsg(d.DialogId+5, 1)); len(evs) != 0 {
		t.Fatalf("stale dialog answered %v", kinds(evs))
	}
	if evs := h.send(cl, chooseMsg(d.DialogId, 0)); len(find(evs, (*pb.ServerMessage).GetDialogClose)) != 1 {
		t.Fatal("option 0 should close")
	}
	// Too far to talk: in view but beyond TalkRange, and out of view.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(8+session.TalkRange+1, 10)) }))
	h.sim.Step()
	cl.take()
	if evs := h.send(cl, talkMsg(master.ID())); !messageKeys(evs)["dialog.too_far"] {
		t.Fatalf("talking from afar: %v", messageKeys(evs))
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(30, 30)) }))
	h.sim.Step()
	cl.take()
	if evs := h.send(cl, talkMsg(master.ID())); !messageKeys(evs)["inventory.not_possible"] {
		t.Fatalf("talking to an NPC out of view: %v", messageKeys(evs))
	}
}

// Shops: buying pays with coins and needs room; selling takes from the backpack.
func TestShopBuyAndSell(t *testing.T) {
	h := dataHarness(t)
	c := session.Character{ID: 902, AccountID: 902, Name: "Trader", Vocation: "guardian", Level: 1, Health: 145, Mana: 20}
	cl, p := h.joinFresh(c, pos(11, 11))
	prov := h.npc("puerto_provisioner")
	h.sim.Command(gameFunc(func() {
		h.w.GiveForTest(p, "copper_coin", 130)
		h.w.GiveForTest(p, "wolf_pelt", 3)
	}))
	h.sim.Step()
	cl.take()
	d := h.lastDialog(h.send(cl, talkMsg(prov.ID())))
	evs := h.pick(cl, d, "dialog.trade")
	shops := find(evs, (*pb.ServerMessage).GetShopOpen)
	if len(shops) != 1 || shops[0].Money != 130 || shops[0].DialogId != d.DialogId {
		t.Fatalf("shop: %v", shops)
	}
	var rope, pelt *pb.ShopOffer
	for _, o := range shops[0].Offers {
		switch o.ItemId {
		case itemNum(t, h, p, "rope"):
			rope = o
		case itemNum(t, h, p, "wolf_pelt"):
			pelt = o
		}
	}
	if rope == nil || rope.BuyPrice != 45 || rope.SellPrice != 14 || pelt == nil || pelt.Owned != 3 || pelt.BuyPrice != 0 {
		t.Fatalf("offers rope %v pelt %v", rope, pelt)
	}
	buy := func(item uint32, n uint32) []*pb.ServerMessage {
		return h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopBuy{ShopBuy: &pb.ShopBuy{DialogId: d.DialogId, ItemId: item, Count: n}}})
	}
	sell := func(item uint32, n uint32) []*pb.ServerMessage {
		return h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopSell{ShopSell: &pb.ShopSell{DialogId: d.DialogId, ItemId: item, Count: n}}})
	}
	if evs := buy(rope.ItemId, 3); !messageKeys(evs)["shop.no_money"] || h.w.Money(p) != 130 {
		t.Fatal("bought three ropes with 130 coins")
	}
	evs = buy(rope.ItemId, 2)
	if h.w.Money(p) != 40 || h.w.CountItem(p, "rope") != 2 || find(evs, (*pb.ServerMessage).GetShopOpen)[0].Money != 40 {
		t.Fatalf("buy: money %d ropes %d", h.w.Money(p), h.w.CountItem(p, "rope"))
	}
	if evs := sell(pelt.ItemId, 4); !messageKeys(evs)["shop.not_enough"] {
		t.Fatal("sold more pelts than carried")
	}
	sell(pelt.ItemId, 3)
	if h.w.Money(p) != 55 || h.w.CountItem(p, "wolf_pelt") != 0 {
		t.Fatalf("sell: money %d pelts %d", h.w.Money(p), h.w.CountItem(p, "wolf_pelt"))
	}
	if evs := buy(itemNum(t, h, p, "wolf_pelt"), 1); !messageKeys(evs)["inventory.not_possible"] {
		t.Fatal("bought an item the shop does not sell")
	}
	// A full backpack refuses the purchase instead of dropping it on the floor.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "copper_coin", 100); h.w.GiveForTest(p, "rope", 30) }))
	h.sim.Step()
	cl.take()
	money, ropes := h.w.Money(p), h.w.CountItem(p, "rope")
	if evs := buy(rope.ItemId, 1); !messageKeys(evs)["shop.no_room"] {
		t.Fatalf("buying with a full backpack: %v", messageKeys(evs))
	}
	if h.w.Money(p) != money || h.w.CountItem(p, "rope") != ropes {
		t.Fatal("a refused purchase changed the inventory")
	}
}

func itemNum(t *testing.T, h *harness, _ *session.Player, id string) uint32 {
	t.Helper()
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil || items[id] == nil {
		t.Fatalf("item %s: %v", id, err)
	}
	return uint32(items[id].Numeric)
}
