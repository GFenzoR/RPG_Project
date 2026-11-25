package content

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestLoadBalanceRepoData(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatalf("LoadBalance: %v", err)
	}
	if b.Movement.BaseStepMs <= 0 || b.Movement.DiagonalCost < 1 || b.Movement.MaxPathTiles != 100 || b.Movement.MaxQueuedSteps != 4 {
		t.Errorf("movement = %+v", b.Movement)
	}
	if len(b.SkillIDs()) == 0 || b.Skills.Base["sword"].StartLevel <= 0 {
		t.Errorf("skills = %+v", b.Skills)
	}
	if b.Experience.TotalFor(1) != 0 || b.Experience.TotalFor(2) <= 0 {
		t.Errorf("curve: xp(1)=%d xp(2)=%d", b.Experience.TotalFor(1), b.Experience.TotalFor(2))
	}
	if c := b.Chat; c.MaxLength != MaxChatLength || c.Ranges.Say.X <= c.Ranges.Whisper.X || c.Ranges.Yell.X <= c.Ranges.Say.X {
		t.Errorf("chat = %+v", c)
	}
	if err := (Chat{MaxLength: 300}).check(); err == nil {
		t.Error("chat.max_length 300 accepted")
	}
	vs, err := LoadVocations(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	g := vs["guardian"]
	if g.AtLevel(1) != g.Start || g.AtLevel(3).Speed != g.Start.Speed+2*g.PerLevel.Speed {
		t.Errorf("AtLevel: %+v %+v", g.AtLevel(1), g.AtLevel(3))
	}
}

func TestLevelPercent(t *testing.T) {
	var e Experience
	e.Curve.A, e.Curve.B, e.Curve.C = 12, -24, 12 // xp(2)=24, xp(3)=144
	cases := []struct {
		level int
		xp    int64
		want  int
	}{{1, 0, 0}, {1, 12, 50}, {1, 24, 99}, {2, 24, 0}, {2, 84, 50}, {2, 10, 0}}
	for _, c := range cases {
		if got := e.LevelPercent(c.level, c.xp); got != c.want {
			t.Errorf("LevelPercent(%d, %d) = %d, want %d", c.level, c.xp, got, c.want)
		}
	}
}

// movement.diagonal_cost is 1..MaxDiagonalCost: the pathfinder's costs are sized for it.
func TestDiagonalCostRange(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "data", "balance.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	const line = "diagonal_cost: 1.414"
	if !strings.Contains(string(raw), line) {
		t.Fatalf("balance.yaml has no %q", line)
	}
	for cost, ok := range map[string]bool{"1": true, "1.5": true, "2": true, "2.001": false, "10": false, "0.99": false} {
		_, err := ParseBalance([]byte(strings.Replace(string(raw), line, "diagonal_cost: "+cost, 1)))
		if ok && err != nil {
			t.Errorf("diagonal_cost %s: %v", cost, err)
		}
		if !ok && (err == nil || !strings.Contains(err.Error(), "diagonal_cost")) {
			t.Errorf("diagonal_cost %s: err = %v, want it refused", cost, err)
		}
	}
}

func TestParseBalanceErrors(t *testing.T) {
	for name, src := range map[string]string{
		"no movement":   "skills: {}",
		"bad diagonal":  "movement: {base_step_ms: 1000, diagonal_cost: 0.5, max_path_tiles: 100}",
		"too long path": "movement: {base_step_ms: 1000, diagonal_cost: 1.5, max_path_tiles: 101, max_queued_steps: 4}",
		"no queue":      "movement: {base_step_ms: 1000, diagonal_cost: 1.5, max_path_tiles: 100}",
		"deep queue":    "movement: {base_step_ms: 1000, diagonal_cost: 1.5, max_path_tiles: 100, max_queued_steps: 9}",
		"not yaml":      "movement: [",
	} {
		if _, err := ParseBalance([]byte(src)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

// travel.link_dead_max_ms is 0 (no cap) or at least combat_block_ms: a cap below the block
// would cut every fight short of it.
func TestLinkDeadMaxMs(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "data", "balance.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	const repo = "link_dead_max_ms: 120000"
	if !strings.Contains(string(raw), repo) {
		t.Fatalf("data/balance.yaml has no %q", repo)
	}
	for v, ok := range map[string]bool{"0": true, "12000": true, "3600000": true, "11999": false, "3600001": false, "-1": false} {
		b, err := ParseBalance([]byte(strings.Replace(string(raw), repo, "link_dead_max_ms: "+v, 1)))
		if (err == nil) != ok {
			t.Errorf("link_dead_max_ms %s: error %v", v, err)
		} else if ok && strconv.Itoa(b.Travel.LinkDeadMaxMs) != v {
			t.Errorf("link_dead_max_ms %s read as %d", v, b.Travel.LinkDeadMaxMs)
		}
	}
}

func TestLoadMonstersAndItemsRepoData(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "data")
	ms, err := LoadMonsters(dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := LoadItems(dir)
	if err != nil {
		t.Fatal(err)
	}
	w := ms["wolf"]
	if w == nil || w.Health <= 0 || len(w.Attacks) == 0 || w.Attacks[0].Chance != 1 || w.Attacks[0].Element != "physical" {
		t.Fatalf("wolf = %+v", w)
	}
	for _, m := range ms {
		for _, l := range m.Loot {
			if items[l.Item] == nil {
				t.Errorf("%s drops unknown item %q", m.ID, l.Item)
			}
		}
	}
	if items["copper_coin"] == nil || items["copper_coin"].Numeric == 0 {
		t.Errorf("copper_coin = %+v", items["copper_coin"])
	}
	b, err := LoadBalance(dir)
	if err != nil {
		t.Fatal(err)
	}
	if b.Combat.AttackIntervalMs != 2000 || b.Combat.Modes["balanced"].Attack != 1 {
		t.Errorf("combat = %+v", b.Combat)
	}
}

func TestParseMonsterErrors(t *testing.T) {
	for name, src := range map[string]string{
		"no id":      "health: 5\nspeed: 100",
		"no health":  "id: x\nspeed: 100",
		"bad attack": "id: x\nhealth: 5\nspeed: 100\nattacks: [{type: melee, min: 5, max: 1, interval_ms: 2000}]",
		"bad loot":   "id: x\nhealth: 5\nspeed: 100\nloot: [{item: a, chance: 2}]",
		"ranged":     "id: x\nhealth: 5\nspeed: 100\nbehavior: {target_distance: 3}",
		// Abilities (areas, heal_self, summon, phases).
		"unknown type":       atk("{type: kick, min: 1, max: 2, interval_ms: 2000}"),
		"unknown shape":      atk("{type: spell, min: 1, max: 2, interval_ms: 2000, area: {shape: cone, radius: 2}}"),
		"circle no radius":   atk("{type: spell, min: 1, max: 2, interval_ms: 2000, area: {shape: circle}}"),
		"circle too wide":    atk("{type: spell, min: 1, max: 2, interval_ms: 2000, area: {shape: circle, radius: 7}}"),
		"circle elsewhere":   atk("{type: spell, min: 1, max: 2, interval_ms: 2000, area: {shape: circle, radius: 1, center: north}}"),
		"beam no length":     atk("{type: spell, min: 1, max: 2, interval_ms: 2000, area: {shape: beam}}"),
		"beam on the target": atk("{type: spell, min: 1, max: 2, interval_ms: 2000, area: {shape: beam, length: 3, center: target}}"),
		"beam with radius":   atk("{type: spell, min: 1, max: 2, interval_ms: 2000, area: {shape: beam, length: 3, radius: 1}}"),
		// A beam or a circle around the monster reaches its length or radius: a range
		// would be ignored, and whoever writes it may think it counts.
		"beam with range":   atk("{type: spell, min: 1, max: 2, interval_ms: 2000, range: 4, area: {shape: beam, length: 3}}"),
		"circle with range": atk("{type: distance, min: 1, max: 2, interval_ms: 2000, range: 4, area: {shape: circle, radius: 1}}"),
		"self with range":   atk("{type: spell, min: 1, max: 2, interval_ms: 2000, range: 2, area: {shape: circle, radius: 2, center: self}}"),
		"heal nothing":      atk("{type: heal_self, min: 0, max: 0, interval_ms: 2000}"),
		"heal an area":      atk("{type: heal_self, min: 1, max: 2, interval_ms: 2000, area: {shape: circle, radius: 1}}"),
		"heal fire":         atk("{type: heal_self, element: fire, min: 1, max: 2, interval_ms: 2000}"),
		"below 101":         atk("{type: melee, min: 1, max: 2, interval_ms: 2000, below_hp_pct: 101}"),
		"summon nothing":    atk("{type: summon, interval_ms: 2000}"),
		"summon nobody":     atk("{type: summon, interval_ms: 2000, summon: {count: 1}}"),
		"summon nine":       atk("{type: summon, interval_ms: 2000, summon: {monster: imp, count: 9}}"),
		"summon damage":     atk("{type: summon, min: 1, max: 2, interval_ms: 2000, summon: {monster: imp, count: 1}}"),
		"summon on a melee": atk("{type: melee, min: 1, max: 2, interval_ms: 2000, summon: {monster: imp, count: 1}}"),
		"phase at 100":      "id: x\nhealth: 5\nspeed: 100\nphases: [{below_hp_pct: 100}]",
		"two phases at 50":  "id: x\nhealth: 5\nspeed: 100\nphases: [{below_hp_pct: 50}, {below_hp_pct: 50}]",
		"phase too fast":    "id: x\nhealth: 5\nspeed: 100\nphases: [{below_hp_pct: 50, speed_mult: 5}]",
		"phase bad attack":  "id: x\nhealth: 5\nspeed: 100\nphases: [{below_hp_pct: 50, attacks_add: [{type: melee, min: 3, max: 1, interval_ms: 9}]}]",
	} {
		if _, err := ParseMonster([]byte(src)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

// atk is a monster with the one attack src.
func atk(src string) string { return "id: x\nhealth: 5\nspeed: 100\nattacks: [" + src + "]" }

// ParseMonster fills an ability's defaults and sorts the phases from the highest
// below_hp_pct, so the phases a monster is in are always the first ones.
func TestParseMonsterAbilities(t *testing.T) {
	m, err := ParseMonster([]byte(`id: boss
health: 100
speed: 100
attacks:
  - { type: spell, min: 1, max: 2, interval_ms: 2000, area: { shape: circle, radius: 2 } }
  - { type: spell, min: 1, max: 2, interval_ms: 2000, area: { shape: beam, length: 4 } }
  - { type: distance, min: 1, max: 2, interval_ms: 2000, range: 5, area: { shape: circle, radius: 1, center: target } }
  - { type: summon, interval_ms: 9000, summon: { monster: imp, count: 2 } }
  - { type: heal_self, min: 5, max: 9, interval_ms: 3000, below_hp_pct: 40 }
phases:
  - { below_hp_pct: 20, attacks_add: [ { type: melee, min: 1, max: 3, interval_ms: 1000 } ] }
  - { below_hp_pct: 60, speed_mult: 1.5 }
`))
	if err != nil {
		t.Fatal(err)
	}
	a := m.Attacks
	if a[0].Area.Center != AreaSelf || a[1].Area.Center != AreaSelf || a[0].Element != "physical" || a[0].Chance != 1 {
		t.Errorf("area defaults: %+v %+v", a[0], a[1].Area)
	}
	if a[3].Summon.MaxAlive != 2 || a[3].Element != "" || a[3].Targeted() || a[4].Targeted() || !a[0].Targeted() {
		t.Errorf("summon: %+v %+v", a[3], a[3].Summon)
	}
	for i, want := range []int{2, 4, 5} {
		if got := a[i].Reach(); got != want {
			t.Errorf("attacks[%d].Reach() = %d, want %d", i, got, want)
		}
	}
	if p := m.Phases; p[0].BelowHealthPct != 60 || p[1].BelowHealthPct != 20 || p[0].AttackIntervalMult != 1 || p[1].SpeedMult != 1 {
		t.Errorf("phases %+v", p)
	}
	if all := m.AllAttacks(); len(all) != 6 || all[5].Max != 3 || !m.Summons() {
		t.Errorf("AllAttacks = %d, Summons = %v", len(all), m.Summons())
	}
}

func TestAntiBotBalance(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	if e := b.Economy; e.Log.FlushMs <= 0 || e.Log.BatchSize <= 0 || e.CheckEveryMs <= 0 || e.Outlier.GoldPerHour.At(10) <= e.Outlier.GoldPerHour.Base {
		t.Errorf("economy = %+v", e)
	}
	if r := b.Reports; r.Burst <= 0 || r.MaxReason != MaxReportReason || r.Events <= 0 {
		t.Errorf("reports = %+v", r)
	}
	if i := b.Idle; i.KickAfterMs < 60_000 || i.WarnBeforeMs <= 0 || i.WarnBeforeMs >= i.KickAfterMs {
		t.Errorf("idle = %+v", i)
	}
	if (Idle{KickAfterMs: 120_000, WarnBeforeMs: 120_000}).check() == nil || (Idle{}).check() != nil {
		t.Error("idle check")
	}
	if (Reports{Burst: 1, RefillMs: 1, MaxReason: 201}).check() == nil || (Reports{Burst: 1, RefillMs: 1, MaxReason: 10, Events: 33}).check() == nil {
		t.Error("reports check")
	}
	var e Economy
	e.Log.FlushMs, e.Log.BatchSize, e.Outlier.WindowMs = 1000, 10, 1000
	e.Outlier.GoldPerHour.Base, e.Outlier.ItemsPerHour.Base = 1, 1
	if e.check() == nil {
		t.Error("economy.outlier.window_ms 1000 accepted")
	}
}

// The pace target is a power law between its anchors: about 3 levels an hour at 9, 0.9 at
// 21, 0.5 at 32 and 0.27 at 47 for level 8 in 1 h, 20 in 8 h and 50 in 80 h.
func TestExperiencePace(t *testing.T) {
	e := Experience{Pace: []PaceAnchor{{8, 1}, {20, 8}, {50, 80}}}
	if err := e.check(); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		level  int
		lo, hi float64
	}{{9, 2.8, 3.3}, {21, 0.85, 1.05}, {32, 0.45, 0.55}, {47, 0.25, 0.3}, {100, 0.05, 0.12}} {
		if got := e.LevelsPerHour(c.level); got < c.lo || got > c.hi {
			t.Errorf("level %d: %.3f levels/h", c.level, got)
		}
	}
	for _, bad := range [][]PaceAnchor{{{8, 1}}, {{8, 1}, {8, 2}}, {{8, 2}, {20, 1}}, {{1, 1}, {20, 8}}} {
		if (Experience{Pace: bad}).check() == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

// The live market refresh interval is a balance number (market.push_every_ms): the repo's
// data sets it and the check bounds it (at least a tick, at most a minute).
func TestMarketPushEvery(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	if b.Market.PushEveryMs != 500 {
		t.Errorf("market.push_every_ms = %d, want 500", b.Market.PushEveryMs)
	}
	m := b.Market
	for _, bad := range []int{0, 49, 60_001} {
		m.PushEveryMs = bad
		if m.check() == nil {
			t.Errorf("push_every_ms %d accepted", bad)
		}
	}
	m.Enabled, m.PushEveryMs = false, 0
	if m.check() != nil {
		t.Error("a disabled market needs no push_every_ms")
	}
}

// combat.monster_leash_tiles: 6 in data/, 0 (no leash) accepted, negative refused.
func TestMonsterLeashTiles(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	c := b.Combat
	if c.MonsterLeashTiles != 6 {
		t.Errorf("combat.monster_leash_tiles = %d, want 6", c.MonsterLeashTiles)
	}
	for leash, ok := range map[int]bool{-1: false, 0: true, 6: true} {
		c.MonsterLeashTiles = leash
		if (c.check() == nil) != ok {
			t.Errorf("combat.monster_leash_tiles %d: accepted %v, want %v", leash, !ok, ok)
		}
	}
}

// The leash's pathfinding times (combat.monster_path_retry_ms, monster_stuck_ms and
// monster_shun_ms; review of lote 5): 1 s, 2 s and 30 s in data/, each required > 0.
func TestMonsterPathTimes(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	c := b.Combat
	if c.MonsterPathRetryMs != 1000 || c.MonsterStuckMs != 2000 || c.MonsterShunMs != 30000 {
		t.Errorf("combat.monster_path_retry_ms, stuck_ms, shun_ms = %d, %d, %d; want 1000, 2000, 30000",
			c.MonsterPathRetryMs, c.MonsterStuckMs, c.MonsterShunMs)
	}
	for _, f := range []*int{&c.MonsterPathRetryMs, &c.MonsterStuckMs, &c.MonsterShunMs} {
		was := *f
		*f = 0
		if c.check() == nil {
			t.Errorf("a combat block with one of the leash's times at 0 was accepted: %+v", c)
		}
		*f = was
	}
}

// Every character has 1 to MaxPocketSlots pocket cells (docs/02 "Bolsillos"): data/ has 4,
// the number the owner chose, and none or more than one row of the client's inventory is
// refused.
func TestPocketSlots(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	if b.Inventory.PocketSlots != 4 {
		t.Errorf("inventory.pocket_slots = %d, want 4", b.Inventory.PocketSlots)
	}
	inv := b.Inventory
	for n, ok := range map[int]bool{0: false, 1: true, MaxPocketSlots: true, MaxPocketSlots + 1: false} {
		inv.PocketSlots = n
		if (inv.check() == nil) != ok {
			t.Errorf("inventory.pocket_slots %d: accepted %v, want %v", n, !ok, ok)
		}
	}
}

// inventory.reach and resource.reach stay within the view (MaxReach, 6 tiles): the server
// answers nothing about a tile out of view, so a longer reach could only ever fail.
func TestReachWithinTheView(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	inv := b.Inventory
	for reach, ok := range map[int]bool{0: false, 1: true, MaxReach: true, MaxReach + 1: false} {
		inv.Reach = reach
		if (inv.check() == nil) != ok {
			t.Errorf("inventory.reach %d: accepted %v, want %v", reach, !ok, ok)
		}
	}
	items, err := LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	// The first resource by id: the same one every run (items is a map).
	for _, id := range slices.Sorted(maps.Keys(items)) {
		it := items[id]
		if it.Resource == nil {
			continue
		}
		r := *it.Resource
		for reach, ok := range map[int]bool{-1: false, 0: true, MaxReach: true, MaxReach + 1: false} {
			r.Reach = reach
			if (r.Check(items) == nil) != ok {
				t.Errorf("%s resource.reach %d: accepted %v, want %v", it.ID, reach, !ok, ok)
			}
		}
		return
	}
	t.Fatal("no resource in data/items")
}
