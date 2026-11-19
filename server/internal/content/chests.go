package content

import (
	"fmt"
	"sort"
)

// Book is the book block of a readable item (docs/02 "Libros y cofres"): the i18n keys of
// its title and its pages. The client shows them in its reading window from the texts it
// already has; the server never sends them (a Look gives the item's description).
type Book struct {
	Title string   `yaml:"title"`
	Pages []string `yaml:"pages"`
}

// Chest is the chest block of a map item (docs/02 "Libros y cofres"): a reward chest that
// gives its rewards once per character, remembered in the character's storage under
// ChestKey(ID). Using it again, or with no room for all of them, gives nothing.
type Chest struct {
	ID      string        `yaml:"id"`
	Rewards []ChestReward `yaml:"rewards"`
}

// ChestReward is count units of item.
type ChestReward struct {
	Item  string `yaml:"item"`
	Count int    `yaml:"count"`
}

// ChestKey is the storage key of a chest the character opened.
func ChestKey(id string) string { return "chest." + id }

// CheckChests checks the reward chests of items: each one is a map item nobody picks up,
// its chest id is unique, it gives something, and every reward is an item that exists, is
// not retired (lote 11), is not the forge's protection (the warding amber: only monsters
// drop it, docs/02 "Forja"; "" skips that rule) and comes in a count from 1 to one stack
// (a rune or an equipable: 1). make validate checks the same (packages/content-schema,
// checkChests). Errors name items in id order.
func CheckChests(items Items, protection string) error {
	ids := make([]string, 0, len(items))
	for id, it := range items {
		if it.Chest != nil {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	seen := map[string]string{}
	for _, id := range ids {
		c := items[id].Chest
		switch {
		case items[id].CanPickUp():
			return fmt.Errorf("item %q: a chest needs pickupable: false", id)
		case c.ID == "":
			return fmt.Errorf("item %q: chest needs an id", id)
		case seen[c.ID] != "":
			return fmt.Errorf("item %q: chest id %q is also the one of %q", id, c.ID, seen[c.ID])
		case len(c.Rewards) == 0:
			return fmt.Errorf("item %q: chest %q gives nothing", id, c.ID)
		}
		seen[c.ID] = id
		for _, r := range c.Rewards {
			def := items[r.Item]
			switch {
			case def == nil:
				return fmt.Errorf("item %q: chest reward %q is not an item", id, r.Item)
			case def.Retired:
				return fmt.Errorf("item %q: chest reward %q is retired", id, r.Item)
			case protection != "" && r.Item == protection:
				return fmt.Errorf("item %q: chest reward %q is the forge's protection: only monsters drop it", id, r.Item)
			case r.Count < 1 || r.Count > def.StackLimit() || !def.Stackable && r.Count != 1:
				return fmt.Errorf("item %q: chest reward %q: count %d must be 1 to one stack (%d)", id, r.Item, r.Count,
					max(def.StackLimit(), 1))
			}
		}
	}
	return nil
}
