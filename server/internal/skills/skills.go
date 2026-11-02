// Package skills holds the progress rules of use-based skills and of experience levels
// (docs/02-game-design.md, "Experiencia y nivel" and "Skills que suben con el uso").
// Every number comes from data/balance.yaml and data/vocations.yaml; the functions are
// pure, so the game loop and tests share them.
//
//	tries(n) = base_tries × vocation_factor^(n − start_level)
//
// tries(n) is what level n costs to reach n+1. Progress resets to zero on each level.
package skills

import (
	"math"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// MaxLevel bounds skill levels (a safety net: the curve makes it unreachable).
const MaxLevel = 500

// TriesFor returns the tries that level costs to advance to level+1, or 0 if the skill
// cannot advance (base_tries 0 or out of range).
func TriesFor(b content.SkillBase, factor float64, level int) int64 {
	if b.BaseTries <= 0 || level >= MaxLevel {
		return 0
	}
	n := float64(level - b.StartLevel)
	t := float64(b.BaseTries) * math.Pow(max(factor, 1), max(n, 0))
	if t >= math.MaxInt64/2 {
		return math.MaxInt64 / 2
	}
	return max(int64(math.Round(t)), 1)
}

// Progress is a skill's level and the tries made toward the next one.
type Progress struct {
	Level int
	Tries int64
}

// Add adds n tries and returns how many levels were gained.
func (p *Progress) Add(b content.SkillBase, factor float64, n int64) int {
	gained := 0
	if n <= 0 {
		return 0
	}
	p.Tries += n
	for {
		need := TriesFor(b, factor, p.Level)
		if need == 0 || p.Tries < need {
			break
		}
		p.Tries -= need
		p.Level++
		gained++
	}
	if TriesFor(b, factor, p.Level) == 0 {
		p.Tries = 0
	}
	return gained
}

// Percent returns the progress (0-99) toward the next level.
func (p Progress) Percent(b content.SkillBase, factor float64) int {
	need := TriesFor(b, factor, p.Level)
	if need <= 0 || p.Tries <= 0 {
		return 0
	}
	return int(min(p.Tries*100/need, 99))
}

// LevelFor returns the level a character with xp total experience has, between 1 and
// e.MaxLevel (no cap if MaxLevel is 0).
func LevelFor(e content.Experience, xp int64) int {
	level := 1
	for (e.MaxLevel <= 0 || level < e.MaxLevel) && level < 100_000 {
		next := e.TotalFor(level + 1)
		if next <= e.TotalFor(level) || xp < next {
			break
		}
		level++
	}
	return level
}
