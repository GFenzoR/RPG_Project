package content

import (
	"errors"
	"fmt"
	"sort"
)

// Condition kinds (T3.2, docs/02-game-design.md "Condiciones"). The kind decides what a
// condition does; its numbers come from balance.yaml conditions.
const (
	// ConditionDamage hits its holder every interval_ms with the element, ticks times.
	ConditionDamage = "damage"
	// ConditionSpeed changes the holder's speed by speed_pct while it lasts.
	ConditionSpeed = "speed"
	// ConditionSkill adds amount levels to the holder's skill while it lasts (combat only).
	ConditionSkill = "skill"
	// ConditionInvisible hides the holder from players and monsters that cannot see it.
	ConditionInvisible = "invisible"
)

// Stacking rules: what a new application of a condition the holder already has does.
const (
	// StackRefresh keeps the longer duration (or more ticks) and the stronger damage.
	StackRefresh = "refresh"
	// StackAdd adds the new duration (or ticks) to what is left, up to the maximum.
	StackAdd = "add"
)

// ConditionDef is one entry of balance.yaml conditions.
type ConditionDef struct {
	ID   string `yaml:"-"`
	Kind string `yaml:"kind"`
	// Element and IntervalMs: the damage of a damage condition and how often it hits.
	Element    string `yaml:"element"`
	IntervalMs int    `yaml:"interval_ms"`
	// MaxTicks caps the hits a damage condition has left; MaxMs caps the time a timed
	// condition has left.
	MaxTicks int `yaml:"max_ticks"`
	MaxMs    int `yaml:"max_ms"`
	// SpeedPct is the speed change of a speed condition (negative slows).
	SpeedPct int `yaml:"speed_pct"`
	// Skill and Amount: the skill a skill condition raises and by how many levels.
	Skill  string `yaml:"skill"`
	Amount int    `yaml:"amount"`
	// Stacking is StackRefresh or StackAdd.
	Stacking string `yaml:"stacking"`
	// Cancels lists the conditions an application of this one removes (haste ends a
	// slow and the other way round).
	Cancels []string `yaml:"cancels"`
	// Persists marks a condition that survives a logout (saved with its time left).
	Persists bool `yaml:"persists"`
}

// ConditionDefs maps condition id to its definition.
type ConditionDefs map[string]*ConditionDef

// IDs returns the condition ids, sorted.
func (cs ConditionDefs) IDs() []string {
	ids := make([]string, 0, len(cs))
	for id := range cs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (cs ConditionDefs) check() error {
	for _, id := range cs.IDs() {
		c := cs[id]
		c.ID = id
		switch c.Stacking {
		case StackRefresh, StackAdd:
		default:
			return fmt.Errorf("conditions.%s: stacking must be refresh or add", id)
		}
		for _, o := range c.Cancels {
			if cs[o] == nil || o == id {
				return fmt.Errorf("conditions.%s: cancels unknown condition %q", id, o)
			}
		}
		switch c.Kind {
		case ConditionDamage:
			if c.Element == "" || c.IntervalMs <= 0 || c.MaxTicks <= 0 {
				return fmt.Errorf("conditions.%s: a damage condition needs element, interval_ms > 0 and max_ticks > 0", id)
			}
		case ConditionSpeed, ConditionSkill, ConditionInvisible:
			if c.MaxMs <= 0 {
				return fmt.Errorf("conditions.%s: max_ms must be > 0", id)
			}
			if c.Kind == ConditionSpeed && (c.SpeedPct == 0 || c.SpeedPct <= -100) {
				return fmt.Errorf("conditions.%s: speed_pct must be non-zero and > -100", id)
			}
			if c.Kind == ConditionSkill && (c.Skill == "" || c.Amount <= 0) {
				return fmt.Errorf("conditions.%s: a skill condition needs skill and amount > 0", id)
			}
		default:
			return fmt.Errorf("conditions.%s: unknown kind %q", id, c.Kind)
		}
	}
	return nil
}

// ConditionApply is a source of a condition (a spell, a monster attack): which one and
// how much. A damage condition takes Ticks hits of Damage; the others last DurationMs.
// Chance 0 means always. Range (spells only) aims the condition at a monster at up to
// Range tiles in line of sight instead of the caster.
type ConditionApply struct {
	ID         string  `yaml:"id"`
	Chance     float64 `yaml:"chance"`
	Ticks      int     `yaml:"ticks"`
	Damage     int     `yaml:"damage"`
	DurationMs int     `yaml:"duration_ms"`
	Range      int     `yaml:"range"`
}

// Check validates a against the condition definitions.
func (a *ConditionApply) Check(cs ConditionDefs) error {
	if a == nil {
		return nil
	}
	def := cs[a.ID]
	switch {
	case def == nil:
		return fmt.Errorf("unknown condition %q", a.ID)
	case a.Chance < 0 || a.Chance > 1:
		return errors.New("condition chance must be in 0..1")
	case def.Kind == ConditionDamage && (a.Ticks <= 0 || a.Damage <= 0):
		return fmt.Errorf("condition %s needs ticks and damage > 0", a.ID)
	case def.Kind != ConditionDamage && a.DurationMs <= 0:
		return fmt.Errorf("condition %s needs duration_ms > 0", a.ID)
	}
	return nil
}
