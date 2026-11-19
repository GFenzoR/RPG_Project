package session_test

import (
	"math/rand/v2"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Item attributes (docs/02 "Atributos de items"): every equipable rolls one attribute at
// every creation, never a stack or a container, and every path that moves an instance
// keeps it exactly; what the worn ones add goes into the formulas.

// attrPool is the pool of data/attributes.yaml.
func attrPool(t testing.TB) content.Attributes {
	t.Helper()
	as, err := content.LoadAttributes(filepath.Join("..", "..", "..", "data"))
	if err != nil || len(as) == 0 {
		t.Fatalf("attributes: %v (%d)", err, len(as))
	}
	return as
}

// withAttributes turns the pool on with a fixed seed.
func withAttributes(t testing.TB) option {
	return func(c *session.Config) {
		c.Attributes = attrPool(t)
		c.Rand = rand.New(rand.NewPCG(3, 4))
	}
}

const bootsID = 92

// withBoots adds test boots (feet) to the items.
func withBoots(c *session.Config) {
	var it content.Item
	_ = yaml.Unmarshal([]byte("{id: test_boots, kind: armor, weight: 900, tradeable: true, armor: {slot: feet, armor: 1}}"), &it)
	it.Numeric = bootsID
	c.Items[it.ID] = &it
}

// rolled is a saved instance of item id with attribute attr of value v.
func rolled(id uint16, slot int, attr string, v int) session.ItemState {
	return session.ItemState{ItemID: id, Count: 1, Slot: slot, Mods: session.Mods{Attr: attr, Value: v}}
}

func mods(attr string, v int) session.Mods { return session.Mods{Attr: attr, Value: v} }

// checkRolled fails unless m is one attribute of the pool that it rolls on def, with a
// value in its band.
func checkRolled(t *testing.T, pool content.Attributes, def *content.Item, m session.Mods) {
	t.Helper()
	a := pool.ByID(m.Attr)
	if a == nil || !slices.Contains(pool.For(def), a) {
		t.Fatalf("%s rolled %+v, not one of its pool", def.ID, m)
	}
	if b := a.Band(def.Requires.Level); m.Value < b.Min || m.Value > b.Max || m.Refine != 0 {
		t.Fatalf("%s rolled %+v outside %+v", def.ID, m, b)
	}
}

func itemMods(s *pb.ItemStack) session.Mods {
	m := s.GetMods()
	return session.Mods{Attr: m.GetAttribute(), Value: int(m.GetValue()), Refine: int(m.GetRefine())}
}

// Loot, and every giveItem (shops, quest and dialog rewards, crafting, staff, the
// tutorial): each equipable rolls its own attribute; stacks and containers never do. The
// rolls come from the seeded source: the same seed rolls the same.
func TestEveryCreatedEquipableRollsOneAttribute(t *testing.T) {
	run := func() ([]session.Mods, []session.Mods) {
		armory := &content.Monster{ID: "armory", Health: 5, Experience: 1, Speed: 100,
			Loot: []content.LootEntry{{Item: "test_sword", Chance: 1, Count: []int{2, 2}},
				{Item: "test_salve", Chance: 1, Count: []int{3, 3}}}}
		m := worldtest.Open(t, 0, 0, 64, 64)
		m.Islands()[0].Spawns = []world.Spawn{spawnAt("armory", 20, 20, 0, 600)}
		h := newHarness(t, m, func(c *session.Config) {
			c.Monsters = content.Monsters{"armory": armory}
			c.Items = testItems()
		}, withAttributes(t))
		_, p := h.joinChar(withPack(9500+nextChar, pos(30, 30)))
		h.sim.RunTicks(2)
		mon := onlyMonster(t, h)
		at := mon.Pos()
		h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) { h.w.KillForTest(ctx, mon) }))
		h.sim.Step()
		pool, items := attrPool(t), testItems()
		var loot []session.Mods
		for _, s := range h.w.CorpsesAt(at)[0].Loot() {
			switch s.GetItemId() {
			case swordID:
				checkRolled(t, pool, items["test_sword"], itemMods(s))
				loot = append(loot, itemMods(s))
			case salveID:
				if s.GetMods() != nil {
					t.Fatalf("a stack rolled %v", s.GetMods())
				}
			}
		}
		if len(loot) != 2 {
			t.Fatalf("loot %v", h.w.CorpsesAt(at)[0].Loot())
		}
		// The log names each instance with its attribute.
		var logged []session.Mods
		for _, e := range h.economy {
			if e.Kind == session.EconLoot && e.ItemID == swordID {
				logged = append(logged, e.Mods)
			}
		}
		if !slices.Equal(logged, loot) {
			t.Fatalf("loot log %v, loot %v", logged, loot)
		}
		h.sim.Command(gameFunc(func() {
			h.w.GiveForTest(p, "test_tunic", 2)
			h.w.GiveForTest(p, "test_salve", 5)
			h.w.GiveForTest(p, "test_bag", 1)
		}))
		h.sim.Step()
		var given []session.Mods
		for _, it := range h.w.ItemsForTest(p, "test_tunic") {
			checkRolled(t, pool, items["test_tunic"], it.Mods())
			given = append(given, it.Mods())
		}
		for _, id := range []string{"test_salve", "test_bag", "backpack"} {
			for _, it := range h.w.ItemsForTest(p, id) {
				if !it.Mods().Zero() {
					t.Fatalf("%s rolled %+v", id, it.Mods())
				}
			}
		}
		if len(given) != 2 {
			t.Fatalf("tunics %v", given)
		}
		return loot, given
	}
	loot, given := run()
	again, givenAgain := run()
	if !slices.Equal(loot, again) || !slices.Equal(given, givenAgain) {
		t.Fatalf("not deterministic: %v %v / %v %v", loot, given, again, givenAgain)
	}
}

// An NPC shop sells equipables that roll (the Isla de Pruebas' merchant too) and buys
// them back at the base price whatever their attribute; a dialog's give_item rolls too
// (the captain's chapter 1 kit).
func TestShopAndDialogItemsRoll(t *testing.T) {
	h := dataHarnessWith(t, func(c *session.Config) {
		withAttributes(t)(c)
		is := c.Map.Islands()[0]
		is.NPCs = append(is.NPCs, world.NPCPlacement{NPC: "puerto_armorer", Pos: pos(16, 10)})
	})
	pool := attrPool(t)
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	c := session.Character{ID: 9601, AccountID: 9601, Name: "Kit", Vocation: "guardian", Level: 1, Health: 145, Mana: 20}
	cl, p := h.joinFresh(c, pos(10, 10))
	master := h.npc("harbor_master")
	d := h.lastDialog(h.send(cl, talkMsg(master.ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.harbor_master.opt_shipwreck"))
	h.pick(cl, d, "dialog.accept")
	kit := h.w.ItemsForTest(p, "rusty_cutlass")
	if len(kit) != 1 {
		t.Fatalf("the kit gave %d cutlasses", len(kit))
	}
	checkRolled(t, pool, items["rusty_cutlass"], kit[0].Mods())

	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(15, 10)); h.w.GiveForTest(p, "copper_coin", 100) }))
	h.sim.Step()
	cl.take()
	d = h.lastDialog(h.send(cl, talkMsg(h.npc("puerto_armorer").ID())))
	evs := h.pick(cl, d, "dialog.trade")
	shop := find(evs, (*pb.ServerMessage).GetShopOpen)[0]
	tunic := uint32(items["patched_tunic"].Numeric)
	h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopBuy{ShopBuy: &pb.ShopBuy{DialogId: shop.DialogId, ItemId: tunic, Count: 2}}})
	bought := h.w.ItemsForTest(p, "patched_tunic")
	if len(bought) != 2 {
		t.Fatalf("bought %d tunics", len(bought))
	}
	var logged []session.Mods
	for _, it := range bought {
		checkRolled(t, pool, items["patched_tunic"], it.Mods())
	}
	for _, e := range h.economy {
		if e.Kind == session.EconNPCBuy && e.ItemID == uint16(tunic) {
			if e.Count != 1 {
				t.Fatalf("an equipable's entry counts %d", e.Count)
			}
			logged = append(logged, e.Mods)
		}
	}
	if !slices.Equal(logged, []session.Mods{bought[0].Mods(), bought[1].Mods()}) {
		t.Fatalf("logged %v", logged)
	}
	// Selling one back pays its base price (data: 8 for the cutlass), whatever it rolled.
	money := h.w.Money(p)
	cutlass := uint32(items["rusty_cutlass"].Numeric)
	h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopSell{ShopSell: &pb.ShopSell{DialogId: shop.DialogId, ItemId: cutlass, Count: 1}}})
	if h.w.Money(p) != money+8 || len(h.w.ItemsForTest(p, "rusty_cutlass")) != 0 {
		t.Fatalf("sold for %d", h.w.Money(p)-money)
	}
	sold := false
	for _, e := range h.economy {
		sold = sold || e.Kind == session.EconNPCSell && e.ItemID == uint16(cutlass) && e.Count == -1 && e.Mods == kit[0].Mods()
	}
	if !sold {
		t.Fatal("the sale does not name the instance")
	}
}

// A crafted equipable rolls its attribute; the log names it.
func TestCraftedEquipableRolls(t *testing.T) {
	h := craftHarness(t, worldtest.Map(t, 0, 0, 7, forgeMap...), withAttributes(t))
	cl, p := crafter(h, pos(1, 0), stack(ingotID, 2, 0), stack(hammerID, 1, 1))
	h.w.TrainForTest(p, "smithing", 200)
	if evs := h.craft(cl, "blade", pos(0, 0)); !hasKey(evs, "craft.done") {
		t.Fatalf("craft: %v", systemKeys(evs))
	}
	blades := h.w.ItemsForTest(p, "test_blade")
	if len(blades) != 1 {
		t.Fatalf("%d blades", len(blades))
	}
	checkRolled(t, attrPool(t), blades[0].Def(), blades[0].Mods())
	for _, e := range h.economy {
		if e.Kind == session.EconCraft && e.ItemID == bladeID && (e.Count != 1 || e.Mods != blades[0].Mods()) {
			t.Fatalf("craft log %+v", e)
		}
	}
}

// A staff /item rolls each instance.
func TestStaffItemRolls(t *testing.T) {
	a := newAdminHarness(t, withAttributes(t))
	cl, p := a.joinAs("Keeper", session.RoleAdmin, pos(5, 5))
	a.cmd(cl, "/item test_sword 2")
	got := a.w.GroundAt(p.Pos()) // no backpack: it lands under the admin
	if len(got) != 2 {
		t.Fatalf("/item gave %d swords", len(got))
	}
	for _, it := range got {
		checkRolled(t, attrPool(t), it.Def(), it.Mods())
	}
}

// A saved equipable keeps its attribute through the save; one saved before attributes
// existed rolls once on load and is saved with it.
func TestSavedEquipablesKeepOrRollTheirAttribute(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) { c.Items = testItems() },
		withAttributes(t))
	nextChar++
	c := withPack(nextChar, pos(5, 5), rolled(tunicID, 0, "armor", 1), stack(swordID, 1, 1))
	cl, p := h.joinChar(c)
	tunic, sword := h.w.ItemsForTest(p, "test_tunic"), h.w.ItemsForTest(p, "test_sword")
	if len(tunic) != 1 || tunic[0].Mods() != mods("armor", 1) || len(sword) != 1 {
		t.Fatalf("tunic %v sword %v", tunic, sword)
	}
	checkRolled(t, attrPool(t), sword[0].Def(), sword[0].Mods())
	h.sim.Command(h.w.ForceSaveForTest(cl))
	h.sim.Step()
	inv := h.saves[len(h.saves)-1].Inventory
	pack := inv[0].Items
	if len(pack) != 2 || pack[0].Mods != mods("armor", 1) || pack[1].Mods != sword[0].Mods() {
		t.Fatalf("saved %+v", inv)
	}
	// The next login reads it back as it was: no new roll.
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	c.Inventory = inv
	_, p = h.joinChar(c)
	if got := h.w.ItemsForTest(p, "test_sword"); len(got) != 1 || got[0].Mods() != sword[0].Mods() {
		t.Fatalf("after relogin %v, saved %+v", got, sword[0].Mods())
	}
}

// Moving an instance (to a slot, the ground, a container and back) moves it whole: what
// every client is sent carries the attribute, and nothing doubles or goes missing.
func TestMovesKeepTheAttribute(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) { c.Items = testItems() },
		withAttributes(t))
	nextChar++
	cl, p := h.joinChar(withPack(nextChar, pos(5, 5), rolled(swordID, 0, "sword_skill", 2),
		rolled(swordID, 1, "attack", 3), stack(bagID, 1, 2)))
	win := openPack(t, h, cl)
	want := mods("attack", 3)
	sword := h.w.ItemsForTest(p, "test_sword")[1]

	evs := h.send(cl, moveItem(inContainer(win, 1), swordID, 0, inSlot(slotRight), 1))
	inv := find(evs, (*pb.ServerMessage).GetInventory)
	if len(inv) == 0 || p.Equipped(slotRight) != sword {
		t.Fatalf("equip: %v", kinds(evs))
	}
	for _, s := range inv[len(inv)-1].GetSlots() {
		if s.GetSlot() == slotRight && itemMods(s.GetItem()) != want {
			t.Fatalf("Inventory slot %v", s)
		}
	}
	h.send(cl, moveItem(inSlot(slotRight), swordID, 0, onTile(pos(6, 5)), 1))
	g := h.w.GroundAt(pos(6, 5))
	if len(g) != 1 || g[0] != sword {
		t.Fatalf("ground %v", g)
	}
	// Into the bag (index 1 of the backpack now: the other sword is 0).
	evs = h.send(cl, moveItem(onTile(pos(6, 5)), swordID, 1, inContainer(win, 1), 1))
	if len(h.w.GroundAt(pos(6, 5))) != 0 || sword.Mods() != want {
		t.Fatalf("pick up: %v", kinds(evs))
	}
	all := h.w.ItemsForTest(p, "test_sword")
	if len(all) != 2 || !slices.Contains(all, sword) {
		t.Fatalf("swords %v", all)
	}
	got := []session.Mods{all[0].Mods(), all[1].Mods()}
	if !slices.Contains(got, want) || !slices.Contains(got, mods("sword_skill", 2)) {
		t.Fatalf("mods %v", got)
	}
}

// A trade hands over the very instances: the attribute arrives, both logs name it.
func TestTradeKeepsTheAttribute(t *testing.T) {
	h := newMarketHarness(t, withAttributes(t))
	ca, a := h.trader("Ana", pos(2, 2), rolled(swordID, 0, "life_leech", 2))
	cb, b := h.trader("Beto", pos(3, 2), stack(salveID, 4, 0))
	h.startTrade(ca, cb, a, b, swordID, salveID)
	h.send(ca, tradeAccept)
	h.send(cb, tradeAccept)
	got := h.w.ItemsForTest(b, "test_sword")
	if len(got) != 1 || got[0].Mods() != mods("life_leech", 2) || len(h.w.ItemsForTest(a, "test_sword")) != 0 {
		t.Fatalf("Beto got %v", got)
	}
	var out, in bool
	for _, e := range h.economy {
		if e.Kind == session.EconTrade && e.ItemID == swordID && e.Mods == mods("life_leech", 2) {
			out, in = out || e.Count == -1, in || e.Count == 1
		}
	}
	if !out || !in {
		t.Fatal("the trade log does not name the instance")
	}
}

// A sell offer of an equipable is the one instance the seller picked: listed with its
// attribute, bought as it is; cancelled, it waits in the mailbox as it is.
func TestMarketSellOfferIsTheInstance(t *testing.T) {
	h := newMarketHarness(t, withAttributes(t))
	cs, s := h.atBoard("Sela", pos(1, 0), rolled(swordID, 0, "attack", 1), rolled(swordID, 1, "attack", 2),
		stack(coinID, 50, 2))
	cb, b := h.atBoard("Bruno", pos(0, 1), stack(coinID, 100, 0))
	browse := marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Browse{Browse: &pb.MarketBrowse{ItemId: swordID}}})
	u := lastMarket(h.send(cs, browse))
	if len(u.GetOwnedMods()) != 2 || u.GetOwned() != 2 || itemMods(&pb.ItemStack{Mods: u.GetOwnedMods()[1]}) != mods("attack", 2) {
		t.Fatalf("owned mods %v", u.GetOwnedMods())
	}
	sellOf := func(n uint32, m session.Mods) *pb.ClientMessage {
		return marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Create{Create: &pb.MarketCreate{
			Side: pb.MarketSide_MARKET_SIDE_SELL, ItemId: swordID, Amount: n, Price: 30,
			Mods: &pb.ItemMods{Attribute: m.Attr, Value: int32(m.Value)}}}})
	}
	if !hasKey(h.send(cs, sellOf(2, mods("attack", 2))), "market.bad_amount") {
		t.Fatal("two instances in one offer")
	}
	if !hasKey(h.send(cs, sellOf(1, mods("attack", 5))), "market.not_enough_items") {
		t.Fatal("an instance Sela does not have")
	}
	if !hasKey(h.send(cs, sellOf(1, mods("attack", 2))), "market.created") {
		t.Fatal("not created")
	}
	left := h.w.ItemsForTest(s, "test_sword")
	ids := h.w.MarketOffers(s.CharacterID())
	if len(left) != 1 || left[0].Mods() != mods("attack", 1) || h.w.MarketOfferModsForTest(ids[0]) != mods("attack", 2) {
		t.Fatalf("left %v, offer %+v", left, h.w.MarketOfferModsForTest(ids[0]))
	}
	if tr := h.transfers[len(h.transfers)-1]; tr.Market[0].Offer.Mods != mods("attack", 2) {
		t.Fatalf("stored offer %+v", tr.Market[0].Offer)
	}
	u = lastMarket(h.send(cb, browse))
	if len(u.GetSells()) != 1 || itemMods(&pb.ItemStack{Mods: u.GetSells()[0].GetMods()}) != mods("attack", 2) {
		t.Fatalf("listing %v", u.GetSells())
	}
	h.send(cb, acceptOffer(ids[0], 1))
	if got := h.w.ItemsForTest(b, "test_sword"); len(got) != 1 || got[0].Mods() != mods("attack", 2) {
		t.Fatalf("Bruno bought %v", got)
	}
	// The other one: posted, cancelled, back through the mailbox as it was.
	h.send(cs, sellOf(1, mods("attack", 1)))
	id := h.w.MarketOffers(s.CharacterID())[0]
	h.send(cs, cancelOffer(id))
	if _, mail := h.w.Mailbox(s.CharacterID()); len(mail) != 1 || mail[0].Mods != mods("attack", 1) {
		t.Fatalf("mailbox %+v", mail)
	}
	u = lastMarket(h.send(cs, browse))
	if len(u.GetMailboxItems()) != 1 || itemMods(u.GetMailboxItems()[0].GetItem()) != mods("attack", 1) {
		t.Fatalf("mailbox shown %v", u.GetMailboxItems())
	}
	h.send(cs, withdraw)
	if got := h.w.ItemsForTest(s, "test_sword"); len(got) != 1 || got[0].Mods() != mods("attack", 1) {
		t.Fatalf("withdrawn %v", got)
	}
	h.sim.Step()
}

// A buy offer of an equipable is filled by any instance, one at a time: the seller
// picks which, and that one reaches the buyer's mailbox.
func TestMarketBuyOfferTakesThePickedInstance(t *testing.T) {
	h := newMarketHarness(t, withAttributes(t))
	cb, b := h.atBoard("Bruno", pos(1, 0), stack(coinID, 100, 0))
	cs, s := h.atBoard("Sela", pos(0, 1), rolled(swordID, 0, "attack", 1), rolled(swordID, 1, "defense", 2))
	h.send(cb, createOffer(pb.MarketSide_MARKET_SIDE_BUY, swordID, 2, 10))
	id := h.w.MarketOffers(b.CharacterID())[0]
	acceptOf := func(n uint32, m session.Mods) *pb.ClientMessage {
		return marketCmd(&pb.MarketCommand{Action: &pb.MarketCommand_Accept{Accept: &pb.MarketAccept{
			OfferId: uint64(id), Amount: n, Mods: &pb.ItemMods{Attribute: m.Attr, Value: int32(m.Value)}}}})
	}
	if !hasKey(h.send(cs, acceptOf(2, mods("defense", 2))), "market.bad_amount") {
		t.Fatal("two instances at once")
	}
	if !hasKey(h.send(cs, acceptOf(1, mods("defense", 2))), "market.sold") {
		t.Fatal("not sold")
	}
	if got := h.w.ItemsForTest(s, "test_sword"); len(got) != 1 || got[0].Mods() != mods("attack", 1) {
		t.Fatalf("Sela kept %v", got)
	}
	if _, mail := h.w.Mailbox(b.CharacterID()); len(mail) != 1 || mail[0].Mods != mods("defense", 2) {
		t.Fatalf("Bruno's mailbox %+v", mail)
	}
	h.send(cb, withdraw)
	if got := h.w.ItemsForTest(b, "test_sword"); len(got) != 1 || got[0].Mods() != mods("defense", 2) {
		t.Fatalf("Bruno withdrew %v", got)
	}
	h.sim.Step()
}

// What a death drops goes into the corpse as it was.
func TestDeathKeepsTheAttribute(t *testing.T) {
	h := deathHarness(t, func(c *session.Config) { c.Balance.Death.EquipmentDropPct = 100 }, withAttributes(t))
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: "Doomed", Vocation: "guardian", Level: 20,
		Experience: testBalance().Experience.TotalFor(20) + 100, Health: 145, Pos: pos(40, 40), HasPos: true,
		InventoryLoaded: true, // past the novice levels: the equipment drops
		Inventory:       []session.ItemState{rolled(swordID, int(slotRight), "attack", 2), rolled(tunicID, int(slotArmor), "armor", 1)}}
	_, p := h.joinChar(c)
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) { h.w.DieForTest(ctx, p) }))
	h.sim.Step()
	cs := h.w.CorpsesAt(pos(40, 40))
	if len(cs) != 1 {
		t.Fatalf("corpses %v", cs)
	}
	got := map[uint32]session.Mods{}
	for _, s := range cs[0].Loot() {
		got[s.GetItemId()] = itemMods(s)
	}
	if got[swordID] != mods("attack", 2) || got[tunicID] != mods("armor", 1) {
		t.Fatalf("corpse %v", cs[0].Loot())
	}
}

// A house floor keeps its items' attributes; an old one without rolls on load and the
// house is written again with it.
func TestHouseFloorKeepsTheAttribute(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	load := func(sword session.ItemState) *houseHarness {
		h := newHouseHarness(t, withAttributes(t), func(c *session.Config) {
			c.Houses = &session.HouseData{
				Owners: []session.HouseOwner{{HouseID: "cottage", CharacterID: 9700, AccountID: 9700, Name: "Ana",
					PaidUntil: now.Add(100 * 24 * time.Hour), Since: now}},
				Items: []session.HouseItem{{HouseID: "cottage", Pos: pos(2, 2), Item: sword}},
			}
		})
		h.sim.RunTicks(2)
		return h
	}
	h := load(rolled(swordID, 0, "attack", 2))
	if g := h.w.GroundAt(pos(2, 2)); len(g) != 1 || g[0].Mods() != mods("attack", 2) || len(h.transfers) != 0 {
		t.Fatalf("loaded %v, %d transfers", g, len(h.transfers))
	}
	h = load(stack(swordID, 1, 0))
	g := h.w.GroundAt(pos(2, 2))
	if len(g) != 1 || g[0].Mods().Zero() {
		t.Fatalf("an old sword did not roll: %v", g)
	}
	written := false
	for _, tr := range h.transfers {
		for _, op := range tr.Houses {
			if op.Kind == session.HouseItems && op.House == "cottage" && len(op.Items) == 1 && op.Items[0].Item.Mods == g[0].Mods() {
				written = true
			}
		}
	}
	if !written {
		t.Fatalf("the rolled attribute was not written: %+v", h.transfers)
	}
}

// What the worn attributes add: armor, the hands' defense, attack, skills, speed, the
// maximums (health never above them when one comes off), regeneration, protection with
// its cap, and leech. The backpack's content adds nothing.
func TestWornAttributesChangeTheFormulas(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) {
		c.Items = testItems()
		withBoots(c)
	}, withAttributes(t))
	join := func(inv ...session.ItemState) (*fakeClient, *session.Player) {
		nextChar++
		return h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Worn", Vocation: "guardian",
			Level: 1, Health: 145, Mana: 20, Pos: pos(3+int(nextChar%20), 3), HasPos: true, InventoryLoaded: true,
			Inventory: inv})
	}
	pack := func(items ...session.ItemState) session.ItemState {
		return session.ItemState{ItemID: packID, Count: 1, Slot: int(slotBackpack), Items: items}
	}
	_, plain := join(rolled(swordID, int(slotRight), "max_mana", 5), rolled(shieldID, int(slotLeft), "max_mana", 5),
		rolled(tunicID, int(slotArmor), "max_mana", 5), rolled(bootsID, int(pb.EquipmentSlot_EQUIPMENT_SLOT_FEET), "max_mana", 5),
		pack(rolled(swordID, 0, "attack", 7), rolled(tunicID, 1, "max_health", 50)))
	armor0, def0, atk0, speed0, sword0 := h.w.GearForTest(plain, "sword")
	if plain.MaxMana() != 20+20 {
		t.Fatalf("max mana %d", plain.MaxMana())
	}
	cl, p := join(rolled(swordID, int(slotRight), "attack", 3), rolled(shieldID, int(slotLeft), "defense", 2),
		rolled(tunicID, int(slotArmor), "armor", 1), rolled(bootsID, int(pb.EquipmentSlot_EQUIPMENT_SLOT_FEET), "speed", 6),
		pack(rolled(tunicID, 0, "max_health", 20)))
	armor, def, atk, speed, sword := h.w.GearForTest(p, "sword")
	if armor != armor0+1 || def != def0+2 || atk != atk0+3 || speed != speed0+6 || sword != sword0 {
		t.Fatalf("armor %d/%d defense %d/%d attack %d/%d speed %d/%d", armor, armor0, def, def0, atk, atk0, speed, speed0)
	}
	if hp, maxHP := p.Health(); maxHP != 145 || hp != 145 {
		t.Fatalf("health %d/%d", hp, maxHP)
	}
	// Wear the vigor tunic (max_health 20) instead: the maximum grows, the stats say so;
	// take it off at full health and the health comes down with it.
	win := openPack(t, h, cl)
	beside := world.Pos{X: p.Pos().X, Y: p.Pos().Y + 1, Z: 7}
	h.send(cl, moveItem(inSlot(slotArmor), tunicID, 0, onTile(beside), 1))
	evs := h.send(cl, moveItem(inContainer(win, 0), tunicID, 0, inSlot(slotArmor), 1))
	stats := find(evs, (*pb.ServerMessage).GetPlayerStats)
	if _, maxHP := p.Health(); maxHP != 165 || len(stats) == 0 || stats[len(stats)-1].GetMaxHealth() != 165 {
		t.Fatalf("max health %d, stats %v", maxHP, stats)
	}
	h.sim.Command(gameFunc(func() { h.w.RestoreForTest(p) }))
	h.sim.Step()
	h.send(cl, moveItem(inSlot(slotArmor), tunicID, 0, onTile(beside), 1))
	if hp, maxHP := p.Health(); maxHP != 145 || hp != 145 {
		t.Fatalf("after taking it off %d/%d", hp, maxHP)
	}

	// Skills, regeneration, protection (capped) and leech.
	_, q := join(rolled(swordID, int(slotRight), "life_leech", 10), rolled(shieldID, int(slotLeft), "fire_protection", 30),
		rolled(tunicID, int(slotArmor), "fire_protection", 30), rolled(bootsID, int(pb.EquipmentSlot_EQUIPMENT_SLOT_FEET), "health_regen", 2))
	_, r := join(rolled(swordID, int(slotRight), "sword_skill", 4))
	if _, _, _, _, s := h.w.GearForTest(r, "sword"); s != sword0+4 {
		t.Fatalf("sword skill %d, want %d", s, sword0+4)
	}
	h.sim.Command(game.CommandFunc(func(ctx *game.TickContext) {
		h.w.SetPlayerHealthForTest(q, 100)
		h.w.SetPlayerHealthForTest(plain, 100)
		h.w.ElementHitForTest(ctx, q, 50, "fire")  // 40 % at most: 30 taken
		h.w.ElementHitForTest(ctx, q, 10, "earth") // no earth protection: 10
		h.w.ElementHitForTest(ctx, plain, 50, "fire")
	}))
	h.sim.Step()
	if hp, _ := q.Health(); hp != 100-30-10 {
		t.Fatalf("protected health %d, want 60", hp)
	}
	if hp, _ := plain.Health(); hp != 50 {
		t.Fatalf("unprotected health %d", hp)
	}
	h.sim.Command(gameFunc(func() {
		h.w.RegenForTest(q)
		h.w.RegenForTest(plain)
	}))
	h.sim.Step()
	qh, _ := q.Health()
	ph, _ := plain.Health()
	if qh-60 != ph-50+2 {
		t.Fatalf("regeneration %d vs %d", qh-60, ph-50)
	}
	h.sim.Command(gameFunc(func() {
		h.w.SetPlayerHealthForTest(q, 60)
		h.w.LeechForTest(q, 45)     // 10 % of 45 = 4
		h.w.LeechForTest(plain, 45) // nothing to leech
	}))
	h.sim.Step()
	if hp, _ := q.Health(); hp != 64 {
		t.Fatalf("after leech %d, want 64", hp)
	}
	if hp, _ := plain.Health(); hp != ph {
		t.Fatalf("leech without the attribute: %d", hp)
	}
}
