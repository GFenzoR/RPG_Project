package content

import (
	"path/filepath"
	"testing"
)

func TestLoadBalanceRepoData(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatalf("LoadBalance: %v", err)
	}
	if b.Movement.BaseStepMs <= 0 || b.Movement.DiagonalCost < 1 || b.Movement.MaxPathTiles != 100 {
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

func TestParseBalanceErrors(t *testing.T) {
	for name, src := range map[string]string{
		"no movement":   "skills: {}",
		"bad diagonal":  "movement: {base_step_ms: 1000, diagonal_cost: 0.5, max_path_tiles: 100}",
		"too long path": "movement: {base_step_ms: 1000, diagonal_cost: 1.5, max_path_tiles: 101}",
		"not yaml":      "movement: [",
	} {
		if _, err := ParseBalance([]byte(src)); err == nil {
			t.Errorf("%s: expected error", name)
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
	} {
		if _, err := ParseMonster([]byte(src)); err == nil {
			t.Errorf("%s: expected error", name)
		}
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
