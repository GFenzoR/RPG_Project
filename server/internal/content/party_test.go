package content

import (
	"path/filepath"
	"testing"
)

// The owner's party bonus (2026-11-20): +5, +10, +15 % for 2, 3 and 4 sharers, and
// +20 % from 5 on, never more; shared experience on by default.
func TestPartyBonusSteps(t *testing.T) {
	b, err := LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	p := b.Party
	if !p.SharedByDefault {
		t.Error("shared experience is not on by default")
	}
	for _, c := range []struct{ n, pct int }{{0, 0}, {1, 0}, {2, 5}, {3, 10}, {4, 15}, {5, 20}, {6, 20}, {50, 20}} {
		if got := p.BonusPct(c.n); got != c.pct {
			t.Errorf("BonusPct(%d) = %d, want %d", c.n, got, c.pct)
		}
	}
	if p.MaxBonusPct() != 20 {
		t.Errorf("cap %d, want 20", p.MaxBonusPct())
	}
}

func TestPartyBonusCheck(t *testing.T) {
	ok := Party{MaxMembers: 6, InviteMs: 1, InvitesPerMinute: 6, UpdateMs: 1, ShareDistance: 1, ContributionMs: 1, LevelRangePct: 70,
		BonusPctBySharers: []int{5, 10, 15, 20}}
	if err := ok.check(); err != nil {
		t.Fatal(err)
	}
	for name, steps := range map[string][]int{
		"none":       nil,
		"too many":   {1, 2, 3, 4, 5, 6},
		"decreasing": {10, 5},
		"negative":   {-1},
		"over 100":   {101},
	} {
		bad := ok
		bad.BonusPctBySharers = steps
		if bad.check() == nil {
			t.Errorf("%s: %v accepted", name, steps)
		}
	}
	for _, n := range []int{0, -1, 61} {
		bad := ok
		bad.InvitesPerMinute = n
		if bad.check() == nil {
			t.Errorf("invites_per_minute %d accepted", n)
		}
	}
}

// SharedEach is the whole formula of a shared kill: pot × (100 + bonus) / 100 / n each,
// the bonus part apart; nothing below two sharers or for an empty pot.
func TestPartySharedEach(t *testing.T) {
	p := Party{BonusPctBySharers: []int{5, 10, 15, 20}}
	for _, c := range []struct {
		pot         int64
		n           int
		each, extra int64
	}{
		{900, 2, 472, 22},
		{1200, 3, 440, 40},
		{1200, 6, 240, 40},
		{1200, 9, 160, 27},
		{1000, 1, 0, 0},
		{0, 3, 0, 0},
		{-5, 3, 0, 0},
	} {
		if each, extra := p.SharedEach(c.pot, c.n); each != c.each || extra != c.extra {
			t.Errorf("SharedEach(%d, %d) = %d %d, want %d %d", c.pot, c.n, each, extra, c.each, c.extra)
		}
	}
}
