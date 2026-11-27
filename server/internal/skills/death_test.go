package skills

import (
	"math"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

var testDeath = content.Death{XPLossPct: 10, SkillLossPct: 10, EquipmentDropPct: 10, BackpackDropPct: 100,
	MaxBlessings: 5, XPLossPctAllBlessings: 3, NoviceMaxLevel: 8, CorpseMs: 600000, CorpseOwnerOnlyMs: 120000}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestDeathPenalty(t *testing.T) {
	cases := []struct {
		name             string
		blessings, level int
		want             Penalty
	}{
		{"none", 0, 20, Penalty{XPPct: 10, SkillPct: 10, EquipmentDropPct: 10, BackpackDropPct: 100}},
		{"three", 3, 20, Penalty{XPPct: 5.8, SkillPct: 5.8, EquipmentDropPct: 4, BackpackDropPct: 40}},
		{"five", 5, 20, Penalty{XPPct: 3, SkillPct: 3}},
		{"more than max", 9, 20, Penalty{XPPct: 3, SkillPct: 3}},
		{"novice", 0, 8, Penalty{XPPct: 3, SkillPct: 3}},
	}
	for _, c := range cases {
		got := DeathPenalty(testDeath, c.blessings, c.level)
		if !near(got.XPPct, c.want.XPPct) || !near(got.SkillPct, c.want.SkillPct) ||
			!near(got.EquipmentDropPct, c.want.EquipmentDropPct) || !near(got.BackpackDropPct, c.want.BackpackDropPct) {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestLoseExperience(t *testing.T) {
	if got := LoseExperience(1000, 10); got != 900 {
		t.Errorf("got %d", got)
	}
	if got := LoseExperience(0, 10); got != 0 {
		t.Errorf("got %d", got)
	}
}

func TestProgressLose(t *testing.T) {
	b := content.SkillBase{StartLevel: 10, BaseTries: 100}
	// Level 12 with 50 tries: 100 + 100 + 50 = 250 above the base; 10 % is 25.
	p := Progress{Level: 12, Tries: 50}
	p.Lose(b, 1, 10)
	if p != (Progress{Level: 12, Tries: 25}) {
		t.Errorf("small loss: %+v", p)
	}
	// 40 % of 250 = 100: down to level 11 with 50 tries.
	p = Progress{Level: 12, Tries: 50}
	p.Lose(b, 1, 40)
	if p != (Progress{Level: 11, Tries: 50}) {
		t.Errorf("level loss: %+v", p)
	}
	// Never below the base level.
	p = Progress{Level: 10, Tries: 30}
	p.Lose(b, 1, 100)
	if p != (Progress{Level: 10, Tries: 0}) {
		t.Errorf("base: %+v", p)
	}
}

func TestNoviceNotice(t *testing.T) {
	cases := []struct {
		name     string
		from, to int
		want     NoviceNotice
	}{
		{"before the last level", 5, 6, NoticeNone},
		{"one before the last", 6, 7, NoticeNone},
		{"reaches the last", 7, 8, NoticeLastLevel},
		{"jumps to the last", 3, 8, NoticeLastLevel},
		{"leaves protection", 8, 9, NoticeEnded},
		{"jumps over the last", 7, 10, NoticeEnded},
		{"already out", 9, 10, NoticeNone},
		{"no gain", 8, 8, NoticeNone},
		{"a death back to the last", 9, 8, NoticeRegained},
		{"a death far back", 10, 7, NoticeRegained},
		{"a loss inside the protection", 8, 7, NoticeNone},
		{"a loss outside it", 11, 9, NoticeNone},
	}
	for _, c := range cases {
		if got := NoviceNoticeFor(testDeath, c.from, c.to); got != c.want {
			t.Errorf("%s: NoviceNoticeFor(%d, %d) = %d, want %d", c.name, c.from, c.to, got, c.want)
		}
	}
	// The level comes from the data, never a literal.
	d := testDeath
	d.NoviceMaxLevel = 3
	if NoviceNoticeFor(d, 2, 3) != NoticeLastLevel || NoviceNoticeFor(d, 3, 4) != NoticeEnded {
		t.Error("boundaries do not follow novice_max_level")
	}
	d.NoviceMaxLevel = 0
	if NoviceNoticeFor(d, 1, 2) != NoticeNone || IsNovice(d, 1) {
		t.Error("novice_max_level 0 means no protection")
	}
	if !IsNovice(testDeath, 8) || IsNovice(testDeath, 9) {
		t.Error("IsNovice boundary")
	}
}
