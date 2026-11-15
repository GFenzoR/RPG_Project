package session_test

import (
	"reflect"
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// testShop is a small catalog with one cosmetic of each kind and a second outfit.
func testShop(t *testing.T) *content.CosmeticShop {
	t.Helper()
	s := &content.CosmeticShop{
		Packs: []*content.PremiumPack{{ID: "pack_small", Amount: 100, Price: 1990, Currency: "CLP"}},
		Cosmetics: []*content.Cosmetic{
			{ID: "outfit_sailor", Kind: content.CosmeticOutfit, Price: 300, Outfit: "sailor"},
			{ID: "outfit_noble", Kind: content.CosmeticOutfit, Price: 600, Outfit: "noble"},
			{ID: "color_tide", Kind: content.CosmeticColor, Price: 120, Tint: "#7fa8d8"},
			{ID: "name_gilded", Kind: content.CosmeticNameEffect, Price: 200, Style: "gold"},
		},
	}
	s.Currency.ID = "premium"
	s.Limits = content.ShopLimits{DailyPremium: 5000, EquipBurst: 5, EquipRefillMs: 500, MaxPremiumGrant: 100000}
	if err := s.Index(); err != nil {
		t.Fatal(err)
	}
	return s
}

func withShop(t *testing.T) option { return func(c *session.Config) { c.Cosmetics = testShop(t) } }

func equip(id string) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_EquipCosmetic{EquipCosmetic: &pb.EquipCosmetic{CosmeticId: id}}}
}

func unequip(kind string) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_UnequipCosmetic{UnequipCosmetic: &pb.UnequipCosmetic{Kind: kind}}}
}

func lastCosmeticsState(t *testing.T, evs []*pb.ServerMessage) *pb.CosmeticsState {
	t.Helper()
	st := find(evs, (*pb.ServerMessage).GetCosmeticsState)
	if len(st) == 0 {
		t.Fatalf("no CosmeticsState in %v", kinds(evs))
	}
	return st[len(st)-1]
}

func countKey(evs []*pb.ServerMessage, key string) int {
	n := 0
	for _, e := range evs {
		if e.GetChatMessage().GetLocalized().GetKey() == key {
			n++
		}
	}
	return n
}

func shopChar(account int64, name string, x, y int, owned ...string) session.Character {
	nextChar++
	return session.Character{ID: nextChar, AccountID: account, Name: name, Vocation: "guardian", Level: 1, Health: 145,
		Mana: 20, Pos: pos(x, y), HasPos: true, Owned: owned}
}

func TestEquipCosmetics(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), withShop(t))
	// It logs in wearing an outfit it does not own: that slot goes back to the default.
	a := shopChar(900, "Dandy", 10, 10, "outfit_sailor", "color_tide", "name_gilded")
	a.Premium, a.PremiumSeq = 75, 4
	a.Cosmetics = session.Cosmetics{Outfit: "outfit_noble", Color: "color_tide"}
	clA, pA := h.joinChar(a)
	h.sim.Step()
	st := lastCosmeticsState(t, clA.take())
	if st.GetBalance() != 75 || !slices.Equal(st.GetOwned(), []string{"color_tide", "name_gilded", "outfit_sailor"}) ||
		st.GetEquipped().GetOutfit() != "" || st.GetEquipped().GetColor() != "color_tide" {
		t.Fatalf("login state %v", st)
	}

	// Another player sees the look in the Creature snapshot.
	clB, _ := h.join("Watcher", at(12, 10))
	h.sim.Step()
	var seen *pb.Creature
	for _, e := range clB.take() {
		for _, cr := range e.GetFullMapView().GetArea().GetCreatures() {
			if cr.GetId() == pA.ID() {
				seen = cr
			}
		}
		if cr := e.GetCreatureAppear().GetCreature(); cr.GetId() == pA.ID() {
			seen = cr
		}
	}
	if seen == nil || seen.GetCosmetics().GetColor() != "color_tide" || seen.GetCosmetics().GetOutfit() != "" {
		t.Fatalf("watcher sees %v", seen)
	}

	// Not owned, or unknown: refused, nothing broadcast.
	h.input(clA, equip("outfit_noble"))
	h.input(clA, equip("nope"))
	h.sim.Step()
	if n := countKey(clA.take(), "shop.not_owned"); n != 2 {
		t.Errorf("not_owned messages %d, want 2", n)
	}
	if len(find(clB.take(), (*pb.ServerMessage).GetCreatureCosmetics)) != 0 {
		t.Error("a refused equip was broadcast")
	}

	h.input(clA, equip("outfit_sailor"))
	h.input(clA, equip("name_gilded"))
	h.sim.Step()
	want := session.Cosmetics{Outfit: "outfit_sailor", Color: "color_tide", NameEffect: "name_gilded"}
	if pA.CosmeticsForTest() != want {
		t.Fatalf("equipped %+v", pA.CosmeticsForTest())
	}
	cc := find(clB.take(), (*pb.ServerMessage).GetCreatureCosmetics)
	if len(cc) != 2 || cc[1].GetId() != pA.ID() || cc[1].GetCosmetics().GetNameEffect() != "name_gilded" ||
		cc[1].GetCosmetics().GetOutfit() != "outfit_sailor" {
		t.Fatalf("watcher got %v", cc)
	}
	if st := lastCosmeticsState(t, clA.take()); st.GetEquipped().GetOutfit() != "outfit_sailor" {
		t.Fatalf("state after equip %v", st)
	}

	h.input(clA, unequip(content.CosmeticColor))
	h.input(clA, unequip("mount")) // not a slot: ignored
	h.sim.Step()
	if c := pA.CosmeticsForTest(); c.Color != "" || c.Outfit != "outfit_sailor" {
		t.Fatalf("after unequip %+v", c)
	}

	// Equipped cosmetics persist with the snapshot.
	h.sim.Command(h.w.Leave(clA))
	h.sim.Step()
	last := h.saves[len(h.saves)-1]
	if last.CharacterID != a.ID || last.Cosmetics != (session.Cosmetics{Outfit: "outfit_sailor", NameEffect: "name_gilded"}) {
		t.Fatalf("snapshot %d cosmetics %+v", last.CharacterID, last.Cosmetics)
	}
}

func TestEquipFlood(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), withShop(t))
	cl, _ := h.joinChar(shopChar(901, "Spammer", 5, 5, "outfit_sailor", "outfit_noble"))
	cl.take()
	for i := range 20 {
		if i%2 == 0 {
			h.input(cl, equip("outfit_sailor"))
		} else {
			h.input(cl, equip("outfit_noble"))
		}
	}
	h.sim.Step()
	if n := len(find(cl.take(), (*pb.ServerMessage).GetCreatureCosmetics)); n != 5 {
		t.Fatalf("%d changes in one tick, want the burst of 5", n)
	}
}

// The anti-flood comes from data/cosmetics.yaml limits.
func TestEquipFloodFromData(t *testing.T) {
	shop := testShop(t)
	shop.Limits.EquipBurst, shop.Limits.EquipRefillMs = 2, 1000
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) { c.Cosmetics = shop })
	cl, _ := h.joinChar(shopChar(903, "Spammer", 5, 5, "outfit_sailor", "outfit_noble"))
	cl.take()
	equipBoth := func() {
		for i := range 6 {
			if i%2 == 0 {
				h.input(cl, equip("outfit_sailor"))
			} else {
				h.input(cl, equip("outfit_noble"))
			}
		}
	}
	equipBoth()
	h.sim.Step()
	if n := len(find(cl.take(), (*pb.ServerMessage).GetCreatureCosmetics)); n != 2 {
		t.Fatalf("%d changes in one tick, want the burst of 2", n)
	}
	// 1000 ms = 20 ticks for one more.
	for range 20 {
		h.sim.Step()
	}
	equipBoth()
	h.sim.Step()
	if n := len(find(cl.take(), (*pb.ServerMessage).GetCreatureCosmetics)); n != 1 {
		t.Fatalf("%d changes after one refill, want 1", n)
	}
}

func TestPremiumGrantBoundFromData(t *testing.T) {
	shop := testShop(t)
	shop.Limits.MaxPremiumGrant = 500
	a := newAdminHarness(t, func(c *session.Config) { c.Cosmetics = shop })
	clA, _ := a.joinAs("Boss", session.RoleAdmin, pos(2, 2))
	if keys := a.cmd(clA, "/premium Some Player +501 big"); !slices.Equal(keys, []string{"gm.premium_amount"}) {
		t.Fatalf("over the data bound: %v", keys)
	}
	a.takeJobs()
	a.cmd(clA, "/premium Some Player -500 fix")
	if js := a.takeJobs(); len(js) != 1 || js[0].Kind != session.AdminPremium || js[0].Delta != -500 {
		t.Fatalf("at the bound %+v", js)
	}
	// Without a catalog there is no shop: nothing to grant.
	b := newAdminHarness(t)
	clB, _ := b.joinAs("Boss", session.RoleAdmin, pos(2, 2))
	if keys := b.cmd(clB, "/premium Some Player +5 gift"); !slices.Equal(keys, []string{"shop.unavailable"}) {
		t.Fatalf("no shop: %v", keys)
	}
}

func TestCosmeticsChanged(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), withShop(t))
	c := shopChar(902, "Buyer", 5, 5)
	c.Premium, c.PremiumSeq = 400, 10
	cl, _ := h.joinChar(c)
	cl.take()
	h.sim.Command(h.w.CosmeticsChanged(session.ShopUpdate{AccountID: 902, Owned: []string{"outfit_sailor"}, Balance: 100, Seq: 11}))
	h.sim.Step()
	st := lastCosmeticsState(t, cl.take())
	if st.GetBalance() != 100 || !slices.Equal(st.GetOwned(), []string{"outfit_sailor"}) {
		t.Fatalf("after a purchase %v", st)
	}
	// An older update arriving late changes nothing.
	h.sim.Command(h.w.CosmeticsChanged(session.ShopUpdate{AccountID: 902, Balance: 400, Seq: 10}))
	h.sim.Step()
	if len(find(cl.take(), (*pb.ServerMessage).GetCosmeticsState)) != 0 {
		t.Fatal("stale update applied")
	}
	h.input(cl, equip("outfit_sailor"))
	h.sim.Step()
	if countKey(cl.take(), "shop.not_owned") != 0 {
		t.Fatal("bought cosmetic not equippable")
	}

	// An update for an account with nobody online waits for a login that read the
	// database before the purchase (an older PremiumSeq).
	h.sim.Command(h.w.CosmeticsChanged(session.ShopUpdate{AccountID: 903, Owned: []string{"color_tide"}, Balance: 5, Seq: 21}))
	h.sim.Step()
	late := shopChar(903, "Late", 20, 20)
	late.Premium, late.PremiumSeq = 125, 20
	cl2, _ := h.joinChar(late)
	h.sim.Step()
	if st := lastCosmeticsState(t, cl2.take()); st.GetBalance() != 5 || !slices.Equal(st.GetOwned(), []string{"color_tide"}) {
		t.Fatalf("login after a pending update %v", st)
	}
}

func TestNoCatalogNoCosmetics(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	cl, _ := h.join("Plain", at(5, 5))
	h.sim.Step()
	if len(find(cl.take(), (*pb.ServerMessage).GetCosmeticsState)) != 0 {
		t.Fatal("CosmeticsState without a catalog")
	}
	h.input(cl, equip("outfit_sailor"))
	h.sim.Step()
	if countKey(cl.take(), "shop.unavailable") != 1 {
		t.Fatal("equip without a catalog not refused")
	}
}

// fightTrace is everything a fight decides, tick by tick.
type fightTrace struct {
	PlayerHealth, WolfHealth []int
	Experience               int64
	Ticks, Speed             int
	Skills                   []*pb.SkillProgress
}

// wolfFight runs the seeded fight of TestWolfDiesAndGivesExperience with the player
// wearing wear.
func wolfFight(t *testing.T, wear session.Cosmetics) fightTrace {
	t.Helper()
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 20, 20, 0, 60)}
	h := newHarness(t, m, withShop(t), func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolfDef()}
		c.Items = testItems()
	})
	c := shopChar(904, "Hunter", 24, 20, "outfit_noble", "color_tide", "name_gilded")
	c.Cosmetics = wear
	cl, p := h.joinChar(c)
	if p.CosmeticsForTest() != wear {
		t.Fatalf("wearing %+v, want %+v", p.CosmeticsForTest(), wear)
	}
	h.sim.Step()
	wolf := onlyMonster(t, h)
	h.input(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	h.input(cl, setTarget(wolf.ID()))
	var tr fightTrace
	tr.Ticks = h.sim.RunUntil(func() bool {
		hp, _ := p.Health()
		tr.PlayerHealth = append(tr.PlayerHealth, hp)
		if len(h.w.Monsters()) == 0 {
			return true
		}
		tr.WolfHealth = append(tr.WolfHealth, h.w.MonsterHealth(wolf))
		return false
	}, sim.MaxSeconds(120))
	h.sim.Step()
	tr.Experience, tr.Speed = p.Experience(), p.Speed()
	for _, e := range cl.take() {
		if s := e.GetPlayerSkills(); s != nil {
			tr.Skills = s.GetSkills()
		}
	}
	return tr
}

// Cosmetics are only a look (docs/02 "Tienda cosmética"): the same seeded fight, with
// and without one cosmetic of every kind equipped, has the same outcome tick by tick.
func TestCosmeticsDoNotChangeCombat(t *testing.T) {
	plain := wolfFight(t, session.Cosmetics{})
	worn := wolfFight(t, session.Cosmetics{Outfit: "outfit_noble", Color: "color_tide", NameEffect: "name_gilded"})
	if plain.Experience == 0 || plain.Ticks == 0 || len(plain.WolfHealth) == 0 {
		t.Fatalf("no fight happened: %+v", plain)
	}
	if !reflect.DeepEqual(plain.PlayerHealth, worn.PlayerHealth) || !reflect.DeepEqual(plain.WolfHealth, worn.WolfHealth) ||
		plain.Experience != worn.Experience || plain.Ticks != worn.Ticks || plain.Speed != worn.Speed ||
		len(plain.Skills) != len(worn.Skills) {
		t.Fatalf("cosmetics changed the fight:\nplain %+v\nworn  %+v", plain, worn)
	}
	for i := range plain.Skills {
		if plain.Skills[i].String() != worn.Skills[i].String() {
			t.Fatalf("skill %d: %v vs %v", i, plain.Skills[i], worn.Skills[i])
		}
	}
}

func TestPremiumStaffCommands(t *testing.T) {
	a := newAdminHarness(t, withShop(t))
	clA, _ := a.joinAs("Boss", session.RoleAdmin, pos(2, 2))
	clG, _ := a.joinAs("Helper", session.RoleGM, pos(4, 2))

	// Only admins create or remove premium currency; a GM gets the unknown answer.
	if keys := a.cmd(clG, "/premium Some Player +100 event"); !slices.Equal(keys, []string{"command.unknown"}) {
		t.Fatalf("gm /premium: %v", keys)
	}
	a.cmd(clA, "/premium Some Player +100 event prize")
	js := a.takeJobs()
	if len(js) != 1 || js[0].Kind != session.AdminPremium || js[0].TargetName != "Some Player" || js[0].Delta != 100 ||
		js[0].Reason != "event prize" || js[0].ClearFlag || js[0].Audit.Action != "premium_grant" {
		t.Fatalf("jobs %+v", js)
	}
	a.sim.Command(a.w.AdminDone(session.AdminResult{ID: js[0].ID, Result: session.AdminOK, Name: "Some Player", Balance: 150}))
	a.sim.Step()
	if keys := sysKeys(clA.take()); !slices.Equal(keys, []string{"gm.premium_done"}) {
		t.Fatalf("answer %v", keys)
	}

	a.cmd(clA, "/premium Some Player -500 mistake")
	js = a.takeJobs()
	if len(js) != 1 || js[0].Delta != -500 {
		t.Fatalf("removal %+v", js)
	}
	a.sim.Command(a.w.AdminDone(session.AdminResult{ID: js[0].ID, Result: session.AdminInsufficient, Name: "Some Player", Balance: 150}))
	a.sim.Step()
	if keys := sysKeys(clA.take()); !slices.Equal(keys, []string{"gm.premium_insufficient"}) {
		t.Fatalf("answer %v", keys)
	}

	a.cmd(clA, "/premium Some Player +0 clear chargeback disputed")
	if js = a.takeJobs(); len(js) != 1 || !js[0].ClearFlag || js[0].Delta != 0 {
		t.Fatalf("clear %+v", js)
	}

	// Invalid: no amount, no note, too large (audited as invalid), +0 without clear.
	for _, line := range []string{"/premium Some Player", "/premium Some Player +100", "/premium +100 note"} {
		if keys := a.cmd(clA, line); !slices.Equal(keys, []string{"gm.usage"}) {
			t.Errorf("%q: %v", line, keys)
		}
	}
	if keys := a.cmd(clA, "/premium Some Player +0 oops"); !slices.Equal(keys, []string{"gm.usage"}) {
		t.Errorf("+0: %v", keys)
	}
	if keys := a.cmd(clA, "/premium Some Player +100001 big"); !slices.Equal(keys, []string{"gm.premium_amount"}) {
		t.Errorf("too large: %v", keys)
	}
	for _, j := range a.takeJobs() {
		if j.Kind != session.AdminAudit || j.Audit.Result != "invalid" {
			t.Errorf("invalid attempt job %+v", j)
		}
	}

	// GMs may read the history.
	a.cmd(clG, "/purchases Some Player")
	js = a.takeJobs()
	if len(js) != 1 || js[0].Kind != session.AdminPurchases || js[0].Audit.Action != "premium_history" {
		t.Fatalf("purchases %+v", js)
	}
	a.sim.Command(a.w.AdminDone(session.AdminResult{ID: js[0].ID, Result: session.AdminOK, Name: "Some Player", Balance: 30,
		Premium: []session.PremiumEntry{{Reason: "pack", Delta: 100, Ref: "pack_small"}, {Reason: "purchase", Delta: -70, Ref: "color_tide"}}}))
	a.sim.Step()
	if keys := sysKeys(clG.take()); !slices.Equal(keys, []string{"gm.purchases", "gm.purchase_line", "gm.purchase_line"}) {
		t.Fatalf("history answer %v", keys)
	}
}
