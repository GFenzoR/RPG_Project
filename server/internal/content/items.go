package content

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"go.yaml.in/yaml/v3"
)

// Item is the part of a data/items/*.yaml entry the server uses: combat numbers (T1.6),
// and weight, stacking, equipment, containers and consumables (T1.8).
type Item struct {
	ID          string `yaml:"id"`
	Kind        string `yaml:"kind"`
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	// Weight is in grams.
	Weight    int  `yaml:"weight"`
	Stackable bool `yaml:"stackable"`
	MaxStack  int  `yaml:"max_stack"`
	Tradeable bool `yaml:"tradeable"`
	// Pickupable is false for items that never leave their tile (nil = true).
	Pickupable *bool `yaml:"pickupable"`
	// MarketBoard: using this map item opens the global market (T5.3).
	MarketBoard bool `yaml:"market_board"`
	// BlocksMove and BlocksView are blocks_movement and blocks_sight as written (nil =
	// the default of the kind); BlocksMovement and BlocksSight apply the rule.
	BlocksMove *bool `yaml:"blocks_movement"`
	BlocksView *bool `yaml:"blocks_sight"`
	// Ground is set on ground items: whether creatures can stand on them.
	Ground *struct {
		Walkable bool `yaml:"walkable"`
	} `yaml:"ground"`
	// Key is the key id this item opens (keys): the door.key of the doors it unlocks.
	Key string `yaml:"key"`
	// Door makes a map item a door that opens and closes (docs/02 "Puertas con llave").
	Door *Door `yaml:"door"`
	// Portal makes a map item the look of a portal of portals.yaml (docs/03): the item
	// moves nobody, but every portal (but a boat) should stand under one that shows it.
	Portal *PortalLook `yaml:"portal"`
	Value  int         `yaml:"value"`
	Weapon *struct {
		// Type is the skill the weapon trains and uses (sword, axe, club...).
		Type    string `yaml:"type"`
		Attack  int    `yaml:"attack"`
		Defense int    `yaml:"defense"`
		Hands   int    `yaml:"hands"`
		// Range is how far a wand (T1.9) or distance weapon (T3.1) hits; Element is a
		// wand's.
		Range   int    `yaml:"range"`
		Element string `yaml:"element"`
		// Ammo is the ammo.type a distance weapon shoots, one per shot (T3.1).
		Ammo string `yaml:"ammo"`
	} `yaml:"weapon"`
	// Ammo goes in the ammo slot and adds Attack to a weapon that shoots Type (T3.1).
	Ammo *struct {
		Type   string `yaml:"type"`
		Attack int    `yaml:"attack"`
	} `yaml:"ammo"`
	Armor *struct {
		Slot  string `yaml:"slot"`
		Armor int    `yaml:"armor"`
	} `yaml:"armor"`
	Shield *struct {
		Defense int `yaml:"defense"`
	} `yaml:"shield"`
	Container *struct {
		Slots int `yaml:"slots"`
	} `yaml:"container"`
	Consumable *struct {
		HealHP int `yaml:"heal_hp"`
		HealMP int `yaml:"heal_mp"`
		FoodMs int `yaml:"food_ms"`
	} `yaml:"consumable"`
	// Rune casts Spell's effect (no mana, no words) and spends a charge per use (T1.9).
	Rune *struct {
		Spell      string `yaml:"spell"`
		Charges    int    `yaml:"charges"`
		MagicLevel int    `yaml:"magic_level"`
	} `yaml:"rune"`
	// Tool is what a tool is used for (fishing, mining...); Resource marks a gathering
	// spot those tools harvest (T1.12).
	Tool *struct {
		Use string `yaml:"use"`
	} `yaml:"tool"`
	Resource *Resource `yaml:"resource"`
	// Currency marks money: Worth is the value of one unit in the smallest coin.
	Currency *struct {
		Worth int64 `yaml:"worth"`
	} `yaml:"currency"`
	Requires struct {
		Level     int      `yaml:"level"`
		Vocations []string `yaml:"vocations"`
	} `yaml:"requires"`
	// Retired: out of the equipment catalog (lote 11), kept so the characters that own one
	// keep it; make validate refuses every source of it. No game rule reads it.
	Retired bool `yaml:"retired"`
	// Book makes an item readable: the client opens its reading window from the texts it
	// has (docs/02 "Libros y cofres"); the server only uses its description on Look.
	Book *Book `yaml:"book"`
	// Chest makes a map item a reward chest: once per character (chests.go, session/chest.go).
	Chest *Chest `yaml:"chest"`
	// Numeric is the stable numeric id from data/ids.lock.yaml.
	Numeric uint16 `yaml:"-"`
}

// PortalLook is the portal block of an item: the kind of portals.yaml it shows and, if
// set, the way it leads ("up" or "down" a floor).
type PortalLook struct {
	Kind  string `yaml:"kind"`
	Leads string `yaml:"leads"`
}

// Shows reports whether the look fits a portal of kind leading from floor fromZ to floor
// toZ (z grows going down): the same kind and, if the look says one, the same way.
func (l *PortalLook) Shows(kind string, fromZ, toZ uint8) bool {
	switch {
	case l == nil || l.Kind != kind:
		return false
	case l.Leads == "down":
		return toZ > fromZ
	case l.Leads == "up":
		return toZ < fromZ
	}
	return true
}

// CanPickUp reports whether the item can be moved off its tile.
func (it *Item) CanPickUp() bool { return it.Pickupable == nil || *it.Pickupable }

// StackLimit is the largest stack of the item (1 if it does not stack). A rune does not
// stack: its count is its charges, up to rune.charges.
func (it *Item) StackLimit() int {
	if it.Rune != nil && !it.Stackable {
		return max(it.Rune.Charges, 1)
	}
	if !it.Stackable {
		return 1
	}
	if it.MaxStack > 0 {
		return it.MaxStack
	}
	return 100
}

// Slots is the capacity of a container item (0 if it is not one).
func (it *Item) Slots() int {
	if it.Container == nil {
		return 0
	}
	return it.Container.Slots
}

// Items maps item id to its definition.
type Items map[string]*Item

// ByNumeric indexes items by their numeric id.
func (is Items) ByNumeric() map[uint16]*Item {
	out := make(map[uint16]*Item, len(is))
	for _, it := range is {
		out[it.Numeric] = it
	}
	return out
}

// check verifies what the server needs of an item beyond its schema: a weapon's range
// within MaxRange (0 = melee), a book's title and its 1 to MaxBookPages pages.
func (it *Item) check() error {
	if wp := it.Weapon; wp != nil && (wp.Range < 0 || wp.Range > MaxRange) {
		return fmt.Errorf("weapon range must be 0 to %d", MaxRange)
	}
	if b := it.Book; b != nil && (b.Title == "" || len(b.Pages) == 0 || slices.Contains(b.Pages, "")) {
		return errors.New("a book needs a title and at least one page")
	}
	if b := it.Book; b != nil && len(b.Pages) > MaxBookPages {
		return fmt.Errorf("a book has at most %d pages, not %d", MaxBookPages, len(b.Pages))
	}
	return nil
}

// LoadItems reads <dataDir>/items/*.yaml and the numeric ids of <dataDir>/ids.lock.yaml.
// Every item must have a numeric id (make gen-ids) and pass check.
func LoadItems(dataDir string) (Items, error) {
	files, err := filepath.Glob(filepath.Join(dataDir, "items", "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("list items: %w", err)
	}
	var lock struct {
		Items map[string]int `yaml:"items"`
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "ids.lock.yaml"))
	if err != nil {
		return nil, fmt.Errorf("read ids.lock: %w", err)
	}
	if err := yaml.Unmarshal(raw, &lock); err != nil {
		return nil, fmt.Errorf("decode ids.lock: %w", err)
	}
	items := Items{}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("read items: %w", err)
		}
		var list []*Item
		if err := yaml.Unmarshal(raw, &list); err != nil {
			return nil, fmt.Errorf("%s: decode items: %w", f, err)
		}
		for _, it := range list {
			if _, dup := items[it.ID]; dup || it.ID == "" {
				return nil, fmt.Errorf("%s: missing or duplicate item id %q", f, it.ID)
			}
			n, ok := lock.Items[it.ID]
			if !ok || n <= 0 || n > 0xFFFF {
				return nil, fmt.Errorf("%s: item %q has no numeric id in ids.lock.yaml (make gen-ids)", f, it.ID)
			}
			if err := it.check(); err != nil {
				return nil, fmt.Errorf("%s: item %q: %w", f, it.ID, err)
			}
			it.Numeric = uint16(n)
			items[it.ID] = it
		}
	}
	// The forge's protection is balance.yaml's: session.initChests checks that one too.
	if err := CheckChests(items, ""); err != nil {
		return nil, err
	}
	return items, nil
}
