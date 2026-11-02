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
		vs[v.ID] = v
	}
	return vs, nil
}
