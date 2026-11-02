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
