package content

import "errors"

// Market holds the global market rules (T5.3, docs/02-game-design.md "Economía"). The
// zero value (no market block, or enabled: false) turns the market off.
type Market struct {
	Enabled bool `yaml:"enabled"`
	// FeePermille is the fee to post an offer, in thousandths of its total value
	// (amount × unit price), clamped to FeeMin..FeeMax. It is destroyed (a gold sink).
	FeePermille int   `yaml:"fee_permille"`
	FeeMin      int64 `yaml:"fee_min"`
	FeeMax      int64 `yaml:"fee_max"`
	// MaxOffers is how many active offers one character may have.
	MaxOffers int `yaml:"max_offers"`
	// MaxAmount bounds the units of one offer; MaxPrice the unit price (smallest coin).
	MaxAmount int   `yaml:"max_amount"`
	MaxPrice  int64 `yaml:"max_price"`
	// DurationsHours are the durations a player may choose for an offer.
	DurationsHours []int `yaml:"durations_hours"`
	// ListSize is how many offers per side a search shows (best prices first).
	ListSize int `yaml:"list_size"`
	// HistorySize is how many of its own operations a character sees (newest first).
	HistorySize int `yaml:"history_size"`
	// ReferenceDays is the window of the reference price (average of the trades).
	ReferenceDays int `yaml:"reference_days"`
	// MailboxShown bounds the mailbox items sent at once (the rest come after a withdraw).
	MailboxShown int `yaml:"mailbox_shown"`
	// Anti-flood: a burst of ActionBurst market actions, then one every ActionRefillMs.
	ActionBurst    int `yaml:"action_burst"`
	ActionRefillMs int `yaml:"action_refill_ms"`
}

// MaxMarketPrice is the largest unit price the balance may allow: amount × price × the
// fee stay far from overflowing an int64.
const MaxMarketPrice = 1_000_000_000

func (m Market) check() error {
	if !m.Enabled {
		return nil
	}
	if m.FeePermille < 0 || m.FeePermille > 1000 || m.FeeMin < 0 || m.FeeMax < m.FeeMin {
		return errors.New("market: fee_permille in 0..1000, fee_min >= 0, fee_max >= fee_min")
	}
	if m.MaxOffers < 1 || m.MaxOffers > 100 || m.MaxAmount < 1 || m.MaxAmount > 100_000 ||
		m.MaxPrice < 1 || m.MaxPrice > MaxMarketPrice {
		return errors.New("market: max_offers in 1..100, max_amount in 1..100000, max_price in 1..1000000000")
	}
	if len(m.DurationsHours) == 0 || len(m.DurationsHours) > 8 {
		return errors.New("market: durations_hours needs 1..8 entries")
	}
	for _, h := range m.DurationsHours {
		if h < 1 || h > 24*60 {
			return errors.New("market: each duration in 1..1440 hours")
		}
	}
	if m.ListSize < 1 || m.ListSize > 100 || m.HistorySize < 1 || m.HistorySize > 200 || m.ReferenceDays < 1 ||
		m.ReferenceDays > 60 || m.MailboxShown < 1 || m.MailboxShown > 200 {
		return errors.New("market: list_size in 1..100, history_size in 1..200, reference_days in 1..60, mailbox_shown in 1..200")
	}
	if m.ActionBurst < 1 || m.ActionRefillMs < 1 || m.ActionRefillMs > 60_000 {
		return errors.New("market: action_burst >= 1 and action_refill_ms in 1..60000")
	}
	return nil
}

// Trade holds the direct trade rules (T5.3). The zero value (no trade block) turns the
// trade window off.
type Trade struct {
	Enabled bool `yaml:"enabled"`
	// MaxItems is how many items (stacks or containers) each side may offer.
	MaxItems int `yaml:"max_items"`
	// RequestMs: an invitation that is not answered expires after this.
	RequestMs int `yaml:"request_ms"`
}

func (t Trade) check() error {
	if t.Enabled && (t.MaxItems < 1 || t.MaxItems > 32 || t.RequestMs < 1000 || t.RequestMs > 600_000) {
		return errors.New("trade: max_items in 1..32 and request_ms in 1000..600000")
	}
	return nil
}
