package livingworld

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Ways an object can be broken (breakable.by in data/livingworld/*.yaml).
const (
	// ByMelee: a melee strike (any melee weapon, or bare hands) from a tile next to it.
	ByMelee = "melee"
	// ByAnyAttack: a melee strike, or a shot of a distance weapon or wand within its range.
	ByAnyAttack = "any_attack"
	// ByAxe: an axe (a woodcutting tool, or a weapon of type axe) used on it.
	ByAxe = "tool:axe"
	// ByPick: a pickaxe (a mining tool) used on it.
	ByPick = "tool:pick"
	// ByFire: fire: an area spell or rune of the fire element over its tile, or a fire wand.
	ByFire = "fire"
)

// Methods lists every breakable.by value, in documentation order.
var Methods = []string{ByMelee, ByAnyAttack, ByAxe, ByPick, ByFire}

// Effects lists the effect keys an object may name: the material the client's hit and
// break particles imitate (livingworld/client effects.ts).
var Effects = []string{"wood", "stone", "plant", "web", "clay"}

// None is the breakable.becomes value of an object that leaves no debris.
const None = "none"

// Limits of the data, so a typo cannot make the loop keep an object for days or roll a
// huge loot table.
const (
	MaxHP           = 10000
	MaxSeconds      = 86400
	MaxLootEntries  = 8
	MaxPlateRadius  = 16
	DefaultDebrisS  = 20
	DefaultRespawnS = 300
)

// Def is one entry of data/livingworld/*.yaml: an item of data/items with exactly one
// living-world behaviour.
type Def struct {
	// Item is the data/items id of the object (the intact or closed look).
	Item      string     `yaml:"item"`
	Breakable *Breakable `yaml:"breakable"`
	Pushable  *Pushable  `yaml:"pushable"`
	Gate      *Gate      `yaml:"gate"`
	Plate     *Plate     `yaml:"plate"`
}

// Breakable makes an object take hits until it breaks.
type Breakable struct {
	HP int      `yaml:"hp"`
	By []string `yaml:"by"`
	// Becomes is the item of its debris (walkable), or "none".
	Becomes string `yaml:"becomes"`
	// DebrisSeconds is how long the debris lies before it fades (0 = DefaultDebrisS).
	DebrisSeconds int `yaml:"debris_seconds"`
	// RespawnSeconds is how long after it broke the object stands again (0 =
	// DefaultRespawnS), once no creature nor loose item is on its tile.
	RespawnSeconds int         `yaml:"respawn_seconds"`
	Loot           []LootEntry `yaml:"loot"`
	// Effect is the material of its particles (Effects); Sound the sounds.yaml id
	// played when it breaks, HitSound when it takes a hit (empty: none).
	Effect   string `yaml:"effect"`
	Sound    string `yaml:"sound"`
	HitSound string `yaml:"hit_sound"`
}

// LootEntry is one possible drop of a broken object: the shape of a monster's loot entry
// (data/monsters), rolled the same way.
type LootEntry struct {
	Item   string  `yaml:"item"`
	Chance float64 `yaml:"chance"`
	Count  []int   `yaml:"count"`
}

// CountRange returns the entry's [min, max] amount.
func (l LootEntry) CountRange() (lo, hi int) {
	if len(l.Count) == 2 {
		return l.Count[0], l.Count[1]
	}
	return 1, 1
}

// Pushable makes an object move one tile when a player pushes it.
type Pushable struct {
	// ResetSeconds: that long after its last push it goes back where the map put it, once
	// that tile is free (0 = never). Puzzles reset for the next player.
	ResetSeconds int    `yaml:"reset_seconds"`
	Sound        string `yaml:"sound"`
	Effect       string `yaml:"effect"`
}

// Gate is an object that opens while every pressure plate linked to it is pressed.
type Gate struct {
	// Open is the item of the open gate (walkable).
	Open  string `yaml:"open"`
	Sound string `yaml:"sound"`
}

// Plate is a pressure plate: a map item a creature or a pushable object presses.
type Plate struct {
	// Radius links it to every gate within that many tiles (Chebyshev) on its floor.
	Radius int `yaml:"radius"`
}

// Defs is every entry of data/livingworld, in file order.
type Defs []*Def

// LoadDir reads every <dir>/*.yaml (sorted by name). A missing dir is no error: no
// living-world objects.
func LoadDir(dir string) (Defs, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("livingworld: %w", err)
	}
	var all Defs
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, fmt.Errorf("livingworld: %w", err)
		}
		defs, err := Parse(b)
		if err != nil {
			return nil, fmt.Errorf("livingworld: %s: %w", e.Name(), err)
		}
		all = append(all, defs...)
	}
	return all, nil
}

// Parse reads one data/livingworld file (a YAML list of Def).
func Parse(b []byte) (Defs, error) {
	var defs Defs
	if err := yaml.Unmarshal(b, &defs); err != nil {
		return nil, err
	}
	return defs, nil
}

// ItemInfo is what the module needs to know of a data/items item.
type ItemInfo struct {
	// Num is its numeric id (data/ids.lock.yaml).
	Num uint16
	// Kind is its data/items kind; BlocksMove and BlocksSight its blocking rule.
	Kind        string
	BlocksMove  bool
	BlocksSight bool
	// Door: it is a door (a door block); walls, doors and grounds are never objects.
	Door bool
}

// ItemLookup resolves a data/items id.
type ItemLookup func(id string) (ItemInfo, bool)

// SoundLookup reports whether a sounds.yaml id exists (nil: every id is accepted).
type SoundLookup func(id string) bool

// Catalog is Defs checked and resolved to numeric ids.
type Catalog struct {
	byNum  map[uint16]*kind
	plates map[uint16]*Def
	// Loot items, resolved (glue creates them).
	defs Defs
}

// kind is one resolved object definition.
type kind struct {
	def *Def
	// num is the intact/closed item, alt the debris or the open gate (0: none).
	num, alt     uint16
	move, sight  bool // what num blocks
	altMove      bool // what alt blocks
	altSight     bool
	debris       uint64 // ticks
	respawn      uint64 // ticks
	reset        uint64 // ticks
	methodsAllow map[string]bool
}

// Resolve checks defs against the items (and sounds) and builds a Catalog; tps is the
// number of game ticks per second (seconds of the data become ticks).
func Resolve(defs Defs, items ItemLookup, sounds SoundLookup, tps uint64) (*Catalog, error) {
	if tps == 0 {
		return nil, errors.New("livingworld: ticks per second must be positive")
	}
	c := &Catalog{byNum: map[uint16]*kind{}, plates: map[uint16]*Def{}, defs: defs}
	seen := map[string]bool{}
	for i, d := range defs {
		if err := checkDef(d, items, sounds); err != nil {
			return nil, fmt.Errorf("livingworld: entry %d (%q): %w", i, d.Item, err)
		}
		if seen[d.Item] {
			return nil, fmt.Errorf("livingworld: item %q has two entries", d.Item)
		}
		seen[d.Item] = true
		info, _ := items(d.Item)
		if d.Plate != nil {
			c.plates[info.Num] = d
			continue
		}
		k := &kind{def: d, num: info.Num, move: info.BlocksMove, sight: info.BlocksSight}
		switch {
		case d.Breakable != nil:
			b := d.Breakable
			if b.Becomes != None {
				alt, _ := items(b.Becomes)
				k.alt, k.altMove, k.altSight = alt.Num, alt.BlocksMove, alt.BlocksSight
			}
			k.debris = uint64(orDefault(b.DebrisSeconds, DefaultDebrisS)) * tps
			k.respawn = uint64(orDefault(b.RespawnSeconds, DefaultRespawnS)) * tps
			k.methodsAllow = map[string]bool{}
			for _, m := range b.By {
				k.methodsAllow[m] = true
			}
		case d.Pushable != nil:
			k.reset = uint64(d.Pushable.ResetSeconds) * tps
		case d.Gate != nil:
			alt, _ := items(d.Gate.Open)
			k.alt, k.altMove, k.altSight = alt.Num, alt.BlocksMove, alt.BlocksSight
		}
		c.byNum[info.Num] = k
	}
	return c, nil
}

func orDefault(v, d int) int {
	if v <= 0 {
		return d
	}
	return v
}

// checkDef applies the rules of livingworld.schema.json that the server needs too: one
// behaviour, known items, never a wall, a door or a ground.
func checkDef(d *Def, items ItemLookup, sounds SoundLookup) error {
	n := 0
	for _, set := range []bool{d.Breakable != nil, d.Pushable != nil, d.Gate != nil, d.Plate != nil} {
		if set {
			n++
		}
	}
	if n != 1 {
		return errors.New("needs exactly one of breakable, pushable, gate or plate")
	}
	info, ok := items(d.Item)
	if !ok {
		return fmt.Errorf("item %q is not in data/items", d.Item)
	}
	if err := notStructure(d.Item, info); err != nil {
		return err
	}
	sound := func(id string) error {
		if id != "" && sounds != nil && !sounds(id) {
			return fmt.Errorf("sound %q is not in assets/sounds.yaml", id)
		}
		return nil
	}
	effect := func(e string) error {
		if e != "" && !slices.Contains(Effects, e) {
			return fmt.Errorf("effect %q is not one of %v", e, Effects)
		}
		return nil
	}
	switch {
	case d.Breakable != nil:
		b := d.Breakable
		if b.HP <= 0 || b.HP > MaxHP {
			return fmt.Errorf("breakable.hp %d is not in 1..%d", b.HP, MaxHP)
		}
		if len(b.By) == 0 {
			return errors.New("breakable.by is empty")
		}
		for _, m := range b.By {
			if !slices.Contains(Methods, m) {
				return fmt.Errorf("breakable.by %q is not one of %v", m, Methods)
			}
		}
		if !info.BlocksMove {
			return errors.New("a breakable object must block movement (it is broken to pass)")
		}
		if b.Becomes == "" {
			return errors.New(`breakable.becomes is required (an item, or "none")`)
		}
		if b.Becomes != None {
			alt, ok := items(b.Becomes)
			if !ok {
				return fmt.Errorf("breakable.becomes %q is not in data/items", b.Becomes)
			}
			if alt.BlocksMove {
				return fmt.Errorf("breakable.becomes %q blocks movement: debris must be walkable", b.Becomes)
			}
			if err := notStructure(b.Becomes, alt); err != nil {
				return err
			}
		}
		if b.DebrisSeconds < 0 || b.DebrisSeconds > MaxSeconds || b.RespawnSeconds < 0 || b.RespawnSeconds > MaxSeconds {
			return fmt.Errorf("breakable seconds must be in 0..%d", MaxSeconds)
		}
		if b.Becomes != None && orDefault(b.DebrisSeconds, DefaultDebrisS) > orDefault(b.RespawnSeconds, DefaultRespawnS) {
			return errors.New("breakable.debris_seconds is longer than respawn_seconds")
		}
		if len(b.Loot) > MaxLootEntries {
			return fmt.Errorf("breakable.loot has more than %d entries", MaxLootEntries)
		}
		for _, l := range b.Loot {
			if _, ok := items(l.Item); !ok {
				return fmt.Errorf("loot item %q is not in data/items", l.Item)
			}
			if l.Chance <= 0 || l.Chance > 1 {
				return fmt.Errorf("loot %q: chance %v is not in (0, 1]", l.Item, l.Chance)
			}
			if lo, hi := l.CountRange(); len(l.Count) != 0 && (len(l.Count) != 2 || lo < 1 || hi < lo || hi > 100) {
				return fmt.Errorf("loot %q: count must be [min, max] with 1 <= min <= max <= 100", l.Item)
			}
		}
		if err := effect(b.Effect); err != nil {
			return err
		}
		if err := sound(b.Sound); err != nil {
			return err
		}
		return sound(b.HitSound)
	case d.Pushable != nil:
		if !info.BlocksMove {
			return errors.New("a pushable object must block movement")
		}
		if d.Pushable.ResetSeconds < 0 || d.Pushable.ResetSeconds > MaxSeconds {
			return fmt.Errorf("pushable.reset_seconds must be in 0..%d", MaxSeconds)
		}
		if err := effect(d.Pushable.Effect); err != nil {
			return err
		}
		return sound(d.Pushable.Sound)
	case d.Gate != nil:
		if !info.BlocksMove {
			return errors.New("a closed gate must block movement")
		}
		alt, ok := items(d.Gate.Open)
		if !ok {
			return fmt.Errorf("gate.open %q is not in data/items", d.Gate.Open)
		}
		if alt.BlocksMove {
			return fmt.Errorf("gate.open %q blocks movement: an open gate must be walkable", d.Gate.Open)
		}
		if err := notStructure(d.Gate.Open, alt); err != nil {
			return err
		}
		return sound(d.Gate.Sound)
	default:
		if info.BlocksMove {
			return errors.New("a pressure plate must be walkable")
		}
		if d.Plate.Radius < 1 || d.Plate.Radius > MaxPlateRadius {
			return fmt.Errorf("plate.radius must be in 1..%d", MaxPlateRadius)
		}
	}
	return nil
}

// notStructure refuses walls, doors and grounds: they never break nor move.
func notStructure(id string, info ItemInfo) error {
	switch {
	case info.Kind == "wall":
		return fmt.Errorf("%q is a wall: walls never break nor move", id)
	case info.Door:
		return fmt.Errorf("%q is a door: doors never break nor move", id)
	case info.Kind == "ground":
		return fmt.Errorf("%q is a ground", id)
	}
	return nil
}

// IsObject reports whether num is the item of a living object (it leaves the map's own
// stack and the module owns it); IsPlate whether it is a pressure plate (it stays on the
// map; the module only watches it).
func (c *Catalog) IsObject(num uint16) bool { return c.byNum[num] != nil }

// IsPlate reports whether num is a pressure plate item.
func (c *Catalog) IsPlate(num uint16) bool { return c.plates[num] != nil }

// Len is the number of object kinds (plates not counted).
func (c *Catalog) Len() int { return len(c.byNum) }

// LootItems returns every item id a loot table of the catalog names (glue checks them).
func (c *Catalog) LootItems() []string {
	var ids []string
	for _, d := range c.defs {
		if d.Breakable == nil {
			continue
		}
		for _, l := range d.Breakable.Loot {
			if !slices.Contains(ids, l.Item) {
				ids = append(ids, l.Item)
			}
		}
	}
	return ids
}
