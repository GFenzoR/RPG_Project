package content

import (
	"fmt"
	"sort"
)

// Door is the door block of a map item (docs/02-game-design.md, "Puertas con llave").
// A door is a pair of items: the closed one names the item it becomes when opened (Open)
// and, when it is locked, the key id that opens it (Key); the open one names the closed
// item it becomes when closed (Closed). Exactly one of Open and Closed is set.
type Door struct {
	Key    string `yaml:"key"`
	Open   string `yaml:"open"`
	Closed string `yaml:"closed"`
}

// BlocksMovement reports whether the item blocks walking on its tile: blocks_movement,
// or true for kind: wall when it does not say (the rule of world/compile and docs/03).
func (it *Item) BlocksMovement() bool {
	if it.BlocksMove != nil {
		return *it.BlocksMove
	}
	return it.Kind == "wall"
}

// BlocksSight reports whether the item blocks line of sight: blocks_sight, or true for
// kind: wall when it does not say.
func (it *Item) BlocksSight() bool {
	if it.BlocksView != nil {
		return *it.BlocksView
	}
	return it.Kind == "wall"
}

// Walkable reports whether the item is a ground creatures can stand on.
func (it *Item) Walkable() bool { return it.Ground != nil && it.Ground.Walkable }

// CheckDoors checks the doors and keys of items: each door pairs with exactly one other
// door that points back, the closed one blocks movement and the open one does not,
// neither can be picked up, only the closed one is locked, a lock has at least one key
// that opens it, and no door is a key. Errors name items in id order.
func CheckDoors(items Items) error {
	ids := make([]string, 0, len(items))
	keys := map[string]bool{}
	for id, it := range items {
		ids = append(ids, id)
		if it.Key != "" {
			keys[it.Key] = true
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		it := items[id]
		if it.Key != "" && it.Door != nil {
			return fmt.Errorf("item %q: a door cannot be a key", id)
		}
		d := it.Door
		if d == nil {
			continue
		}
		if (d.Open == "") == (d.Closed == "") {
			return fmt.Errorf("item %q: door needs exactly one of open and closed", id)
		}
		if it.CanPickUp() {
			return fmt.Errorf("item %q: a door needs pickupable: false", id)
		}
		if d.Closed != "" {
			pair := items[d.Closed]
			switch {
			case d.Key != "":
				return fmt.Errorf("item %q: only the closed door of a pair has a key", id)
			case pair == nil || pair.Door == nil || pair.Door.Open != id:
				return fmt.Errorf("item %q: door.closed %q is not a closed door that opens into it", id, d.Closed)
			case it.BlocksMovement():
				return fmt.Errorf("item %q: an open door cannot block movement", id)
			}
			continue
		}
		pair := items[d.Open]
		switch {
		case pair == nil || pair.Door == nil || pair.Door.Closed != id:
			return fmt.Errorf("item %q: door.open %q is not an open door that closes into it", id, d.Open)
		case !it.BlocksMovement():
			return fmt.Errorf("item %q: a closed door needs blocks_movement: true", id)
		case d.Key != "" && !keys[d.Key]:
			return fmt.Errorf("item %q: no item has key %q, so nothing opens it", id, d.Key)
		}
	}
	return nil
}
