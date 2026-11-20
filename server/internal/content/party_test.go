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
	want := map[int]int{0: 0, 1: 0, 2: 5, 3: 10, 4: 15, 5: 20, 6: 20, 50: 20}
	for n, pct := range want {
		if got := p.BonusPct(n); got != pct {
			t.Errorf("BonusPct(%d) = %d, want %d", n, got, pct)
		}
	}
	if p.MaxBonusPct() != 20 {
		t.Errorf("cap %d, want 20", p.MaxBonusPct())
	}
}

func TestPartyBonusCheck(t *testing.T) {
	ok := Party{MaxMembers: 6, InviteMs: 1, UpdateMs: 1, ShareDistance: 1, ContributionMs: 1, LevelRangePct: 70,
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
}
