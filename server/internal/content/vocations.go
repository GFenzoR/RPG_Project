// Package content loads game content from data/*.yaml.
//
// The YAML is validated against its JSON Schema by `make validate`
// (packages/content-schema); this package only decodes the fields the server uses and
// checks the invariants it relies on.
package content

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"go.yaml.in/yaml/v3"
)

// Vocation is the part of a data/vocations.yaml entry the server needs so far.
type Vocation struct {
	ID       string        `yaml:"id"`
	Start    VocationStats `yaml:"start"`
	PerLevel VocationStats `yaml:"per_level"`
	Regen    Regen         `yaml:"regen"`
	// SkillFactors is the per-level cost multiplier of each skill:
	// tries(n) = base_tries × factor^(n − start_level). A missing skill uses factor 1.
	SkillFactors map[string]float64 `yaml:"skill_factors"`
	// Weapons are the weapon types (data/items weapon.type) the vocation can wield.
	Weapons []string `yaml:"weapons"`
	// StartKit is what a new character gets once, at its first login (docs/02 "Equipo
	// inicial"): each piece in the slot it fits, the rest in the backpack and pockets.
	StartKit []KitItem `yaml:"start_kit"`
}

// KitItem is one entry of a vocation's start_kit: Count units of the item Item (0 = 1).
type KitItem struct {
	Item  string `yaml:"item"`
	Count int    `yaml:"count"`
}

// Units is how many units the entry gives (at least 1).
func (k KitItem) Units() int { return max(k.Count, 1) }

// Regen is what a vocation recovers every IntervalMs.
type Regen struct {
	Health     int `yaml:"health"`
	Mana       int `yaml:"mana"`
	IntervalMs int `yaml:"interval_ms"`
}

// Tick returns the health and mana one regeneration tick gives with the regen conditions
// (food, content audit m2) adding pct %: Health × (100 + pct) / 100, rounded down, and the
// same for Mana. The server and the balance simulation both use it.
func (r Regen) Tick(pct int) (health, mana int) {
	more := 100 + pct
	return r.Health * more / 100, r.Mana * more / 100
}

// SkillFactor returns the vocation's factor for skill id (1 if it has none).
func (v Vocation) SkillFactor(id string) float64 {
	if f, ok := v.SkillFactors[id]; ok {
		return f
	}
	return 1
}

// AtLevel returns the vocation's stats at level (1 = Start).
func (v Vocation) AtLevel(level int) VocationStats {
	n := max(level, 1) - 1
	return VocationStats{
		Health:   v.Start.Health + n*v.PerLevel.Health,
		Mana:     v.Start.Mana + n*v.PerLevel.Mana,
		Capacity: v.Start.Capacity + n*v.PerLevel.Capacity,
		Speed:    v.Start.Speed + n*v.PerLevel.Speed,
	}
}

// VocationStats are a vocation's stats at level 1.
type VocationStats struct {
	Health   int `yaml:"health"`
	Mana     int `yaml:"mana"`
	Capacity int `yaml:"capacity"`
	Speed    int `yaml:"speed"`
}

// Vocations maps vocation id to its definition.
type Vocations map[string]Vocation

// LoadVocations reads <dataDir>/vocations.yaml.
func LoadVocations(dataDir string) (Vocations, error) {
	path := filepath.Join(dataDir, "vocations.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read vocations: %w", err)
	}
	vs, err := ParseVocations(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return vs, nil
}

// ParseVocations decodes the contents of a vocations.yaml file.
func ParseVocations(raw []byte) (Vocations, error) {
	var list []Vocation
	if err := yaml.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decode vocations: %w", err)
	}
	if len(list) == 0 {
		return nil, errors.New("no vocations defined")
	}
	vs := make(Vocations, len(list))
	for i, v := range list {
		if v.ID == "" {
			return nil, fmt.Errorf("vocation #%d: missing id", i)
		}
		if _, dup := vs[v.ID]; dup {
			return nil, fmt.Errorf("vocation %q: duplicate id", v.ID)
		}
		if v.Start.Health <= 0 || v.Start.Mana < 0 {
			return nil, fmt.Errorf("vocation %q: start health must be > 0 and mana >= 0", v.ID)
		}
		if v.Start.Speed <= 0 || v.PerLevel.Speed < 0 {
			return nil, fmt.Errorf("vocation %q: start speed must be > 0 and per_level speed >= 0", v.ID)
		}
		if v.Regen.Health < 0 || v.Regen.Mana < 0 || v.Regen.IntervalMs < 0 {
			return nil, fmt.Errorf("vocation %q: regen values must be >= 0", v.ID)
		}
		for j, k := range v.StartKit {
			if k.Item == "" || k.Count < 0 {
				return nil, fmt.Errorf("vocation %q: start_kit #%d needs an item and a count that is not negative (none or 0: one unit)", v.ID, j)
			}
		}
		for id, f := range v.SkillFactors {
			if f < 1 || f > 10 {
				return nil, fmt.Errorf("vocation %q: skill_factors.%s must be in 1..10", v.ID, id)
			}
		}
		vs[v.ID] = v
	}
	return vs, nil
}
