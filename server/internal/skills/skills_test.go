package skills

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

func TestTriesFor(t *testing.T) {
	b := content.SkillBase{StartLevel: 10, BaseTries: 45}
	cases := []struct {
		level  int
		factor float64
		want   int64
	}{{10, 1.11, 45}, {11, 1.11, 50}, {12, 1.11, 55}, {10, 1.85, 45}, {11, 1.85, 83}, {9, 1.5, 45}}
	for _, c := range cases {
		if got := TriesFor(b, c.factor, c.level); got != c.want {
			t.Errorf("TriesFor(level %d, factor %v) = %d, want %d", c.level, c.factor, got, c.want)
		}
	}
	if TriesFor(content.SkillBase{StartLevel: 10}, 1.1, 10) != 0 {
		t.Error("base_tries 0 must never advance")
	}
}

func TestAddCarriesOverAndPercent(t *testing.T) {
	b := content.SkillBase{StartLevel: 10, BaseTries: 10}
	p := Progress{Level: 10}
	if g := p.Add(b, 2, 9); g != 0 || p.Percent(b, 2) != 90 {
		t.Fatalf("after 9: gained %d, %+v, %d%%", g, p, p.Percent(b, 2))
	}
	// 9 + 26 = 35: level 10 costs 10, level 11 costs 20, 5 left toward level 12 (40).
	if g := p.Add(b, 2, 26); g != 2 || p.Level != 12 || p.Tries != 5 {
		t.Fatalf("after 35: gained %d, %+v", g, p)
	}
	if p.Percent(b, 2) != 12 {
		t.Errorf("percent = %d, want 12", p.Percent(b, 2))
	}
	if g := p.Add(b, 2, 0); g != 0 || p.Tries != 5 {
		t.Errorf("adding 0 changed %+v", p)
	}
}

func TestLevelFor(t *testing.T) {
	var e content.Experience
	e.Curve.A, e.Curve.B, e.Curve.C = 12, -24, 12 // xp(2)=24, xp(3)=144, xp(4)=432
	e.MaxLevel = 3
	for xp, want := range map[int64]int{0: 1, 23: 1, 24: 2, 143: 2, 144: 3, 100_000: 3} {
		if got := LevelFor(e, xp, 1); got != want {
			t.Errorf("LevelFor(%d) = %d, want %d", xp, got, want)
		}
	}
	if got := LevelFor(e, 200, 2); got != 3 {
		t.Errorf("LevelFor from 2 = %d, want 3", got)
	}
}
