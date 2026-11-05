package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// entries returns the economy entries of kind (all kinds if kind is "").
func (h *harness) entries(kind string) []session.EconomyEntry {
	var out []session.EconomyEntry
	for _, e := range h.economy {
		if kind == "" || e.Kind == kind {
			out = append(out, e)
		}
	}
	return out
}

func sumGold(es []session.EconomyEntry) (gold int64, units int) {
	for _, e := range es {
		gold += e.Amount
		units += int(e.Count)
	}
	return gold, units
}

// T4.1: buying and selling to an NPC is logged by source with signed amounts and the
// tick's time; the ledger still matches (the harness checks it every tick).
func TestEconomyLogShop(t *testing.T) {
	h := dataHarness(t)
	c := session.Character{ID: 951, AccountID: 951, Name: "Ledger", Vocation: "guardian", Level: 1, Health: 145, Mana: 20}
	cl, p := h.joinFresh(c, pos(11, 11))
	prov := h.npc("puerto_provisioner")
	h.sim.Command(gameFunc(func() {
		h.w.GiveForTest(p, "copper_coin", 130)
		h.w.GiveForTest(p, "wolf_pelt", 3)
	}))
	h.sim.Step()
	cl.take()
	d := h.lastDialog(h.send(cl, talkMsg(prov.ID())))
	h.pick(cl, d, "dialog.trade")
	rope, pelt := itemNum(t, h, p, "rope"), itemNum(t, h, p, "wolf_pelt")
	before := h.sim.Now()
	h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopBuy{ShopBuy: &pb.ShopBuy{DialogId: d.DialogId, ItemId: rope, Count: 2}}})
	h.send(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopSell{ShopSell: &pb.ShopSell{DialogId: d.DialogId, ItemId: pelt, Count: 3}}})

	buys, sells := h.entries(session.EconNPCBuy), h.entries(session.EconNPCSell)
	if len(buys) != 2 || len(sells) != 2 {
		t.Fatalf("buys %+v sells %+v", buys, sells)
	}
	if g, u := sumGold(buys); g != -90 || u != 2 || buys[1].ItemID != uint16(rope) || buys[0].Ref != "puerto_provisioner" {
		t.Fatalf("buy: gold %d units %d %+v", g, u, buys)
	}
	if g, u := sumGold(sells); g <= 0 || u != -3 || sells[0].ItemID != uint16(pelt) {
		t.Fatalf("sell: gold %d units %d %+v", g, u, sells)
	}
	for _, e := range append(buys, sells...) {
		if e.CharacterID != 951 || e.At.Before(before) || e.At.After(h.sim.Now()) {
			t.Fatalf("entry %+v (now %v)", e, h.sim.Now())
		}
	}
	if gm, _ := sumGold(h.entries(session.EconGM)); gm != 130 {
		t.Fatalf("gm gold %d", gm)
	}
	if len(h.alerts) != 0 {
		t.Fatalf("alerts %v", h.alerts)
	}
}

// Loot is logged when the remains are filled, for the loot owner; picking it up is a
// move, not a creation. (testItems' coins have no currency block: they count as units.)
func TestEconomyLogLootAndDeath(t *testing.T) {
	h := monsterHarness(t, []*content.Monster{wolfDef()}, spawnAt("wolf", 20, 20, 0, 600))
	cl, p := h.join("Looter", at(22, 20))
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	h.input(cl, setTarget(wolf.ID()))
	h.sim.RunUntil(func() bool { return len(h.w.Monsters()) == 0 }, sim.MaxSeconds(120))
	loot := h.entries(session.EconLoot)
	if len(loot) != 1 || loot[0].CharacterID != p.CharacterID() || loot[0].Count < 1 || loot[0].Count > 8 || loot[0].Ref != "wolf" {
		t.Fatalf("loot %+v", loot)
	}

	// A death logs everything that went into the remains as lost.
	d := deathHarness(t)
	_, q := d.geared("Mortal", 30, 0)
	d.kill(q)
	lost := d.entries(session.EconDeath)
	if _, u := sumGold(lost); u > -51 || len(lost) < 2 {
		t.Fatalf("death entries %+v", lost)
	}
}

// A duplication (items appearing without an entry) is a mismatch alert, raised once.
func TestEconomyMismatchDetected(t *testing.T) {
	h := deathHarness(t)
	h.allowMismatch = true
	_, p := h.geared("Duper", 30, 0)
	h.sim.Command(gameFunc(func() { h.w.DupeForTest(p, "copper_coin", 25) }))
	h.sim.RunTicks(5)
	if n := countOf(h.alerts, session.AlertMismatch); n != 1 {
		t.Fatalf("mismatch alerts %d (%v)", n, h.alerts)
	}
	// Logged gifts keep matching after the rebase.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "copper_coin", 5) }))
	h.sim.RunTicks(5)
	if n := countOf(h.alerts, session.AlertMismatch); n != 1 {
		t.Fatalf("mismatch alerts %d after a logged gift", n)
	}
}

// Creating far more than balance economy.outlier allows within the window alerts once.
func TestEconomyOutlier(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) {
		c.Items = testItems()
		c.Balance.Economy.Outlier.WindowMs = 3600000
		c.Balance.Economy.Outlier.ItemsPerHour = content.PerLevel{Base: 100, PerLevel: 10}
	})
	cl := &fakeClient{}
	c := withPack(960, pos(10, 10))
	c.Name, c.Vocation = "Lucky", "guardian"
	h.sim.Command(h.w.Join(c, cl))
	h.sim.Step()
	p := h.w.PlayerByCharacter(960)
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "copper_coin", 100) })) // 110 allowed at level 1
	h.sim.RunTicks(3)
	if len(h.alerts) != 0 {
		t.Fatalf("alerts below the threshold: %v", h.alerts)
	}
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "copper_coin", 20) }))
	h.sim.RunTicks(3)
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "copper_coin", 20) }))
	h.sim.RunTicks(3)
	if n := countOf(h.alerts, session.AlertItemsOutlier); n != 1 {
		t.Fatalf("items outlier alerts %d (%v)", n, h.alerts)
	}
}

// A full persistence queue keeps the entries, in order, for the next ticks.
func TestEconomyQueueFullRetries(t *testing.T) {
	full := true
	var got []session.EconomyEntry
	h := deathHarness(t, func(c *session.Config) {
		c.Economy = func(e session.EconomyEntry) bool {
			if full {
				return false
			}
			got = append(got, e)
			return true
		}
	})
	_, p := h.geared("Patient", 30, 0)
	for i := 1; i <= 3; i++ {
		h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "copper_coin", i) }))
		h.sim.Step()
	}
	full = false
	h.sim.Step()
	if len(got) != 3 || got[0].Count != 1 || got[2].Count != 3 || !got[0].At.Before(got[2].At) {
		t.Fatalf("got %+v", got)
	}
	if rest := h.w.PendingEconomy(h.sim.Now()); len(rest) != 0 {
		t.Fatalf("pending %d", len(rest))
	}
}

func countOf(s []string, v string) int {
	n := 0
	for _, x := range s {
		if x == v {
			n++
		}
	}
	return n
}
