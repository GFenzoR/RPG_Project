package content

import "errors"

// Houses holds the player house rules (T5.4, docs/02-game-design.md "Casas"). The zero
// value (no houses block, or enabled: false) turns houses off. The houses themselves
// (tiles, doors, rent) are map data: world/islands/<id>/houses.yaml.
type Houses struct {
	Enabled bool `yaml:"enabled"`
	// MinLevel is the level a character needs to rent or receive a house.
	MinLevel int `yaml:"min_level"`
	// PeriodDays is the length of one rent period, paid in advance.
	PeriodDays int `yaml:"period_days"`
	// MaxPeriods is how many periods may be paid ahead (renting pays the first one).
	MaxPeriods int `yaml:"max_periods"`
	// MaxGuests bounds the guest list of one house.
	MaxGuests int `yaml:"max_guests"`
	// ItemsPerTile × the house's tiles is how many item instances it may hold (a
	// stack counts once, a container once plus each item inside it).
	ItemsPerTile int `yaml:"items_per_tile"`
	// TransferMinutes: a transfer offer waits this long for the other character.
	TransferMinutes int `yaml:"transfer_minutes"`
	// Anti-flood of the house actions and of the item moves inside houses (each move
	// writes the house and the mover): a burst of ActionBurst, then one every
	// ActionRefillMs.
	ActionBurst    int `yaml:"action_burst"`
	ActionRefillMs int `yaml:"action_refill_ms"`
	// InactiveDays (content audit M6): a house whose owner's account has not been in the
	// game for this many days is not renewed from the mailbox when its rent runs out: it
	// is released (its items go to the mailbox). 0 turns the rule off.
	InactiveDays int `yaml:"inactive_days"`
}

func (h Houses) check() error {
	if !h.Enabled {
		return nil
	}
	if h.MinLevel < 1 || h.PeriodDays < 1 || h.PeriodDays > 90 || h.MaxPeriods < 1 || h.MaxPeriods > 12 {
		return errors.New("houses: min_level >= 1, period_days in 1..90, max_periods in 1..12")
	}
	if h.MaxGuests < 0 || h.MaxGuests > 100 || h.ItemsPerTile < 1 || h.ItemsPerTile > 50 ||
		h.TransferMinutes < 1 || h.TransferMinutes > 120 {
		return errors.New("houses: max_guests in 0..100, items_per_tile in 1..50, transfer_minutes in 1..120")
	}
	if h.ActionBurst < 1 || h.ActionRefillMs < 1 || h.ActionRefillMs > 60_000 {
		return errors.New("houses: action_burst >= 1 and action_refill_ms in 1..60000")
	}
	if h.InactiveDays < 0 || h.InactiveDays > 365 {
		return errors.New("houses: inactive_days in 0..365")
	}
	return nil
}
