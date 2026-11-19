package content

import (
	"math"
	"math/rand/v2"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// The forge's rules (docs/02 "Forja"): the table, the bands, the smithing bonus, what a
// level adds, the checks of balance.yaml forge, and the economy targets of its costs.

func repoForge(t *testing.T) (Forge, Items) {
	t.Helper()
	dir := filepath.Join("..", "..", "..", "data")
	b, err := LoadBalance(dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := LoadItems(dir)
	if err != nil {
		t.Fatal(err)
	}
	return b.Forge, items
}

func TestForgeRepoData(t *testing.T) {
	f, items := repoForge(t)
	if !f.Enabled || f.MaxLevel() != 10 || f.SafeLevel != 4 {
		t.Fatalf("forge %+v", f)
	}
	if err := f.CheckItems(items); err != nil {
		t.Fatal(err)
	}
	// The owner's rules: +1..+4 never fail; from +5 the chance drops at every level.
	want := []int{100, 100, 100, 100, 70, 55, 40, 25, 15, 8}
	for level := 1; level <= 10; level++ {
		if c := f.Chance(level, 0); c != want[level-1] {
			t.Errorf("chance of +%d: %d, want %d", level, c, want[level-1])
		}
	}
	// The smithing bonus: the smithing craft's level (data, not Go), at most +5 points, at
	// the top recipes' smithing (30), never on a sure attempt.
	if f.SmithingBonus.Skill != "smithing" {
		t.Errorf("bonus skill %q", f.SmithingBonus.Skill)
	}
	if f.Chance(5, 30) != 75 || f.Chance(5, 100) != 75 || f.Chance(5, 11) != 71 || f.Chance(3, 30) != 100 {
		t.Errorf("bonus: %d %d %d %d", f.Chance(5, 30), f.Chance(5, 100), f.Chance(5, 11), f.Chance(3, 30))
	}
	// Each band has a stone the smiths of its islands can sell and grows what a level gives.
	for i, b := range f.Bands {
		if i > 0 {
			p := f.Bands[i-1]
			if b.Attack < p.Attack || b.Armor < p.Armor || b.Defense < p.Defense || b.Gold <= p.Gold {
				t.Errorf("band %d gives or costs less than band %d", b.Level, p.Level)
			}
		}
	}
	// The catalog's jewels (neck and ring, lote 11) take the jewel path: a share of their
	// attribute, never armor; its armor pieces have a requires.level, so they spread over
	// the bands instead of all refining as band 1.
	jewels, banded := 0, map[int]bool{}
	for id, def := range items {
		if def.Armor == nil || def.Retired {
			continue
		}
		switch slot, kind := def.Armor.Slot, RefineKind(def); {
		case slot == "neck" || slot == "ring":
			jewels++
			if kind != RefineJewel || f.Gain(def, 10) != 0 {
				t.Errorf("%s: refine kind %q, gain %d", id, kind, f.Gain(def, 10))
			}
		case kind == RefineArmor:
			banded[f.Band(def.Requires.Level).Level] = true
		}
	}
	if jewels == 0 || len(banded) < 4 {
		t.Errorf("catalog: %d jewels, armor in the bands %v", jewels, banded)
	}
	// The protection is the rare one: worth more than any stone.
	for _, b := range f.Bands {
		if items[f.Protection].Value <= items[b.Stone].Value {
			t.Errorf("%s is worth less than %s", f.Protection, b.Stone)
		}
	}
}

func itemOf(t *testing.T, src string) *Item {
	t.Helper()
	var it Item
	if err := yaml.Unmarshal([]byte(src), &it); err != nil {
		t.Fatal(err)
	}
	return &it
}

func TestForgeGain(t *testing.T) {
	f, items := repoForge(t)
	sword := itemOf(t, "{id: s, weapon: {type: sword, attack: 10}}")
	bigSword := itemOf(t, "{id: b, weapon: {type: sword, attack: 43}, requires: {level: 75}}")
	helm := itemOf(t, "{id: c, armor: {slot: head, armor: 1}}")
	shield := itemOf(t, "{id: h, shield: {defense: 22}, requires: {level: 30}}")
	ring := itemOf(t, "{id: r, armor: {slot: ring}}")
	cases := []struct {
		def   *Item
		level int
		want  int
	}{
		{sword, 0, 0}, {sword, 1, 0}, {sword, 2, 1}, {sword, 7, 3}, {sword, 10, 5},
		{bigSword, 7, 15}, {bigSword, 10, 22},
		{helm, 4, 0}, {helm, 5, 1}, {helm, 10, 2},
		{shield, 7, 5}, {shield, 10, 8},
		{ring, 10, 0}, // a jewel's gain is its attribute's share (JewelGain)
	}
	for _, c := range cases {
		if got := f.Gain(c.def, c.level); got != c.want {
			t.Errorf("%s +%d gains %d, want %d", c.def.ID, c.level, got, c.want)
		}
	}
	if RefineKind(ring) != RefineJewel || RefineKind(helm) != RefineArmor || RefineKind(shield) != RefineDefense ||
		RefineKind(sword) != RefineAttack {
		t.Error("refine kinds")
	}
	for _, id := range []string{"arrow", "backpack", "copper_coin", "lesser_temper_stone"} {
		if def := items[id]; def != nil && RefineKind(def) != "" {
			t.Errorf("%s is refinable", id)
		}
	}
	if f.JewelGain(20, 5) != 10 || f.JewelGain(3, 10) != 3 || f.JewelGain(3, 3) != 0 {
		t.Errorf("jewel gain %d %d %d", f.JewelGain(20, 5), f.JewelGain(3, 10), f.JewelGain(3, 3))
	}
	if f.Gold(1, 5) != 15 || f.Gold(30, 7) != 840 || f.Gold(80, 10) != 7000 {
		t.Errorf("gold %d %d %d", f.Gold(1, 5), f.Gold(30, 7), f.Gold(80, 10))
	}
}

func TestForgeCheck(t *testing.T) {
	good := func() Forge {
		f, _ := repoForge(t)
		return f
	}
	cases := map[string]func(*Forge){
		"no station":         func(f *Forge) { f.Station = "" },
		"no levels":          func(f *Forge) { f.Levels = nil },
		"safe at the top":    func(f *Forge) { f.SafeLevel = len(f.Levels) },
		"safe that can fail": func(f *Forge) { f.Levels[1].Chance = 90 },
		"first risky sure":   func(f *Forge) { f.Levels[4].Chance = 100 },
		"chance grows":       func(f *Forge) { f.Levels[8].Chance = 30 },
		"chance flat":        func(f *Forge) { f.Levels[8].Chance = f.Levels[7].Chance },
		"zero chance":        func(f *Forge) { f.Levels[9].Chance = 0 },
		"no stones":          func(f *Forge) { f.Levels[0].Stones = 0 },
		"first band":         func(f *Forge) { f.Bands[0].Level = 5 },
		"bands out of order": func(f *Forge) { f.Bands[2].Level = 3 },
		"band without stone": func(f *Forge) { f.Bands[1].Stone = "" },
		"negative gain":      func(f *Forge) { f.Bands[1].Attack = -1 },
		"jewelry over 100":   func(f *Forge) { f.JewelryPct = 101 },
		"bonus of no skill":  func(f *Forge) { f.SmithingBonus.Skill = "" },
	}
	for name, change := range cases {
		f := good()
		f.Levels = append([]ForgeLevel(nil), f.Levels...)
		f.Bands = append([]ForgeBand(nil), f.Bands...)
		change(&f)
		if err := f.check(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if f := good(); f.check() != nil {
		t.Fatal(f.check())
	}
	if err := (&Forge{}).check(); err != nil {
		t.Errorf("a disabled forge: %v", err)
	}
	f, items := repoForge(t)
	f.Protection = "iron_sword"
	if err := f.CheckItems(items); err == nil || !strings.Contains(err.Error(), "stackable material") {
		t.Errorf("an equipable as protection: %v", err)
	}
}

// ---- economy targets (docs/02 "Forja", "Costo esperado") -------------------------------

// forgeTarget is a row of docs/02's table: an item of the catalog band of requires.level
// level and reference value value (the catalog's V), the expected copper to take it from +0
// to +4, to +7 without the protection (a broken item replaced at its value) and to +7 with
// it from +5 on (the ambers apart), and the expected ambers of that +7.
type forgeTarget struct {
	level, value                 int
	plus4, plus7, plus7Protected float64
	ambers7                      float64
}

var forgeTargets = []forgeTarget{
	{1, 30, 70, 1100, 530, 11.4},
	{5, 150, 160, 3100, 1300, 11.4},
	{10, 600, 1000, 17000, 7500, 11.4},
	{30, 2000, 1800, 36000, 14000, 11.4},
	{50, 5000, 5400, 102000, 41000, 11.4},
	{75, 12000, 9400, 197000, 74000, 11.4},
}

// attemptCost is the copper of the attempt to reach level of an item of requires.level item.
func attemptCost(f Forge, items Items, item, level int) float64 {
	return float64(f.Gold(item, level)) + float64(f.Level(level).Stones*items[f.Band(item).Stone].Value)
}

// expectedBare is the expected copper to take a new item from +0 to +top without the
// protection: a broken item starts again from +0, replaced at value.
func expectedBare(f Forge, items Items, item, value, top int) float64 {
	e := 0.0
	for level := 1; level <= top; level++ {
		p := float64(f.Chance(level, 0)) / 100
		c := attemptCost(f, items, item, level)
		e += (c + (1-p)*(float64(value)+e)) / p // the attempts to climb from level-1, breaks included
	}
	return e
}

// expectedProtected is the expected copper (and ambers) to take a new item from +0 to +top
// with the protection in every attempt that can fail: a failure costs one level. Solved by
// value iteration on the levels' chain.
func expectedProtected(f Forge, items Items, item, top int) (copper, ambers float64) {
	cost, amber := make([]float64, top+1), make([]float64, top+1)
	for range 200000 {
		for k := top - 1; k >= 0; k-- {
			level := k + 1
			p := float64(f.Chance(level, 0)) / 100
			c := attemptCost(f, items, item, level)
			if p >= 1 {
				cost[k], amber[k] = c+cost[k+1], amber[k+1]
				continue
			}
			down := max(k-1, 0)
			cost[k] = c + p*cost[k+1] + (1-p)*cost[down]
			amber[k] = 1 + p*amber[k+1] + (1-p)*amber[down]
		}
	}
	return cost[0], amber[0]
}

// The expected cost to reach +4, +7 and +10 in each catalog band matches docs/02's targets
// (within 5 %): +4 about one item's value, +7 a project (16-37 times it without the amber,
// 6-18 with ~11 ambers), +10 a legend (thousands of times the value, or ~1 900 ambers).
func TestForgeExpectedCosts(t *testing.T) {
	f, items := repoForge(t)
	near := func(got, want float64) bool { return math.Abs(got-want) <= 0.05*want }
	for _, x := range forgeTargets {
		p4 := expectedBare(f, items, x.level, x.value, 4)
		p7 := expectedBare(f, items, x.level, x.value, 7)
		c7, a7 := expectedProtected(f, items, x.level, 7)
		if !near(p4, x.plus4) || !near(p7, x.plus7) || !near(c7, x.plus7Protected) || !near(a7, x.ambers7) {
			t.Errorf("band of level %d: +4 %.0f (want %.0f), +7 %.0f (want %.0f), +7 protected %.0f and %.1f ambers (want %.0f and %.1f)",
				x.level, p4, x.plus4, p7, x.plus7, c7, a7, x.plus7Protected, x.ambers7)
		}
		if r := p4 / float64(x.value); r < 0.5 || r > 3 {
			t.Errorf("band of level %d: +4 costs %.1f times the item", x.level, r)
		}
		if r := p7 / float64(x.value); r < 10 || r > 40 {
			t.Errorf("band of level %d: +7 costs %.1f times the item", x.level, r)
		}
		p10 := expectedBare(f, items, x.level, x.value, 10)
		_, a10 := expectedProtected(f, items, x.level, 10)
		if r := p10 / float64(x.value); r < 3000 {
			t.Errorf("band of level %d: +10 costs only %.0f times the item", x.level, r)
		}
		if a10 < 1500 || a10 > 2500 {
			t.Errorf("band of level %d: +10 with the protection takes %.0f ambers", x.level, a10)
		}
	}
}

// The seeded roll of an attempt (session: ctx.Rand.IntN(100) < chance) succeeds at the
// table's rate.
func TestForgeChanceRate(t *testing.T) {
	f, _ := repoForge(t)
	r := rand.New(rand.NewPCG(11, 12))
	for level := 5; level <= 10; level++ {
		c, n, ok := f.Chance(level, 0), 20000, 0
		for range n {
			if r.IntN(100) < c {
				ok++
			}
		}
		if got := float64(ok) / float64(n) * 100; math.Abs(got-float64(c)) > 1.5 {
			t.Errorf("+%d: %.1f %% succeeded, want %d %%", level, got, c)
		}
	}
}
