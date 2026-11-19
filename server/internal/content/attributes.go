package content

import (
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"

	"go.yaml.in/yaml/v3"
)

// Item attributes (docs/02-game-design.md "Atributos de items", docs/06 "Atributo"): every
// equipable rolls exactly one attribute of data/attributes.yaml when it is created.

// Attribute effects (attributes.yaml effect): what an attribute adds to the player who
// wears the item.
const (
	EffectMaxHealth   = "max_health"
	EffectMaxMana     = "max_mana"
	EffectAttack      = "attack"
	EffectArmor       = "armor"
	EffectDefense     = "defense"
	EffectSkill       = "skill"
	EffectSpeed       = "speed"
	EffectHealthRegen = "health_regen"
	EffectManaRegen   = "mana_regen"
	EffectProtection  = "protection"
	EffectLifeLeech   = "life_leech"
	EffectManaLeech   = "mana_leech"
)

var effects = []string{EffectMaxHealth, EffectMaxMana, EffectAttack, EffectArmor, EffectDefense, EffectSkill,
	EffectSpeed, EffectHealthRegen, EffectManaRegen, EffectProtection, EffectLifeLeech, EffectManaLeech}

// AttributeSkills are the skills an attribute of effect skill may raise (magic = magic level).
var AttributeSkills = []string{"sword", "axe", "club", "distance", "magic"}

// AttributeElements are the elements an attribute of effect protection may protect from.
var AttributeElements = []string{"fire", "ice", "energy", "earth", "holy", "death"}

// attributeKinds are the values of an attribute's on: a weapon by weapon.type, a shield,
// or an armor by armor.slot.
var attributeKinds = []string{"sword", "axe", "club", "distance", "wand", "shield", "head", "body", "legs", "feet",
	"neck", "ring"}

// AttributeBand is the value range of an attribute on items of requires.level >= Level
// (up to the next band).
type AttributeBand struct {
	Level int `yaml:"level"`
	Min   int `yaml:"min"`
	Max   int `yaml:"max"`
}

// Attribute is one entry of data/attributes.yaml.
type Attribute struct {
	ID      string `yaml:"id"`
	Effect  string `yaml:"effect"`
	Skill   string `yaml:"skill"`
	Element string `yaml:"element"`
	// Text is the i18n key of the card's line, with {value}.
	Text   string          `yaml:"text"`
	On     []string        `yaml:"on"`
	Weight int             `yaml:"weight"`
	Cap    int             `yaml:"cap"`
	Bands  []AttributeBand `yaml:"bands"`
	Notes  string          `yaml:"notes"`
}

// Band returns the value range of the attribute on an item of requires.level level (0 or
// less: level 1): the last band whose Level is <= it.
func (a *Attribute) Band(level int) AttributeBand {
	level = max(level, 1)
	b := a.Bands[0]
	for _, x := range a.Bands[1:] {
		if x.Level > level {
			break
		}
		b = x
	}
	return b
}

// Attributes is the pool of data/attributes.yaml, in file order.
type Attributes []*Attribute

// ByID returns the attribute id, or nil.
func (as Attributes) ByID(id string) *Attribute {
	for _, a := range as {
		if a.ID == id {
			return a
		}
	}
	return nil
}

// AttributeKind is the kind an item rolls its attribute as: the weapon's weapon.type,
// "shield", or the armor's armor.slot; "" for anything else, which never rolls one (ammo,
// containers, consumables, tools, materials, grounds, walls and decorations). The fixed
// items of the map (world.bin) are not instances: they never roll, whatever their kind.
func AttributeKind(def *Item) string {
	switch {
	case def == nil || def.Stackable:
		return ""
	case def.Weapon != nil:
		return def.Weapon.Type
	case def.Shield != nil:
		return "shield"
	case def.Armor != nil:
		return def.Armor.Slot
	}
	return ""
}

// Rolls reports whether def is an equipable that rolls an attribute.
func Rolls(def *Item) bool { return AttributeKind(def) != "" }

// For returns the attributes def may roll (none when it is not an equipable).
func (as Attributes) For(def *Item) []*Attribute {
	kind := AttributeKind(def)
	if kind == "" {
		return nil
	}
	var out []*Attribute
	for _, a := range as {
		if slices.Contains(a.On, kind) {
			out = append(out, a)
		}
	}
	return out
}

// Roll picks def's attribute by weight among For(def) and its value uniform in the band
// of def's requires.level. ok is false when def rolls none.
func (as Attributes) Roll(r *rand.Rand, def *Item) (a *Attribute, value int, ok bool) {
	pool := as.For(def)
	total := 0
	for _, x := range pool {
		total += x.Weight
	}
	if total <= 0 {
		return nil, 0, false
	}
	pick := r.IntN(total)
	for _, x := range pool {
		if pick < x.Weight {
			a = x
			break
		}
		pick -= x.Weight
	}
	b := a.Band(def.Requires.Level)
	return a, b.Min + r.IntN(b.Max-b.Min+1), true
}

// Mean is what def's attribute adds on average, by attribute id: each attribute's chance
// times the middle of its band (the balance simulations, server/internal/sim).
func (as Attributes) Mean(def *Item) map[string]float64 {
	pool := as.For(def)
	total := 0
	for _, x := range pool {
		total += x.Weight
	}
	out := map[string]float64{}
	for _, x := range pool {
		b := x.Band(def.Requires.Level)
		out[x.ID] += float64(x.Weight) / float64(total) * float64(b.Min+b.Max) / 2
	}
	return out
}

func (a *Attribute) check() error {
	switch {
	case a.ID == "":
		return errors.New("missing id")
	case !slices.Contains(effects, a.Effect):
		return fmt.Errorf("unknown effect %q", a.Effect)
	case (a.Effect == EffectSkill) != (a.Skill != ""), a.Skill != "" && !slices.Contains(AttributeSkills, a.Skill):
		return fmt.Errorf("skill %q: only (and always) on effect skill, one of %v", a.Skill, AttributeSkills)
	case (a.Effect == EffectProtection) != (a.Element != ""), a.Element != "" && !slices.Contains(AttributeElements, a.Element):
		return fmt.Errorf("element %q: only (and always) on effect protection, one of %v", a.Element, AttributeElements)
	case a.Text == "":
		return errors.New("missing text")
	case len(a.On) == 0:
		return errors.New("on lists no kind")
	case a.Weight <= 0:
		return errors.New("weight must be > 0")
	case a.Cap < 0:
		return errors.New("cap must be >= 0")
	case len(a.Bands) == 0 || a.Bands[0].Level != 1:
		return errors.New("the first band must be level 1")
	}
	for _, k := range a.On {
		if !slices.Contains(attributeKinds, k) {
			return fmt.Errorf("on: unknown kind %q", k)
		}
	}
	for i, b := range a.Bands {
		if i > 0 && b.Level <= a.Bands[i-1].Level {
			return errors.New("band levels must grow")
		}
		if b.Min < 1 || b.Max < b.Min {
			return fmt.Errorf("band of level %d: need 1 <= min <= max", b.Level)
		}
	}
	return nil
}

// LoadAttributes reads <dataDir>/attributes.yaml (no file: an empty pool, nothing rolls).
func LoadAttributes(dataDir string) (Attributes, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, "attributes.yaml"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read attributes: %w", err)
	}
	var list Attributes
	if err := yaml.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decode attributes: %w", err)
	}
	seen := map[string]bool{}
	for _, a := range list {
		if err := a.check(); err != nil {
			return nil, fmt.Errorf("attributes: %q: %w", a.ID, err)
		}
		if seen[a.ID] {
			return nil, fmt.Errorf("attributes: duplicate id %q", a.ID)
		}
		seen[a.ID] = true
	}
	return list, nil
}
