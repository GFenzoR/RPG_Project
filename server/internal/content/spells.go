package content

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Spell groups of data/spells.yaml: a cast also blocks the other spells of its group
// for group_cooldown_ms.
const (
	SpellGroupAttack  = "attack"
	SpellGroupHealing = "healing"
	SpellGroupSupport = "support"
)

// Scaling is a damage or heal amount (docs/02-game-design.md, "Combate"):
// base + level × per_level + magic level × per_magic_level (+ the level of Skill ×
// per_skill, T3.1), rolled within ±spread.
type Scaling struct {
	Base          float64 `yaml:"base"`
	PerLevel      float64 `yaml:"per_level"`
	PerMagicLevel float64 `yaml:"per_magic_level"`
	Skill         string  `yaml:"skill"`
	PerSkill      float64 `yaml:"per_skill"`
	Spread        float64 `yaml:"spread"`
}

// SpellHeal is a heal effect: the caster, or with Range (T3.1) another player at up to
// Range tiles in line of sight.
type SpellHeal struct {
	Scaling `yaml:",inline"`
	Range   int `yaml:"range"`
}

// SpellConjure creates Count units of Item in the caster's backpack (0 = a rune's
// charges, or 1).
type SpellConjure struct {
	Item  string `yaml:"item"`
	Count int    `yaml:"count"`
}

// SpellDamage is a damage effect: one creature at up to Range tiles, or every monster
// within Radius tiles of the caster (Range 0).
type SpellDamage struct {
	Scaling `yaml:",inline"`
	Element string `yaml:"element"`
	Range   int    `yaml:"range"`
	Radius  int    `yaml:"radius"`
	// Condition (T3.2) is applied to every creature the damage reaches, with its chance.
	Condition *ConditionApply `yaml:"condition"`
}

// SpellEffect is what a spell does; exactly one field is set.
type SpellEffect struct {
	Damage  *SpellDamage  `yaml:"damage"`
	Heal    *SpellHeal    `yaml:"heal"`
	Conjure *SpellConjure `yaml:"conjure"`
	// Condition (T3.2) puts a condition on the caster, or with Range on a monster.
	Condition *ConditionApply `yaml:"condition"`
	// Cure (T3.2) removes these conditions from the caster.
	Cure []string `yaml:"cure"`
	// Light is in the schema for a later milestone; the server rejects it.
	Light any `yaml:"light"`
}

// Spell is an entry of data/spells.yaml.
type Spell struct {
	ID              string      `yaml:"id"`
	Words           string      `yaml:"words"`
	Vocations       []string    `yaml:"vocations"`
	Level           int         `yaml:"level"`
	MagicLevel      int         `yaml:"magic_level"`
	Mana            int         `yaml:"mana"`
	Group           string      `yaml:"group"`
	CooldownMs      int         `yaml:"cooldown_ms"`
	GroupCooldownMs int         `yaml:"group_cooldown_ms"`
	Effect          SpellEffect `yaml:"effect"`
}

// CastBy reports whether vocation may cast the spell.
func (s *Spell) CastBy(vocation string) bool {
	for _, v := range s.Vocations {
		if v == vocation {
			return true
		}
	}
	return false
}

// Spells maps spell id to its definition.
type Spells map[string]*Spell

// IDs returns the spell ids, sorted.
func (ss Spells) IDs() []string {
	ids := make([]string, 0, len(ss))
	for id := range ss {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// ByWords indexes spells by their normalized words (NormalizeWords).
func (ss Spells) ByWords() map[string]*Spell {
	out := make(map[string]*Spell, len(ss))
	for _, s := range ss {
		out[NormalizeWords(s.Words)] = s
	}
	return out
}

// NormalizeWords lowercases text and collapses its spaces, so "  Vita   LUMEN " casts
// "vita lumen".
func NormalizeWords(text string) string {
	return strings.Join(strings.Fields(strings.ToLower(text)), " ")
}

// CheckConditions validates the conditions the spells apply or cure (T3.2).
func (ss Spells) CheckConditions(cs ConditionDefs) error {
	for _, id := range ss.IDs() {
		e := ss[id].Effect
		if err := e.Condition.Check(cs); err != nil {
			return fmt.Errorf("spells: %s: %w", id, err)
		}
		if e.Damage != nil {
			if err := e.Damage.Condition.Check(cs); err != nil {
				return fmt.Errorf("spells: %s: damage: %w", id, err)
			}
		}
		for _, c := range e.Cure {
			if cs[c] == nil {
				return fmt.Errorf("spells: %s: cures unknown condition %q", id, c)
			}
		}
	}
	return nil
}

// LoadSpells reads <dataDir>/spells.yaml (no file means no spells) and checks what the
// server needs: one supported effect per spell and a known group.
func LoadSpells(dataDir string) (Spells, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, "spells.yaml"))
	if errors.Is(err, fs.ErrNotExist) {
		return Spells{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read spells: %w", err)
	}
	var list []*Spell
	if err := yaml.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decode spells: %w", err)
	}
	out := Spells{}
	words := map[string]string{}
	for _, s := range list {
		if s.ID == "" || out[s.ID] != nil {
			return nil, fmt.Errorf("spells: missing or duplicate id %q", s.ID)
		}
		w := NormalizeWords(s.Words)
		if w == "" || words[w] != "" {
			return nil, fmt.Errorf("spells: %s: empty words or words already used by %q", s.ID, words[w])
		}
		words[w] = s.ID
		if err := s.check(); err != nil {
			return nil, fmt.Errorf("spells: %s: %w", s.ID, err)
		}
		out[s.ID] = s
	}
	return out, nil
}

func (s *Spell) check() error {
	switch s.Group {
	case SpellGroupAttack, SpellGroupHealing, SpellGroupSupport:
	default:
		return fmt.Errorf("unknown group %q", s.Group)
	}
	e := s.Effect
	n := 0
	for _, set := range []bool{e.Damage != nil, e.Heal != nil, e.Conjure != nil, e.Condition != nil, len(e.Cure) > 0} {
		if set {
			n++
		}
	}
	if e.Light != nil {
		return errors.New("light effects are not supported yet")
	}
	if n != 1 {
		return errors.New("needs exactly one effect")
	}
	if d := e.Damage; d != nil && (d.Range > 0) == (d.Radius > 0) {
		return errors.New("damage needs either range (one target) or radius (area)")
	}
	for _, sc := range []*Scaling{damageScaling(e.Damage), healScaling(e.Heal)} {
		if sc != nil && (sc.Skill == "") != (sc.PerSkill == 0) {
			return errors.New("skill and per_skill go together")
		}
	}
	return nil
}

func damageScaling(d *SpellDamage) *Scaling {
	if d == nil {
		return nil
	}
	return &d.Scaling
}

func healScaling(h *SpellHeal) *Scaling {
	if h == nil {
		return nil
	}
	return &h.Scaling
}
