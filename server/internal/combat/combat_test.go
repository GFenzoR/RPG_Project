package combat

import (
	"math/rand/v2"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

var cfg = content.Combat{SkillAttackDivisor: 10, LevelDivisor: 4, ShieldBlockDivisor: 4}

func TestMaxHit(t *testing.T) {
	cases := []struct {
		skill, attack, level int
		mode                 float64
		want                 int
	}{
		{10, 7, 1, 1, 7},      // fists at level 1: 7 + 0.25
		{10, 10, 4, 1, 11},    // 10 + 1
		{10, 10, 4, 1.25, 13}, // offensive: 11 × 1.25 = 13.75
		{10, 10, 4, 0.65, 7},  // defensive: 11 × 0.65 = 7.15
	}
	for _, c := range cases {
		if got := MaxHit(cfg, c.skill, c.attack, c.level, c.mode); got != c.want {
			t.Errorf("MaxHit(%d, %d, %d, %v) = %d, want %d", c.skill, c.attack, c.level, c.mode, got, c.want)
		}
	}
}

func TestHitsStayInRange(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for range 10000 {
		if d := HitMonster(r, 10, MonsterTarget{Armor: 2, Defense: 5}); d < 0 || d > 10 {
			t.Fatalf("HitMonster = %d", d)
		}
		if d := HitMonster(r, 10, MonsterTarget{PhysicalResistance: -50}); d < 0 || d > 15 {
			t.Fatalf("HitMonster with weakness = %d", d)
		}
		if d := HitPlayer(r, cfg, 0, 16, true, PlayerTarget{Armor: 4, ShieldDefense: 12, ModeDefense: 1.5}); d < 0 || d > 16 {
			t.Fatalf("HitPlayer = %d", d)
		}
		if d := HitPlayer(r, cfg, 10, 25, false, PlayerTarget{Armor: 40}); d < 10 || d > 25 {
			t.Fatalf("non-physical HitPlayer = %d (armor must not apply)", d)
		}
	}
	if d := HitMonster(r, 0, MonsterTarget{}); d != 0 {
		t.Fatalf("zero max hit dealt %d", d)
	}
}

func TestDefenseLowersAverageDamage(t *testing.T) {
	avg := func(p PlayerTarget) float64 {
		r := rand.New(rand.NewPCG(3, 4))
		sum := 0
		for range 20000 {
			sum += HitPlayer(r, cfg, 0, 20, true, p)
		}
		return float64(sum) / 20000
	}
	none := avg(PlayerTarget{ModeDefense: 1})
	balanced := avg(PlayerTarget{ShieldDefense: 12, ModeDefense: 1})
	defensive := avg(PlayerTarget{ShieldDefense: 12, ModeDefense: 1.5})
	if !(none > balanced && balanced > defensive) {
		t.Fatalf("average damage: no shield %.2f, balanced %.2f, defensive %.2f", none, balanced, defensive)
	}
}

func TestScaledAndResist(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	s := content.Scaling{Base: 10, PerLevel: 0.5, PerMagicLevel: 2}
	// No spread: exact value 10 + 20×0.5 + 5×2 = 30.
	if got := Scaled(r, s, 20, 5); got != 30 {
		t.Fatalf("Scaled without spread = %d, want 30", got)
	}
	s.Spread = 0.2
	for range 200 {
		if got := Scaled(r, s, 20, 5); got < 24 || got > 36 {
			t.Fatalf("Scaled = %d outside [24, 36]", got)
		}
	}
	for _, c := range []struct{ dmg, res, want int }{
		{100, 0, 100}, {100, 50, 50}, {100, -10, 110}, {100, 100, 0}, {100, 150, 0}, {7, 10, 6},
	} {
		if got := Resist(c.dmg, c.res); got != c.want {
			t.Errorf("Resist(%d, %d) = %d, want %d", c.dmg, c.res, got, c.want)
		}
	}
	for range 200 {
		if got := WandHit(r, 13, 0.5); got < 6 || got > 13 {
			t.Fatalf("WandHit = %d outside [6, 13]", got)
		}
	}
}
