package content

import (
	"fmt"
	"os"
	"path/filepath"

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
	Value      int   `yaml:"value"`
	Weapon     *struct {
		// Type is the skill the weapon trains and uses (sword, axe, club...).
		Type    string `yaml:"type"`
		Attack  int    `yaml:"attack"`
		Defense int    `yaml:"defense"`
		Hands   int    `yaml:"hands"`
	} `yaml:"weapon"`
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
	Requires struct {
		Level     int      `yaml:"level"`
		Vocations []string `yaml:"vocations"`
	} `yaml:"requires"`
	// Numeric is the stable numeric id from data/ids.lock.yaml.
	Numeric uint16 `yaml:"-"`
}

// CanPickUp reports whether the item can be moved off its tile.
func (it *Item) CanPickUp() bool { return it.Pickupable == nil || *it.Pickupable }

// StackLimit is the largest stack of the item (1 if it does not stack).
func (it *Item) StackLimit() int {
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

// LoadItems reads <dataDir>/items/*.yaml and the numeric ids of <dataDir>/ids.lock.yaml.
// Every item must have a numeric id (make gen-ids).
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
			it.Numeric = uint16(n)
			items[it.ID] = it
		}
	}
	return items, nil
}
