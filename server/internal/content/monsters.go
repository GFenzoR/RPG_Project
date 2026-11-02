package content

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"go.yaml.in/yaml/v3"
)

// Monster is the part of a data/monsters/*.yaml file the server uses (T1.6: melee).
type Monster struct {
	ID          string          `yaml:"id"`
	Health      int             `yaml:"health"`
	Experience  int64           `yaml:"experience"`
	Speed       int             `yaml:"speed"`
	Armor       int             `yaml:"armor"`
	Defense     int             `yaml:"defense"`
	Behavior    MonsterBehavior `yaml:"behavior"`
	Attacks     []MonsterAttack `yaml:"attacks"`
	Resistances map[string]int  `yaml:"resistances"`
	Loot        []LootEntry     `yaml:"loot"`
}

// MonsterBehavior drives the monster's state machine.
type MonsterBehavior struct {
	Aggressive      bool `yaml:"aggressive"`
	FleeAtHealthPct int  `yaml:"flee_at_health_pct"`
	TargetDistance  int  `yaml:"target_distance"`
}

// MonsterAttack is one attack of a monster. Chance 0 means always (1).
type MonsterAttack struct {
	Type       string  `yaml:"type"`
	Element    string  `yaml:"element"`
	Min        int     `yaml:"min"`
	Max        int     `yaml:"max"`
	IntervalMs int     `yaml:"interval_ms"`
	Chance     float64 `yaml:"chance"`
	Range      int     `yaml:"range"`
}

// LootEntry is one possible drop. Count is [min, max]; empty means exactly one.
type LootEntry struct {
	Item   string  `yaml:"item"`
	Chance float64 `yaml:"chance"`
	Count  []int   `yaml:"count"`
}

// CountRange returns the drop's [min, max] amount.
func (l LootEntry) CountRange() (lo, hi int) {
	if len(l.Count) == 2 {
		return l.Count[0], l.Count[1]
	}
	return 1, 1
}

// Monsters maps monster id to its definition.
type Monsters map[string]*Monster

// IDs returns the monster ids, sorted.
func (ms Monsters) IDs() []string {
	ids := make([]string, 0, len(ms))
	for id := range ms {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// LoadMonsters reads every <dataDir>/monsters/*.yaml.
func LoadMonsters(dataDir string) (Monsters, error) {
	files, err := filepath.Glob(filepath.Join(dataDir, "monsters", "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("list monsters: %w", err)
	}
	ms := make(Monsters, len(files))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read monster: %w", err)
		}
		m, err := ParseMonster(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		if _, dup := ms[m.ID]; dup {
			return nil, fmt.Errorf("%s: duplicate monster %q", f, m.ID)
		}
		ms[m.ID] = m
	}
	return ms, nil
}

// ParseMonster decodes one monster file and checks what the server relies on.
func ParseMonster(raw []byte) (*Monster, error) {
	var m Monster
	if err := yaml.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("decode monster: %w", err)
	}
	if m.ID == "" {
		return nil, errors.New("monster: missing id")
	}
	if m.Health <= 0 || m.Speed <= 0 || m.Experience < 0 || m.Armor < 0 || m.Defense < 0 {
		return nil, fmt.Errorf("monster %q: health and speed must be > 0; experience, armor and defense >= 0", m.ID)
	}
	if m.Behavior.TargetDistance <= 0 {
		m.Behavior.TargetDistance = 1
	}
	if m.Behavior.TargetDistance > 1 {
		// Keeping distance only makes sense with ranged attacks, which arrive with T1.9.
		return nil, fmt.Errorf("monster %q: target_distance > 1 needs ranged attacks (T1.9)", m.ID)
	}
	for i := range m.Attacks {
		a := &m.Attacks[i]
		if a.Min < 0 || a.Max < a.Min || a.IntervalMs <= 0 {
			return nil, fmt.Errorf("monster %q: attacks[%d]: need 0 <= min <= max and interval_ms > 0", m.ID, i)
		}
		if a.Chance == 0 {
			a.Chance = 1
		}
		if a.Element == "" {
			a.Element = "physical"
		}
	}
	for i, l := range m.Loot {
		lo, hi := l.CountRange()
		if l.Item == "" || l.Chance < 0 || l.Chance > 1 || lo < 1 || hi < lo {
			return nil, fmt.Errorf("monster %q: loot[%d]: bad item, chance or count", m.ID, i)
		}
	}
	return &m, nil
}
