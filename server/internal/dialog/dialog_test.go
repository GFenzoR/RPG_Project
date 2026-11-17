package dialog

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
)

// fake is a player for the engine: facts in fields, effects recorded.
type fake struct {
	level        int
	vocation     string
	items        map[string]int
	money        int64
	noChangeRoom bool
	dev          bool // the NPC stands on a dev-only island
	blessed      map[string]bool
	engine       *quest.Engine
	log          *quest.Log
	did          []string
}

func (f *fake) Level() int                { return f.level }
func (f *fake) Vocation() string          { return f.vocation }
func (f *fake) ItemCount(it string) int   { return f.items[it] }
func (f *fake) Flag(k string) int64       { return f.log.Get(quest.FlagKey(k)) }
func (f *fake) SkillLevel(string) int     { return 10 }
func (f *fake) Money() int64              { return f.money }
func (f *fake) CanPay(int64) bool         { return !f.noChangeRoom }
func (f *fake) HasBlessing(b string) bool { return f.blessed[b] }
func (f *fake) CanTeleport(content.Position) bool {
	return true
}
func (f *fake) QuestState(q string) (quest.State, string)  { return f.engine.State(f.log, q) }
func (f *fake) GiveItem(it string)                         { f.items[it]++; f.did = append(f.did, "give:"+it) }
func (f *fake) TakeItem(it string, n int)                  { f.items[it] -= n; f.did = append(f.did, "take:"+it) }
func (f *fake) GiveXP(int64)                               {}
func (f *fake) GiveGold(n int64)                           { f.money += n }
func (f *fake) TakeGold(n int64)                           { f.money -= n }
func (f *fake) StartQuest(id string)                       { f.engine.Start(f.log, id, f) }
func (f *fake) SetQuestStep(q, s string)                   { f.engine.SetStep(f.log, q, s, f) }
func (f *fake) SetFlag(k string, v int64)                  { f.engine.SetFlag(f.log, k, v, f) }
func (f *fake) OpenShop(id string)                         { f.did = append(f.did, "shop:"+id) }
func (f *fake) Heal()                                      { f.did = append(f.did, "heal") }
func (f *fake) Teleport(content.Position)                  {}
func (f *fake) Bless(b content.Bless)                      { f.blessed[b.Blessing] = true; f.money -= b.Price }
func (f *fake) DevIsland() bool                            { return f.dev }
func (f *fake) TrainSkill(s string, n int)                 { f.did = append(f.did, fmt.Sprintf("train:%s=%d", s, n)) }
func (f *fake) RestoreMana()                               { f.did = append(f.did, "mana") }
func (f *fake) Reward(*content.Quest, content.QuestReward) {}
func (f *fake) Notify(quest.Event)                         {}

func load(t *testing.T, id string) *content.NPC {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "data", "npcs", id+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	n, err := content.ParseNPC(raw)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func newFake(t *testing.T, voc string) *fake {
	qs, err := content.LoadQuests(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	return &fake{level: 1, vocation: voc, items: map[string]int{}, blessed: map[string]bool{},
		engine: quest.NewEngine(qs), log: quest.NewLog(nil)}
}

func texts(n *content.DialogNode, f Facts) []string {
	var out []string
	for _, i := range Visible(n, f) {
		out = append(out, n.Options[i].Text)
	}
	return out
}

func TestHarborMasterOffersByVocation(t *testing.T) {
	hm := load(t, "harbor_master")
	f := newFake(t, "arcanist")
	greet := hm.Dialog.Nodes["greet"]
	if got := texts(greet, f); got[0] != "npc.harbor_master.opt_shipwreck" || len(got) != 4 {
		t.Fatalf("greet options %v", got)
	}
	r := Choose(hm, "greet", 0, f)
	if r.Node != "ch1_offer" {
		t.Fatalf("result %+v", r)
	}
	// Only the arcanist's accept is visible; choosing the guardian's one is refused.
	if r := Choose(hm, "ch1_offer", 0, f); r.Node != "ch1_offer" || f.money != 0 {
		t.Fatalf("hidden option ran: %+v", r)
	}
	r = Choose(hm, "ch1_offer", 1, f)
	if r.Node != "ch1_accepted_arcanist" || f.items["spark_wand"] != 1 || f.items["ship_biscuit"] != 1 {
		t.Fatalf("accept: %+v money %d items %v", r, f.money, f.items)
	}
	if s, step := f.QuestState("ch1_shipwreck"); s != quest.InProgress || step != "clear_wolves" {
		t.Fatalf("quest %v %q", s, step)
	}
	if got := texts(greet, f); got[0] != "npc.harbor_master.opt_ch1_wolves" {
		t.Fatalf("greet options after accepting %v", got)
	}
	if r := Choose(hm, "greet", len(greet.Options)-1, f); r.Node != "" {
		t.Fatal("bye should close")
	}
}

func TestCostsAreAllOrNothing(t *testing.T) {
	priest := load(t, "puerto_priest")
	f := newFake(t, "guardian")
	f.level = 9 // the temples bless from level 9 (content audit m8)
	f.money = 150
	if r := Choose(priest, "blessings", 0, f); r.Refused != MsgNoMoney || len(f.blessed) != 0 {
		t.Fatalf("blessing without money: %+v", r)
	}
	// Enough money, but the change of a broken coin would not fit.
	f.money, f.noChangeRoom = 400, true
	if r := Choose(priest, "blessings", 0, f); r.Refused != MsgNoChangeRoom || len(f.blessed) != 0 {
		t.Fatalf("blessing without room for the change: %+v", r)
	}
	f.noChangeRoom = false
	if r := Choose(priest, "blessings", 0, f); r.Node != "blessed" || f.money != 200 {
		t.Fatalf("blessing: %+v money %d", r, f.money)
	}
	if r := Choose(priest, "blessings", 0, f); r.Refused != MsgAlreadyBlessed || f.money != 200 {
		t.Fatalf("second blessing: %+v", r)
	}
	if r := Choose(priest, "greet", 1, f); r.Node != "healed" || f.did[len(f.did)-1] != "heal" {
		t.Fatalf("heal: %+v", r)
	}
	prov := load(t, "puerto_provisioner")
	if r := Choose(prov, "greet", 0, f); r.Node != "greet" || f.did[len(f.did)-1] != "shop:provisions_shop" {
		t.Fatalf("trade should stay on the node and open the shop: %+v", r)
	}
	if Check(content.Actions{{TakeItem: &content.ItemCount{Item: "rope", Count: 2}}}, f) != MsgNoItem {
		t.Fatal("take_item without the items should be refused")
	}
}

// The ranger and the druid get their own starter weapon when they accept (T3.1).
func TestHarborMasterKitForRangerAndDruid(t *testing.T) {
	hm := load(t, "harbor_master")
	for _, c := range []struct {
		vocation, node, item string
		money                int64
	}{
		{"ranger", "ch1_accepted_ranger", "short_bow", 20},
		{"druid", "ch1_accepted_druid", "sapling_staff", 0},
	} {
		f := newFake(t, c.vocation)
		accept := -1
		for i, o := range hm.Dialog.Nodes["ch1_offer"].Options {
			if o.Goto == c.node {
				accept = i
			}
		}
		if accept < 0 {
			t.Fatalf("%s: no accept option leads to %s", c.vocation, c.node)
		}
		r := Choose(hm, "ch1_offer", accept, f)
		if r.Node != c.node || f.items[c.item] != 1 || f.money != c.money || f.items["ship_biscuit"] != 1 {
			t.Errorf("%s: %+v money %d items %v", c.vocation, r, f.money, f.items)
		}
	}
}

// The sandbox instructor's dev-only actions (train_skill, restore_mana) run only when her
// island is dev-only, and an option with one runs nothing elsewhere, not even its other
// actions (all or nothing): the priests' heal is not dev-only.
func TestDevOnlyActionsNeedADevIsland(t *testing.T) {
	trainer := load(t, "pruebas_trainer")
	option := func(node, text string) int {
		for i, o := range trainer.Dialog.Nodes[node].Options {
			if o.Text == text {
				return i
			}
		}
		t.Fatalf("no option %s in %s", text, node)
		return -1
	}
	heal := option("greet", "npc.pruebas_trainer.opt_heal")
	trades := option("train", "npc.pruebas_trainer.opt_train_trades")
	for _, dev := range []bool{false, true} {
		f := newFake(t, "guardian")
		f.dev = dev
		r := Choose(trainer, "greet", heal, f)
		if !dev && (r.Refused != MsgDevOnly || r.Node != "greet" || len(f.did) != 0) {
			t.Fatalf("heal on a normal island: %+v, ran %v", r, f.did)
		}
		if dev && (r.Node != "healed" || !slices.Equal(f.did, []string{"heal", "mana"})) {
			t.Fatalf("heal on the sandbox island: %+v, ran %v", r, f.did)
		}
		f.did = nil
		combat := Visible(trainer.Dialog.Nodes["train"], f)[0]
		r = Choose(trainer, "train", combat, f)
		if !dev && (r.Refused != MsgDevOnly || len(f.did) != 0) {
			t.Fatalf("train on a normal island: %+v, ran %v", r, f.did)
		}
		if dev && (r.Node != "trained" || !slices.Contains(f.did, "train:sword=45") || !slices.Contains(f.did, "train:shield=40")) {
			t.Fatalf("guardian training on the sandbox island: %+v, ran %v", r, f.did)
		}
		f.did = nil
		r = Choose(trainer, "train", trades, f)
		if dev != (r.Refused == "") || dev && !slices.Contains(f.did, "train:smithing=25") {
			t.Fatalf("trades training (dev island %v): %+v, ran %v", dev, r, f.did)
		}
	}
	f := newFake(t, "druid")
	if Check(content.Actions{{RestoreMana: true}}, f) != MsgDevOnly ||
		Check(content.Actions{{TrainSkill: &content.SkillLevel{Skill: "magic", Level: 3}}}, f) != MsgDevOnly ||
		Check(content.Actions{{Heal: true}}, f) != "" {
		t.Fatal("Check off a dev island")
	}
}

// Content audit m8: novices (up to death.novice_max_level, 8) already die as if they had
// the five blessings, so the temples only sell them from level 9.
func TestBlessingsFromLevelNine(t *testing.T) {
	// The novice protection is balance.yaml's: the temples must follow it.
	b, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	novice := b.Death.NoviceMaxLevel
	for _, id := range []string{"puerto_priest", "bosque_priest", "volcan_priest"} {
		npc := load(t, id)
		node := npc.Dialog.Nodes["blessings"]
		f := newFake(t, "guardian")
		count := func() int {
			n := 0
			for _, txt := range texts(node, f) {
				if strings.Contains(txt, ".bless_") {
					n++
				}
			}
			return n
		}
		f.level = novice
		if n := count(); n != 0 {
			t.Errorf("%s: %d blessings offered at level %d (death.novice_max_level)", id, n, novice)
		}
		f.level = novice + 1
		if n := count(); n != b.Death.MaxBlessings {
			t.Errorf("%s: %d blessings offered at level %d, want %d", id, n, novice+1, b.Death.MaxBlessings)
		}
	}
}
