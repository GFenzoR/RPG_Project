package content

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"

	"go.yaml.in/yaml/v3"
)

// Looks is data/looks.yaml (docs/06 "Looks", docs/02 "Apariencia"): the sexes, bodies, skins,
// hair styles, hair colours and beards the sprite engine draws for its humanoids, the
// shapes and tints of what they wear, and the bound of a player's look changes. The
// server only checks ids against it: the client draws them.
type Looks struct {
	// Sexes, Builds, HairStyles and Beards in file order.
	Sexes      []string
	Builds     []string
	HairStyles []string
	Beards     []string
	// Skins and HairColors are the ids in file order; CreatureSkins those only NPCs and
	// monsters may have (creatures_only), never a player's choice.
	Skins         []string
	CreatureSkins []string
	HairColors    []string
	// Shapes are the shapes of every worn slot (head, torso, legs, feet, shield, weapon).
	Shapes map[string][]string
	// Tints are the material tints of the worn pieces.
	Tints  map[string]bool
	Limits LookLimits
}

// LookLimits bound a player's look changes (data/looks.yaml limits): every change is
// broadcast to everyone who sees it, so they go through an anti-flood like the cosmetics'
// equips (GCRA: a burst of ChangeBurst, then one every ChangeRefillMs).
type LookLimits struct {
	ChangeBurst    int `yaml:"change_burst"`
	ChangeRefillMs int `yaml:"change_refill_ms"`
}

// Look is the body of an engine humanoid: ids of data/looks.yaml.
type Look struct {
	// Sex is male or female (data/looks.yaml sexes): a body of its own per build.
	Sex       string `yaml:"sex"`
	Body      string `yaml:"body"`
	Skin      string `yaml:"skin"`
	Hair      string `yaml:"hair"`
	HairColor string `yaml:"hair_color"`
	Beard     string `yaml:"beard"`
}

// WornPiece is a piece an NPC or a monster wears: a shape and a tint of data/looks.yaml.
type WornPiece struct {
	Shape string `yaml:"shape"`
	Tint  string `yaml:"tint"`
}

// WornSlots are the slots of the figure a piece shows in, in protocol order (Worn).
var WornSlots = []string{"head", "torso", "legs", "feet", "shield", "weapon"}

// CreatureLook is the `look` block of an NPC or a humanoid monster (data/npcs,
// data/monsters): its body and what it wears (slot of WornSlots -> piece).
type CreatureLook struct {
	Look `yaml:",inline"`
	Worn map[string]WornPiece `yaml:"worn"`
}

// looksFile is the YAML shape of data/looks.yaml; the maps are read as nodes to keep
// their order (the default look of a character picks by position).
type looksFile struct {
	Sexes      []string            `yaml:"sexes"`
	Builds     []string            `yaml:"builds"`
	Skins      yaml.Node           `yaml:"skins"`
	HairStyles []string            `yaml:"hair_styles"`
	Beards     []string            `yaml:"beards"`
	HairColors yaml.Node           `yaml:"hair_colors"`
	Shapes     map[string][]string `yaml:"shapes"`
	Tints      map[string]string   `yaml:"tints"`
	Limits     LookLimits          `yaml:"limits"`
}

// LoadLooks reads <dataDir>/looks.yaml. No file means no looks (nil, nil): no creature
// is sent a look and SetLook answers appearance.unavailable.
func LoadLooks(dataDir string) (*Looks, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, "looks.yaml"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read looks: %w", err)
	}
	return ParseLooks(raw)
}

// ParseLooks decodes and checks a looks file.
func ParseLooks(raw []byte) (*Looks, error) {
	var f looksFile
	if err := yaml.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("decode looks: %w", err)
	}
	l := &Looks{
		Sexes: f.Sexes, Builds: f.Builds, HairStyles: f.HairStyles, Beards: f.Beards,
		Shapes: f.Shapes, Tints: map[string]bool{}, Limits: f.Limits,
	}
	skins, err := mapKeys(&f.Skins, "skins")
	if err != nil {
		return nil, err
	}
	for _, k := range skins {
		var s struct {
			CreaturesOnly bool `yaml:"creatures_only"`
		}
		if err := k.value.Decode(&s); err != nil {
			return nil, fmt.Errorf("looks: skin %s: %w", k.key, err)
		}
		if s.CreaturesOnly {
			l.CreatureSkins = append(l.CreatureSkins, k.key)
		} else {
			l.Skins = append(l.Skins, k.key)
		}
	}
	colors, err := mapKeys(&f.HairColors, "hair_colors")
	if err != nil {
		return nil, err
	}
	for _, k := range colors {
		l.HairColors = append(l.HairColors, k.key)
	}
	for t := range f.Tints {
		l.Tints[t] = true
	}
	if err := l.check(); err != nil {
		return nil, err
	}
	return l, nil
}

type keyed struct {
	key   string
	value *yaml.Node
}

// mapKeys returns the entries of a mapping node in file order (none for an absent one).
func mapKeys(n *yaml.Node, name string) ([]keyed, error) {
	if n.Kind == 0 {
		return nil, nil
	}
	if n.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("looks: %s must be a map", name)
	}
	out := make([]keyed, 0, len(n.Content)/2)
	for i := 0; i+1 < len(n.Content); i += 2 {
		out = append(out, keyed{key: n.Content[i].Value, value: n.Content[i+1]})
	}
	return out, nil
}

func (l *Looks) check() error {
	for name, list := range map[string][]string{
		"sexes": l.Sexes, "builds": l.Builds, "skins": l.Skins, "hair_styles": l.HairStyles,
		"beards": l.Beards, "hair_colors": l.HairColors,
	} {
		if len(list) == 0 {
			return fmt.Errorf("looks: no %s a player can choose", name)
		}
	}
	if l.Limits.ChangeBurst < 1 || l.Limits.ChangeRefillMs < 1 {
		return fmt.Errorf("looks: limits.change_burst and limits.change_refill_ms must be positive")
	}
	return nil
}

// PlayerLook reports whether a player may wear look: every id one of the choices (never a
// creatures_only skin).
func (l *Looks) PlayerLook(look Look) bool {
	return slices.Contains(l.Sexes, look.Sex) &&
		slices.Contains(l.Builds, look.Body) && slices.Contains(l.Skins, look.Skin) &&
		slices.Contains(l.HairStyles, look.Hair) && slices.Contains(l.HairColors, look.HairColor) &&
		slices.Contains(l.Beards, look.Beard)
}

// CheckCreature checks the look of an NPC or a monster: its body (any skin) and every
// piece it wears, a shape of its slot and a known tint.
func (l *Looks) CheckCreature(c CreatureLook) error {
	skin := slices.Contains(l.Skins, c.Skin) || slices.Contains(l.CreatureSkins, c.Skin)
	if !slices.Contains(l.Sexes, c.Sex) || !slices.Contains(l.Builds, c.Body) || !skin || !slices.Contains(l.HairStyles, c.Hair) ||
		!slices.Contains(l.HairColors, c.HairColor) || !slices.Contains(l.Beards, c.Beard) {
		return fmt.Errorf("look %+v: an id that is not in data/looks.yaml", c.Look)
	}
	for slot, p := range c.Worn {
		if !slices.Contains(WornSlots, slot) {
			return fmt.Errorf("look: worn slot %q", slot)
		}
		if !slices.Contains(l.Shapes[slot], p.Shape) || !l.Tints[p.Tint] {
			return fmt.Errorf("look: worn %s %+v is not in data/looks.yaml", slot, p)
		}
	}
	return nil
}

// DefaultLook is the look of a character that has none (created before looks existed, or
// whose saved look left data/looks.yaml): a choice of every list picked from the
// character's id, always the same for the same id and lists. It is saved with the
// character's next snapshot, so a later change of the lists does not change it. The sex
// came later (migration 00022) and is picked last, from what is left of the hash: the
// other fields are picked as they were before it, so no existing default changed.
func (l *Looks) DefaultLook(id int64) Look {
	h := mix64(uint64(id))
	pick := func(list []string) string {
		n := uint64(len(list))
		v := list[h%n]
		h /= n
		return v
	}
	look := Look{
		Body: pick(l.Builds), Skin: pick(l.Skins), Hair: pick(l.HairStyles),
		HairColor: pick(l.HairColors), Beard: pick(l.Beards),
	}
	look.Sex = pick(l.Sexes)
	return look
}

// SavedLook is the look of a character at login from the one saved (characters.look_*):
// the saved one if a player may wear it; a saved look whose only fault is its sex (empty:
// every character saved before migration 00022, or a sex that left data/looks.yaml) keeps
// its other fields and takes the sex DefaultLook picks from the id; anything else is
// DefaultLook.
func (l *Looks) SavedLook(id int64, saved Look) Look {
	if l.PlayerLook(saved) {
		return saved
	}
	def := l.DefaultLook(id)
	withSex := saved
	withSex.Sex = def.Sex
	if l.PlayerLook(withSex) {
		return withSex
	}
	return def
}

// mix64 is splitmix64's finalizer: neighbouring ids get unrelated looks.
func mix64(x uint64) uint64 {
	x += 0x9e3779b97f4a7c15
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9
	x = (x ^ (x >> 27)) * 0x94d049bb133111eb
	return x ^ (x >> 31)
}
