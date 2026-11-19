package content

import (
	"errors"
	"fmt"
	"math"
)

// The forge (docs/02-game-design.md "Forja", balance.yaml forge): an equipable that rolls
// an attribute is refined +1..+MaxLevel at a station item (the anvil). Up to SafeLevel an
// attempt never fails; from the next level the chance drops at every level and a failure
// destroys the item, unless the protection material spent in that attempt turns the break
// into one level lost. Each attempt spends temper stones (the band's) and money.

// Refine kinds: what a level of refine adds to an item (RefineKind).
const (
	RefineAttack  = "attack"  // a weapon: its attack
	RefineArmor   = "armor"   // an armor piece (head, body, legs, feet): its armor
	RefineDefense = "defense" // a shield: its defense
	RefineJewel   = "jewel"   // a neck or ring piece: a share of its attribute's value
)

// MaxRefineLevel bounds forge.levels (the protocol's ItemMods.refine fits far more).
const MaxRefineLevel = 20

// Forge is balance.yaml forge.
type Forge struct {
	// Enabled false (or no forge block) turns the forge off: Refine is refused.
	Enabled bool `yaml:"enabled"`
	// Station is the item id of the station that refines (an item of the map).
	Station string `yaml:"station"`
	// TimeMs: after an attempt, no other one (nor a crafting or gathering one) for this
	// long (the pace of crafting, gathering.use_interval_ms at least).
	TimeMs int `yaml:"time_ms"`
	// SafeLevel: an attempt to reach this level or a lower one never fails.
	SafeLevel int `yaml:"safe_level"`
	// Protection is the item id of the rare material that turns a break into one level
	// lost, spent in every attempt it is used in.
	Protection string `yaml:"protection"`
	// SmithingBonus adds chance points by the level of a craft (smithing) to the attempts
	// that can fail.
	SmithingBonus SmithingBonus `yaml:"smithing_bonus"`
	// JewelryPct is what a level of refine adds to a neck or ring piece: this percentage of
	// its attribute's value (rounded down).
	JewelryPct int `yaml:"jewelry_pct"`
	// Levels are the attempts to reach +1, +2... in order: len(Levels) is the top level.
	Levels []ForgeLevel `yaml:"levels"`
	// Bands are by the item's requires.level, ascending from 1: what an attempt costs and
	// what each level adds.
	Bands []ForgeBand `yaml:"bands"`
}

// SmithingBonus is +1 chance point every PerLevels levels of Skill, at most Max points.
type SmithingBonus struct {
	// Skill is the skill id (balance.yaml skills.base) whose level gives the bonus: the
	// smithing craft.
	Skill     string `yaml:"skill"`
	PerLevels int    `yaml:"per_levels"`
	Max       int    `yaml:"max"`
}

// ForgeLevel is the attempt to reach one level.
type ForgeLevel struct {
	// Chance is the success chance in percent (100 = never fails), before the smithing
	// bonus.
	Chance int `yaml:"chance"`
	// Stones is how many temper stones of the item's band the attempt spends.
	Stones int `yaml:"stones"`
}

// ForgeBand is what refining an item of requires.level >= Level costs and gives (up to
// the next band).
type ForgeBand struct {
	Level int `yaml:"level"`
	// Stone is the item id of the band's temper stone.
	Stone string `yaml:"stone"`
	// Gold is the money (smallest coin) of an attempt per level it aims at: the attempt to
	// reach +n costs Gold × n.
	Gold int64 `yaml:"gold"`
	// Attack, Armor and Defense are what a level adds to a weapon, an armor piece and a
	// shield of the band (the bonus of level n is floor(n × value)).
	Attack  float64 `yaml:"attack"`
	Armor   float64 `yaml:"armor"`
	Defense float64 `yaml:"defense"`
}

// MaxLevel is the top refine level.
func (f *Forge) MaxLevel() int { return len(f.Levels) }

// Level returns the attempt to reach level (1..MaxLevel).
func (f *Forge) Level(level int) ForgeLevel { return f.Levels[level-1] }

// Band returns the band of an item of requires.level level (0 or less: level 1).
func (f *Forge) Band(level int) ForgeBand {
	level = max(level, 1)
	b := f.Bands[0]
	for _, x := range f.Bands[1:] {
		if x.Level > level {
			break
		}
		b = x
	}
	return b
}

// Bonus is the smithing bonus in chance points at smithing level skill.
func (f *Forge) Bonus(skill int) int {
	if f.SmithingBonus.PerLevels <= 0 {
		return 0
	}
	return min(max(skill, 0)/f.SmithingBonus.PerLevels, f.SmithingBonus.Max)
}

// Chance is the success chance in percent of the attempt to reach level at smithing level
// skill: the table's, plus the smithing bonus when it can fail, never above 100.
func (f *Forge) Chance(level, skill int) int {
	c := f.Level(level).Chance
	if c >= 100 || level <= f.SafeLevel {
		return 100
	}
	return min(c+f.Bonus(skill), 100)
}

// Gold is the money the attempt to reach level costs for an item of requires.level item.
func (f *Forge) Gold(item, level int) int64 { return f.Band(item).Gold * int64(level) }

// RefineKind is what refining def raises: RefineAttack (a weapon), RefineDefense (a
// shield), RefineJewel (a neck or ring piece), RefineArmor (any other armor piece); "" for
// an item the forge does not take (Rolls false: ammo, containers, anything that does not
// roll an attribute).
func RefineKind(def *Item) string {
	switch kind := AttributeKind(def); kind {
	case "":
		return ""
	case "shield":
		return RefineDefense
	case "neck", "ring":
		return RefineJewel
	case "head", "body", "legs", "feet":
		return RefineArmor
	default:
		return RefineAttack
	}
}

// Gain is what refine level adds to def: attack, armor or defense points (the kind's
// per-level value of def's band, times level, rounded down). A jewel's gain is a share of
// its attribute's value: JewelGain.
func (f *Forge) Gain(def *Item, level int) int {
	if level <= 0 || len(f.Bands) == 0 {
		return 0
	}
	b := f.Band(def.Requires.Level)
	per := 0.0
	switch RefineKind(def) {
	case RefineAttack:
		per = b.Attack
	case RefineArmor:
		per = b.Armor
	case RefineDefense:
		per = b.Defense
	}
	// A hair over the product so 0.7 × 10 is 7, not 6.999.
	return int(math.Floor(per*float64(level) + 1e-9))
}

// JewelGain is what refine level adds to a jewel's attribute of value value.
func (f *Forge) JewelGain(value, level int) int {
	if level <= 0 || value <= 0 {
		return 0
	}
	return value * f.JewelryPct * level / 100
}

func (f *Forge) check() error {
	if !f.Enabled {
		return nil
	}
	switch {
	case f.Station == "" || f.Protection == "":
		return errors.New("forge: station and protection are required")
	case f.TimeMs < 0 || f.TimeMs > 60_000:
		return errors.New("forge: time_ms must be in 0..60000")
	case len(f.Levels) == 0 || len(f.Levels) > MaxRefineLevel:
		return fmt.Errorf("forge: levels must list 1..%d attempts", MaxRefineLevel)
	case f.SafeLevel < 0 || f.SafeLevel >= len(f.Levels):
		return errors.New("forge: safe_level must be in 0..len(levels)-1 (some level must be able to fail)")
	case f.SmithingBonus.PerLevels < 0 || f.SmithingBonus.Max < 0 || f.SmithingBonus.Max > 100:
		return errors.New("forge: smithing_bonus per_levels >= 0, max in 0..100")
	case f.SmithingBonus.PerLevels > 0 && f.SmithingBonus.Skill == "":
		return errors.New("forge: smithing_bonus.skill is required (the skill whose level gives the bonus)")
	case f.JewelryPct < 0 || f.JewelryPct > 100:
		return errors.New("forge: jewelry_pct must be in 0..100")
	case len(f.Bands) == 0 || f.Bands[0].Level != 1:
		return errors.New("forge: the first band must be level 1")
	}
	for i, l := range f.Levels {
		switch {
		case l.Chance < 1 || l.Chance > 100:
			return fmt.Errorf("forge: level +%d: chance must be in 1..100", i+1)
		case l.Stones < 1:
			return fmt.Errorf("forge: level +%d: stones must be >= 1", i+1)
		case i < f.SafeLevel && l.Chance != 100:
			return fmt.Errorf("forge: level +%d is safe (safe_level %d): chance must be 100", i+1, f.SafeLevel)
		case i == f.SafeLevel && l.Chance >= 100:
			return fmt.Errorf("forge: level +%d is the first that can fail: chance must be below 100", i+1)
		case i > f.SafeLevel && l.Chance >= f.Levels[i-1].Chance:
			return fmt.Errorf("forge: level +%d: the chance must drop at every level", i+1)
		}
	}
	for i, b := range f.Bands {
		switch {
		case i > 0 && b.Level <= f.Bands[i-1].Level:
			return errors.New("forge: band levels must grow")
		case b.Stone == "":
			return fmt.Errorf("forge: band of level %d: stone is required", b.Level)
		case b.Gold < 0:
			return fmt.Errorf("forge: band of level %d: gold must be >= 0", b.Level)
		case b.Attack < 0 || b.Armor < 0 || b.Defense < 0:
			return fmt.Errorf("forge: band of level %d: attack, armor and defense must be >= 0", b.Level)
		}
	}
	return nil
}

// CheckItems checks the forge's items against items: the station, the protection and
// every band's stone exist; the stones and the protection are stackable materials (they
// are counted and spent by units).
func (f *Forge) CheckItems(items Items) error {
	if !f.Enabled {
		return nil
	}
	if items[f.Station] == nil {
		return fmt.Errorf("forge: station %q is not an item", f.Station)
	}
	ids := []string{f.Protection}
	for _, b := range f.Bands {
		ids = append(ids, b.Stone)
	}
	for _, id := range ids {
		def := items[id]
		if def == nil {
			return fmt.Errorf("forge: %q is not an item", id)
		}
		if !def.Stackable || Rolls(def) || def.Currency != nil || def.Container != nil {
			return fmt.Errorf("forge: %q must be a stackable material", id)
		}
	}
	return nil
}
