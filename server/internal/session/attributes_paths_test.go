package session_test

import (
	"path/filepath"
	"slices"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// More paths of item attributes (docs/02 "Atributos de items"): a conjure, a gathering, a
// quest drop, a quest's and the tutorial's rewards roll the equipable they create and the
// log names it; a corpse and a released house hand their instances over as they are; a
// trade offer whose mods change leaves the trade; and every weapon hit leeches what it
// dealt while the worn protection holds, against monsters and in PvP.

const fireWandID = 97

// withFireWand adds a test wand of 100 fire attack and range 3 to the items.
func withFireWand(c *session.Config) {
	var it content.Item
	_ = yaml.Unmarshal([]byte("{id: test_fire_wand, kind: weapon, weight: 1500, weapon: {type: wand, attack: 100, range: 3, element: fire}}"), &it)
	it.Numeric = fireWandID
	c.Items[it.ID] = &it
}

// econMods is the mods of every economy entry of kind for item (one per instance).
func econMods(h *harness, kind string, item uint16) []session.Mods {
	var out []session.Mods
	for _, e := range h.economy {
		if e.Kind == kind && e.ItemID == item {
			if e.Count != 1 && e.Count != -1 {
				h.t.Fatalf("an equipable's entry counts %d", e.Count)
			}
			out = append(out, e.Mods)
		}
	}
	return out
}

func healthOf(p *session.Player) int {
	hp, _ := p.Health()
	return hp
}

// A spell that conjures an equipable rolls its attribute (no data spell does yet).
func TestConjuredEquipableRolls(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) {
		c.Items = testItems()
		c.Spells = testSpells()
		c.Spells["test_conjure_sword"] = &content.Spell{ID: "test_conjure_sword", Words: "test conjure sword",
			Vocations: []string{"arcanist"}, Level: 1, Mana: 30, Group: "support", CooldownMs: 1000,
			Effect: content.SpellEffect{Conjure: &content.SpellConjure{Item: "test_sword"}}}
		c.Balance.Skills.Base["magic"] = content.SkillBase{StartLevel: 0, BaseTries: magicTries}
	}, withAttributes(t))
	cl, p := arcanist(t, h, pos(10, 10))
	if evs := h.castNow(cl, cast("test_conjure_sword")); !hasKey(evs, "magic.conjured") {
		t.Fatalf("conjure: %v", systemKeys(evs))
	}
	swords := h.w.ItemsForTest(p, "test_sword")
	if len(swords) != 1 {
		t.Fatalf("%d swords", len(swords))
	}
	checkRolled(t, attrPool(t), swords[0].Def(), swords[0].Mods())
	if got := econMods(h, session.EconConjure, swordID); !slices.Equal(got, []session.Mods{swords[0].Mods()}) {
		t.Fatalf("conjure log %v", got)
	}
}

// A gathering that yields an equipable (no data resource does yet) rolls it and the log
// names the instance.
func TestGatheredEquipableRolls(t *testing.T) {
	h := gatherHarness(t, worldtest.Map(t, 0, 0, 7, "Tv"), 0, withAttributes(t), func(c *session.Config) {
		vein := *c.Items["iron_vein"]
		res := *vein.Resource
		res.Drops = []content.ResourceDrop{{Item: "test_sword", Weight: 1}}
		vein.Resource = &res
		c.Items["iron_vein"] = &vein
	})
	cl, p := gatherer(h, pos(0, 0), pickID)
	cl.take()
	if evs := h.try(cl, pickID, pos(1, 0)); !hasKey(evs, "gather.got") {
		t.Fatalf("gather: %v", systemKeys(evs))
	}
	swords := h.w.ItemsForTest(p, "test_sword")
	if len(swords) != 1 {
		t.Fatalf("%d swords", len(swords))
	}
	checkRolled(t, attrPool(t), swords[0].Def(), swords[0].Mods())
	if got := econMods(h, session.EconGather, swordID); !slices.Equal(got, []session.Mods{swords[0].Mods()}) {
		t.Fatalf("gather log %v", got)
	}
}

// A quest drop (each_player) and a quest's item reward are created for the player: each
// equipable rolls its attribute and the log names it.
func TestQuestDropAndRewardRoll(t *testing.T) {
	var qs []*content.Quest
	for _, src := range []string{
		`{id: armory, name: quest.armory.name,
			steps: [{id: blade, complete_when: {has_item: {item: test_sword, count: 1}}},
				{id: deliver, complete_when: {dialog_action: {npc: smith, node: blade}}}]}`,
		`{id: fetch, name: quest.fetch.name,
			steps: [{id: salve, complete_when: {has_item: {item: test_salve, count: 1}}}],
			rewards: [{item: test_tunic}]}`,
	} {
		q, err := content.ParseQuest([]byte(src))
		if err != nil {
			t.Fatal(err)
		}
		qs = append(qs, q)
	}
	// The smith takes the dropped blade (a quest drop needs its delivery).
	smith, err := content.ParseNPC([]byte(`{id: smith, name: npc.smith.name, dialog: {start: greet, nodes: {
		greet: {text: npc.smith.greet, options: [{text: npc.smith.give, action: {take_item: {item: test_sword}}, goto: blade}]},
		blade: {text: npc.smith.blade, options: [{text: dialog.bye, action: close}]}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	keeper := &content.Monster{ID: "keeper", Health: 50, Experience: 1, Speed: 100,
		Loot: []content.LootEntry{{Item: "test_sword", Chance: 1, EachPlayer: true}}}
	m := worldtest.Open(t, 0, 0, 32, 32)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("keeper", 10, 10, 0, 600)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"keeper": keeper}
		c.Items = testItems()
		c.NPCs = content.NPCs{smith.ID: smith}
		c.Quests = content.Quests{qs[0].ID: qs[0], qs[1].ID: qs[1]}
	}, withAttributes(t))
	nextChar++
	_, p := h.joinChar(withPack(nextChar, pos(11, 10)))
	h.sim.Step()
	mon := onlyMonster(t, h)
	h.do(func(*game.TickContext) {
		for _, q := range qs {
			p.SetStorageForTest("quest."+q.ID, int64(quest.InProgress))
			p.SetStorageForTest("quest."+q.ID+".step", 0)
		}
	})
	h.do(func(ctx *game.TickContext) {
		h.w.DamageMonsterForTest(ctx, mon, p, 100)
		h.w.GiveForTest(p, "test_salve", 1) // the fetch quest is done at the end of the tick
	})
	h.sim.Step()
	if st, _ := h.w.QuestState(p, "fetch"); st != quest.Completed {
		t.Fatalf("fetch quest %v", st)
	}
	pool := attrPool(t)
	sword, tunic := h.w.ItemsForTest(p, "test_sword"), h.w.ItemsForTest(p, "test_tunic")
	if len(sword) != 1 || len(tunic) != 1 {
		t.Fatalf("%d swords, %d tunics", len(sword), len(tunic))
	}
	checkRolled(t, pool, sword[0].Def(), sword[0].Mods())
	checkRolled(t, pool, tunic[0].Def(), tunic[0].Mods())
	if got := econMods(h, session.EconLoot, swordID); !slices.Equal(got, []session.Mods{sword[0].Mods()}) {
		t.Fatalf("quest drop log %v", got)
	}
	if got := econMods(h, session.EconQuest, tunicID); !slices.Equal(got, []session.Mods{tunic[0].Mods()}) {
		t.Fatalf("quest reward log %v", got)
	}
}

// The tutorial's item reward rolls its attribute (the data reward is gold only; here it
// also gives a cap (the start_kit already has a cap)).
func TestTutorialRewardRolls(t *testing.T) {
	h := tutorialHarnessWith(t, func(c *session.Config) {
		withAttributes(t)(c)
		c.Tutorial.Rewards = append(slices.Clone(c.Tutorial.Rewards), content.TutorialReward{Item: "sailcloth_cap"})
	})
	// Stored at the last step (harbor_master_task, index 6 + 1), then back in.
	cl, p := h.joinChar(newcomer(9720, "guardian"))
	h.sim.Command(gameFunc(func() { p.SetStorageForTest("tutorial.step", 7) }))
	h.sim.Step()
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	c := newcomer(9720, "guardian")
	c.Storage = h.saves[len(h.saves)-1].Storage
	cl, p = h.joinFresh(c, pos(9, 10))
	d := h.lastDialog(h.send(cl, talkMsg(h.npc("harbor_master").ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.harbor_master.opt_shipwreck"))
	if ts := lastTutorial(h.pick(cl, d, "dialog.accept")); ts == nil || ts.State != pb.TutorialState_TUTORIAL_STATE_DONE {
		t.Fatalf("tutorial %v", ts)
	}
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	cap := h.w.ItemsForTest(p, "sailcloth_cap")
	if len(cap) != 1 {
		t.Fatalf("%d caps", len(cap))
	}
	checkRolled(t, attrPool(t), items["sailcloth_cap"], cap[0].Mods())
	num := items["sailcloth_cap"].Numeric
	if got := econMods(h, session.EconTutorial, num); !slices.Equal(got, []session.Mods{cap[0].Mods()}) {
		t.Fatalf("tutorial log %v", got)
	}
}

// Taking an equipable out of a corpse takes the very instance: its attribute arrives.
func TestLootingKeepsTheAttribute(t *testing.T) {
	armory := &content.Monster{ID: "armory", Health: 5, Experience: 1, Speed: 100,
		Loot: []content.LootEntry{{Item: "test_sword", Chance: 1}}}
	m := worldtest.Open(t, 0, 0, 32, 32)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("armory", 10, 10, 0, 600)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"armory": armory}
		c.Items = testItems()
	}, withAttributes(t))
	nextChar++
	cl, p := h.joinChar(withPack(nextChar, pos(11, 10)))
	h.sim.Step()
	mon := onlyMonster(t, h)
	at := mon.Pos()
	h.do(func(ctx *game.TickContext) { h.w.KillForTest(ctx, mon) })
	cs := h.w.CorpsesAt(at)
	if len(cs) != 1 || len(cs[0].Loot()) != 1 {
		t.Fatalf("corpse %v", cs)
	}
	want := itemMods(cs[0].Loot()[0])
	if want.Zero() {
		t.Fatal("the loot did not roll")
	}
	loot := openCorpseAt(t, h, cl, at)
	pack := openPack(t, h, cl)
	if evs := h.send(cl, moveItem(inContainer(loot, 0), swordID, 0, inContainer(pack, 0), 1)); len(systemKeys(evs)) != 0 {
		t.Fatalf("loot: %v", systemKeys(evs))
	}
	got := h.w.ItemsForTest(p, "test_sword")
	if len(got) != 1 || got[0].Mods() != want || len(cs[0].Loot()) != 0 {
		t.Fatalf("took %v, corpse %v (want %+v)", got, cs[0].Loot(), want)
	}
}

// A released house mails its floor flattened (mailFlat): a bag goes empty and each
// equipable it held, and one on the floor, is its own mailbox entry with its attribute.
func TestReleasedHouseMailsTheAttribute(t *testing.T) {
	const owner = 9710
	start := clock.Epoch
	h := newHouseHarness(t, withAttributes(t), func(c *session.Config) {
		c.Houses = &session.HouseData{
			Owners: []session.HouseOwner{{HouseID: "cottage", CharacterID: owner, AccountID: owner, Name: "Ana",
				PaidUntil: start.Add(-time.Hour), Since: start.Add(-30 * 24 * time.Hour), Seen: start}},
			Items: []session.HouseItem{
				{HouseID: "cottage", Pos: pos(2, 2), Item: session.ItemState{ItemID: bagID, Count: 1,
					Items: []session.ItemState{rolled(swordID, 0, "attack", 2), rolled(tunicID, 1, "armor", 1)}}},
				{HouseID: "cottage", Pos: pos(3, 2), Item: rolled(swordID, 0, "life_leech", 3)},
			},
		}
	})
	h.sim.RunTicks(25)
	if h.w.HouseOwnerOf(owner) != "" || h.w.MailItemsForTest(owner) != 4 {
		t.Fatalf("house %q, mailbox %d", h.w.HouseOwnerOf(owner), h.w.MailItemsForTest(owner))
	}
	got := map[uint16][]session.Mods{}
	for _, tr := range h.transfers {
		for _, op := range tr.Market {
			if op.Kind == session.MarketMailAdd {
				if len(op.Mail.Item.Items) != 0 {
					t.Fatalf("a mailed container is not empty: %+v", op.Mail.Item)
				}
				got[op.Mail.Item.ItemID] = append(got[op.Mail.Item.ItemID], op.Mail.Item.Mods)
			}
		}
	}
	swords := got[swordID]
	slices.SortFunc(swords, func(a, b session.Mods) int { return a.Value - b.Value })
	if len(got[bagID]) != 1 || !got[bagID][0].Zero() || !slices.Equal(got[tunicID], []session.Mods{mods("armor", 1)}) ||
		!slices.Equal(swords, []session.Mods{mods("attack", 2), mods("life_leech", 3)}) {
		t.Fatalf("mailed %v", got)
	}
}

// A trade offer is the instance as offered: once its mods change in place (as the forge
// will), it leaves the offer and the partner never gets it.
func TestTradeDropsAnOfferWhoseModsChanged(t *testing.T) {
	h := newMarketHarness(t, withAttributes(t))
	ca, a := h.trader("Ana", pos(2, 2), rolled(swordID, 0, "attack", 2))
	cb, b := h.trader("Beto", pos(3, 2), stack(salveID, 4, 0))
	h.startTrade(ca, cb, a, b, swordID, salveID)
	sword := h.w.ItemsForTest(a, "test_sword")[0]
	h.sim.Command(gameFunc(func() { sword.SetModsForTest(mods("attack", 7)) }))
	h.sim.Step()
	if u := lastTrade(cb.take()); u == nil || len(u.GetPartnerOffer()) != 0 || len(u.GetOwnOffer()) != 1 {
		t.Fatalf("Beto sees %v", u)
	}
	h.send(ca, tradeAccept)
	h.send(cb, tradeAccept)
	if got := h.w.ItemsForTest(a, "test_sword"); len(got) != 1 || got[0] != sword || len(h.w.ItemsForTest(b, "test_sword")) != 0 {
		t.Fatalf("Ana %v, Beto %v", got, h.w.ItemsForTest(b, "test_sword"))
	}
}

// Every weapon hit on a monster leeches its share of what it dealt: a melee hit
// (physicalHit) life, a wand shot (wandFight) mana.
func TestWeaponHitsLeechOnMonsters(t *testing.T) {
	post := &content.Monster{ID: "post", Health: 100000, Experience: 1, Speed: 100}
	m := worldtest.Open(t, 0, 0, 32, 32)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("post", 10, 10, 0, 600)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"post": post}
		c.Items = testItems()
		withFireWand(c)
		c.Balance.Combat.WandMinFactor = 1 // wand hits are exact
	}, withAttributes(t))
	join := func(vocation string, at world.Pos, health, mana int, weapon session.ItemState) *session.Player {
		nextChar++
		_, p := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "Leech", Vocation: vocation,
			Level: 1, Health: health, Mana: mana, Pos: at, HasPos: true, InventoryLoaded: true,
			Inventory: []session.ItemState{weapon}})
		return p
	}
	melee := join("guardian", pos(11, 10), 20, 20, rolled(swordID, int(slotRight), "life_leech", 10))
	mage := join("arcanist", pos(12, 10), 140, 100, rolled(fireWandID, int(slotRight), "mana_leech", 15))
	h.sim.Step()
	mon := onlyMonster(t, h)
	var dealt, healed, want, shot, mana int
	h.do(func(ctx *game.TickContext) {
		for range 10 {
			before, hp := h.w.MonsterHealth(mon), healthOf(melee)
			h.w.PhysicalHitForTest(ctx, melee, mon, nil, 40)
			lost := before - h.w.MonsterHealth(mon)
			dealt, want, healed = dealt+lost, want+lost*10/100, healed+healthOf(melee)-hp
		}
		before, mp := h.w.MonsterHealth(mon), h.w.Mana(mage)
		h.w.WandShotForTest(ctx, mage, mon, nil)
		shot, mana = before-h.w.MonsterHealth(mon), h.w.Mana(mage)-mp
	})
	if healed != want || healed == 0 {
		t.Fatalf("melee dealt %d and healed %d, want %d", dealt, healed, want)
	}
	if shot != 100 || mana != 15 {
		t.Fatalf("the wand dealt %d and gave %d mana, want 100 and 15", shot, mana)
	}
}

// In PvP a weapon hit leeches what the victim took (after balance pvp.damage_pct and
// its protection), and the victim's worn protection lowers a wand's elemental hit.
func TestPvPHitsLeechAndProtection(t *testing.T) {
	g := newPvP(t, nil, withAttributes(t), withFireWand, func(c *session.Config) { c.Balance.Combat.WandMinFactor = 1 })
	wearing := func(it session.ItemState) func(*session.Character) {
		return func(c *session.Character) { c.Inventory = append(c.Inventory, it) }
	}
	_, a := g.fighter("Ana", 0, 45, 45, 30, 0, wearing(rolled(fireWandID, int(slotRight), "mana_leech", 15)))
	_, v := g.fighter("Beto", 0, 46, 45, 30, 0, wearing(rolled(tunicID, int(slotArmor), "fire_protection", 30)))
	_, c := g.fighter("Cid", 0, 47, 45, 30, 0)
	_, d := g.fighter("Dan", 0, 45, 46, 30, 0, wearing(rolled(swordID, int(slotRight), "life_leech", 10)))
	var took, aMana [2]int
	var dealt, healed, want int
	g.do(func(ctx *game.TickContext) {
		d.SetHealthForTest(50)
		for i, x := range []*session.Player{v, c} {
			hp, mp := healthOf(x), g.w.Mana(a)
			g.w.WandShotForTest(ctx, a, nil, x)
			took[i], aMana[i] = hp-healthOf(x), g.w.Mana(a)-mp
		}
		for range 8 {
			before, hp := healthOf(v), healthOf(d)
			g.w.PhysicalHitForTest(ctx, d, nil, v, 100)
			lost := before - healthOf(v)
			dealt, want, healed = dealt+lost, want+lost*10/100, healed+healthOf(d)-hp
		}
	})
	// 100 fire, half in PvP: 50; Beto's 30 % protection leaves 35. Ana leeches 15 %.
	if took != [2]int{35, 50} || aMana != [2]int{5, 7} {
		t.Fatalf("the wand took %v and gave %v mana, want [35 50] and [5 7]", took, aMana)
	}
	if healed != want || healed == 0 {
		t.Fatalf("Dan dealt %d and healed %d, want %d", dealt, healed, want)
	}
}
