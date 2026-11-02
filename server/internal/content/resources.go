package content

import (
	"errors"
	"fmt"
)

// Resource is a gathering spot (T1.12): using a tool whose tool.use is Tool on a tile
// with this item tries to harvest it. Each tile runs out after Charges successful
// harvests and refills RegenMs after its last one (docs/06-content-data.md).
type Resource struct {
	Tool string `yaml:"tool"`
	// Skill sets the success chance and gains a try with every attempt.
	Skill string `yaml:"skill"`
	// Reach is the Chebyshev distance to use the tool from (0 = inventory.reach).
	Reach   int `yaml:"reach"`
	Charges int `yaml:"charges"`
	RegenMs int `yaml:"regen_ms"`
	Chance  struct {
		Base     float64 `yaml:"base"`
		PerLevel float64 `yaml:"per_level"`
		Max      float64 `yaml:"max"`
	} `yaml:"chance"`
	Drops []ResourceDrop `yaml:"drops"`
}

// ResourceDrop is one possible harvest: picked by Weight among the drops whose
// MinLevel the skill reaches, Count [min, max] units (default 1).
type ResourceDrop struct {
	Item     string `yaml:"item"`
	Weight   int    `yaml:"weight"`
	MinLevel int    `yaml:"min_level"`
	Count    []int  `yaml:"count"`
}

// SuccessChance is min(Max, Base + PerLevel × (level − start)), never below 0.
func (r *Resource) SuccessChance(level, start int) float64 {
	c := r.Chance.Base + r.Chance.PerLevel*float64(level-start)
	return max(0, min(c, r.Chance.Max))
}

// CountRange returns the [min, max] units of a drop.
func (d ResourceDrop) CountRange() (lo, hi int) {
	if len(d.Count) == 2 {
		return d.Count[0], d.Count[1]
	}
	return 1, 1
}

// Check verifies the numbers the server relies on and that every drop is a known item.
func (r *Resource) Check(items Items) error {
	if r.Tool == "" || r.Skill == "" || r.Charges <= 0 || r.RegenMs <= 0 || r.Reach < 0 {
		return errors.New("resource: tool and skill required, charges and regen_ms > 0, reach >= 0")
	}
	c := r.Chance
	if c.Base < 0 || c.PerLevel < 0 || c.Max > 1 || c.Base > c.Max {
		return errors.New("resource: chance needs 0 <= base <= max <= 1 and per_level >= 0")
	}
	if len(r.Drops) == 0 {
		return errors.New("resource: no drops")
	}
	for _, d := range r.Drops {
		lo, hi := d.CountRange()
		if items[d.Item] == nil || d.Weight <= 0 || d.MinLevel < 0 || lo <= 0 || lo > hi || (len(d.Count) != 0 && len(d.Count) != 2) {
			return fmt.Errorf("resource: drop %q needs a known item, weight > 0 and 0 < count min <= max", d.Item)
		}
	}
	return nil
}
