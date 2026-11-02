package content

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"go.yaml.in/yaml/v3"
)

// Balance is the part of data/balance.yaml the server uses so far.
type Balance struct {
	Movement   Movement   `yaml:"movement"`
	Experience Experience `yaml:"experience"`
	Skills     Skills     `yaml:"skills"`
	Combat     Combat     `yaml:"combat"`
}

// Combat holds the melee constants (docs/02-game-design.md, "Combate").
type Combat struct {
	AttackIntervalMs   int                   `yaml:"attack_interval_ms"`
	FistAttack         int                   `yaml:"fist_attack"`
	SkillAttackDivisor int                   `yaml:"skill_attack_divisor"`
	LevelDivisor       int                   `yaml:"level_divisor"`
	ShieldBlockDivisor int                   `yaml:"shield_block_divisor"`
	MonsterCorpseMs    int                   `yaml:"monster_corpse_ms"`
	Modes              map[string]CombatMode `yaml:"modes"`
}

// CombatMode scales attack and shield defense for a fight stance.
type CombatMode struct {
	Attack  float64 `yaml:"attack"`
	Defense float64 `yaml:"defense"`
}

// Stances are the fight stances of balance.yaml, in protocol order (FightStance 1..3).
var Stances = [...]string{"offensive", "balanced", "defensive"}

// Movement holds the walking constants (docs/02-game-design.md, "Movimiento").
type Movement struct {
	// BaseStepMs is the step duration on 100 % terrain at speed 100:
	// step_ms = base_step_ms * terrain% / speed (diagonals × DiagonalCost).
	BaseStepMs   int     `yaml:"base_step_ms"`
	DiagonalCost float64 `yaml:"diagonal_cost"`
	MaxPathTiles int     `yaml:"max_path_tiles"`
}

// Experience is the level curve: total XP for level n is a*n^3 + b*n^2 + c*n + d.
type Experience struct {
	Curve struct {
		A, B, C, D float64
	} `yaml:"curve"`
	MaxLevel int `yaml:"max_level"`
}

// TotalFor returns the total experience needed to reach level n (0 for n <= 1).
func (e Experience) TotalFor(n int) int64 {
	if n <= 1 {
		return 0
	}
	f := float64(n)
	c := e.Curve
	return int64(c.A*f*f*f + c.B*f*f + c.C*f + c.D)
}

// LevelPercent returns the progress (0-99) from level to level+1 with xp total experience.
func (e Experience) LevelPercent(level int, xp int64) int {
	lo, hi := e.TotalFor(level), e.TotalFor(level+1)
	if hi <= lo || xp <= lo {
		return 0
	}
	p := int((xp - lo) * 100 / (hi - lo))
	return min(max(p, 0), 99)
}

// Skills holds the use-based skill constants (docs/02-game-design.md, "Skills que
// suben con el uso").
type Skills struct {
	Base map[string]SkillBase `yaml:"base"`
	// ShieldMaxTriesPerRound caps the shield tries a player earns per attack round
	// (combat.attack_interval_ms), however many attackers it has.
	ShieldMaxTriesPerRound int `yaml:"shield_max_tries_per_round"`
	AFK                    struct {
		// AfterMs: training against a target that has not fought back for this long...
		AfterMs int `yaml:"after_ms"`
		// Factor: ...earns tries at this rate (0-1).
		Factor float64 `yaml:"factor"`
	} `yaml:"afk"`
}

// SkillBase is the starting level of a skill or craft.
type SkillBase struct {
	StartLevel int `yaml:"start_level"`
	BaseTries  int `yaml:"base_tries"`
}

// SkillIDs returns the skill ids of Skills.Base, sorted (deterministic order).
func (b Balance) SkillIDs() []string {
	ids := make([]string, 0, len(b.Skills.Base))
	for id := range b.Skills.Base {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// LoadBalance reads <dataDir>/balance.yaml.
func LoadBalance(dataDir string) (Balance, error) {
	path := filepath.Join(dataDir, "balance.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		return Balance{}, fmt.Errorf("read balance: %w", err)
	}
	b, err := ParseBalance(raw)
	if err != nil {
		return Balance{}, fmt.Errorf("%s: %w", path, err)
	}
	return b, nil
}

// ParseBalance decodes balance.yaml and checks the invariants the server relies on.
func ParseBalance(raw []byte) (Balance, error) {
	var b Balance
	if err := yaml.Unmarshal(raw, &b); err != nil {
		return Balance{}, fmt.Errorf("decode balance: %w", err)
	}
	m := b.Movement
	if m.BaseStepMs <= 0 || m.BaseStepMs > 60_000 {
		return Balance{}, errors.New("movement.base_step_ms must be in 1..60000")
	}
	if m.DiagonalCost < 1 || m.DiagonalCost > 10 {
		return Balance{}, errors.New("movement.diagonal_cost must be in 1..10")
	}
	if m.MaxPathTiles <= 0 || m.MaxPathTiles > 100 {
		return Balance{}, errors.New("movement.max_path_tiles must be in 1..100 (world.MaxPathLength)")
	}
	if err := b.Combat.check(); err != nil {
		return Balance{}, err
	}
	if err := b.Skills.check(); err != nil {
		return Balance{}, err
	}
	return b, nil
}

func (s Skills) check() error {
	for id, b := range s.Base {
		if b.StartLevel < 0 || b.BaseTries < 0 {
			return fmt.Errorf("skills.base.%s: start_level and base_tries must be >= 0", id)
		}
	}
	if s.ShieldMaxTriesPerRound < 0 || s.AFK.AfterMs < 0 || s.AFK.Factor < 0 || s.AFK.Factor > 1 {
		return errors.New("skills: shield_max_tries_per_round and afk.after_ms must be >= 0, afk.factor in 0..1")
	}
	return nil
}

func (c Combat) check() error {
	if c.AttackIntervalMs <= 0 || c.FistAttack <= 0 || c.SkillAttackDivisor <= 0 ||
		c.LevelDivisor <= 0 || c.ShieldBlockDivisor <= 0 || c.MonsterCorpseMs <= 0 {
		return errors.New("combat: attack_interval_ms, fist_attack, divisors and monster_corpse_ms must be > 0")
	}
	for _, s := range Stances {
		m, ok := c.Modes[s]
		if !ok || m.Attack < 0 || m.Defense < 0 {
			return fmt.Errorf("combat.modes.%s missing or negative", s)
		}
	}
	return nil
}
