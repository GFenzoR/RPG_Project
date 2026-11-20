package sim_test

// Party pace against solo (docs/02 "Grupos"): what each member of a sharing party earns
// against hunting alone, with the bonus steps of balance.yaml party.bonus_pct_by_sharers.
//
// Two models, both with the Puerto bestiary at its target levels and the real fight
// lengths of simulate:
//   - Same kills: each member kills what it would kill alone (the party pulls n
//     monsters at a time and each one fights its own). The pot is n times a solo kill's
//     experience and each sharer gets pot × (1 + bonus) / n: solo × (1 + bonus) exactly.
//     This is the owner's "up to +20 %".
//   - Focus: the whole party hits one monster at a time (the fight lasts 1/n) but walking,
//     looting and resting between kills (overheadSeconds) stay the same. It shows that on
//     easy monsters a party that focuses one target earns less than solo: the bonus pays
//     the hunt of tougher monsters and spreading out, not walking in a line.
//
// DEBUG_BALANCE=1 prints the table.

import (
	"fmt"
	"math"
	"os"
	"testing"
)

func TestPartyPaceVsSolo(t *testing.T) {
	d := loadData(t)
	pc := d.balance.Party
	if pc.MaxBonusPct() != 20 {
		t.Fatalf("party bonus cap %d %%, the owner decided 20 %%", pc.MaxBonusPct())
	}
	debug := os.Getenv("DEBUG_BALANCE") != ""
	for _, m := range d.puerto() {
		level := targetLevel[m.ID]
		s := d.simulate(t, m, level)
		solo := float64(m.Experience) * 3600 / (s.seconds + overheadSeconds)
		row := fmt.Sprintf("%-18s L%-2d solo %6.0f xp/h", m.ID, level, solo)
		prevSame := solo
		for n := 2; n <= pc.MaxMembers; n++ {
			b := float64(pc.BonusPct(n)) / 100
			// Same kills: n solo kills in the pot, split in n.
			same := solo * float64(n) * (1 + b) / float64(n)
			if math.Abs(same/solo-(1+b)) > 1e-9 || same > solo*1.2+1e-9 {
				t.Errorf("%s with %d: %.0f against solo %.0f", m.ID, n, same, solo)
			}
			if same+1e-9 < prevSame {
				t.Errorf("%s: %d sharers earn less than %d", m.ID, n, n-1)
			}
			prevSame = same
			focus := float64(m.Experience) * (1 + b) / float64(n) * 3600 / (s.seconds/float64(n) + overheadSeconds)
			row += fmt.Sprintf(" | %d: +%2d %% %6.0f (foco %3.0f %%)", n, pc.BonusPct(n), same, 100*focus/solo)
		}
		if debug {
			t.Log(row)
		}
	}
}
