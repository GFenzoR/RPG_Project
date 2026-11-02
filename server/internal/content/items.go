package content

import (
	"fmt"
	"os"
	"path/filepath"

	"go.yaml.in/yaml/v3"
)

// Item is the part of a data/items/*.yaml entry the server uses so far (T1.6: combat
// numbers, value and the numeric id). Items, inventory and containers arrive in T1.8.
type Item struct {
	ID        string `yaml:"id"`
	Kind      string `yaml:"kind"`
	Stackable bool   `yaml:"stackable"`
	Value     int    `yaml:"value"`
	Weapon    *struct {
		// Type is the skill the weapon trains and uses (sword, axe, club...).
		Type    string `yaml:"type"`
		Attack  int    `yaml:"attack"`
		Defense int    `yaml:"defense"`
	} `yaml:"weapon"`
	Armor *struct {
		Armor int `yaml:"armor"`
	} `yaml:"armor"`
	Shield *struct {
		Defense int `yaml:"defense"`
	} `yaml:"shield"`
	// Numeric is the stable numeric id from data/ids.lock.yaml.
	Numeric uint16 `yaml:"-"`
}

// Items maps item id to its definition.
type Items map[string]*Item

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
