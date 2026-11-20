package sim_test

// Party pace against solo (docs/02 "Grupos"): what each member of a sharing party earns
// against hunting alone, through the real formula of a shared kill (content.Party
// SharedEach, the one session.shareExperience pays with) and the bonus steps of
// balance.yaml party.bonus_pct_by_sharers.
//
// Two models, both with the Puerto bestiary at its target levels and the real fight
// lengths of simulate:
//   - Same kills: each member kills what it would kill alone (the party pulls n
//     monsters at a time and each one fights its own). The pot is n solo kills and each
//     sharer gets SharedEach of it: solo × (1 + bonus), the owner's "up to +20 %".
//   - Focus: the whole party hits one monster at a time (the fight lasts 1/n) but walking,
//     looting and resting between kills (overheadSeconds) stay the same. On easy
//     monsters a party that focuses one target earns less per member than solo: the
//     bonus pays spreading out and tougher monsters, not walking in a line. Its bounds
//     (focusFloor) catch a balance change that makes party hunting worse still.
//
// DEBUG_BALANCE=1 prints the table.

import (
	"fmt"
	"os"
	"testing"
)

// focusFloor is the lowest share of the solo pace a focusing member may earn, by party
// size: today 61-67 % with two and 25-33 % with six on the Puerto bestiary. It holds
// for monsters of at least focusMinXP experience: on the 6-8 xp starters (bilge rat,
// thieving gull) a shared kill's integer split eats the bonus (6 xp × 1.05 / 2 = 3
// each) and a focusing party of 3-6 earns 16-41 %.
var focusFloor = map[int]float64{2: 0.55, 3: 0.40, 4: 0.33, 5: 0.27, 6: 0.22}

const focusMinXP = 20

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
		kills := 3600 / (s.seconds + overheadSeconds)
		solo := float64(m.Experience) * kills
		row := fmt.Sprintf("%-18s L%-2d solo %6.0f xp/h", m.ID, level, solo)
		prevSame := solo
		for n := 2; n <= pc.MaxMembers; n++ {
			// Same kills: n solo kills in the pot, split in n.
			each, _ := pc.SharedEach(int64(n)*m.Experience, n)
			same := float64(each) * kills
			// The owner's promise: solo + the bonus of n sharers (less under one
			// experience point a kill lost to the integer split), never past the cap.
			b := float64(pc.BonusPct(n)) / 100
			if lo := (float64(m.Experience)*(1+b) - 1) * kills; same+1e-6 < lo || same > solo*1.2+1e-6 {
				t.Errorf("%s with %d: %.0f xp/h against solo %.0f (want solo +%d %%, at most +20 %%)", m.ID, n, same, solo, pc.BonusPct(n))
			}
			if same+1e-9 < prevSame {
				t.Errorf("%s: %d sharers earn less than %d", m.ID, n, n-1)
			}
			prevSame = same
			// Focus: one kill at a time, the fight split among n.
			each, _ = pc.SharedEach(m.Experience, n)
			focus := float64(each) * 3600 / (s.seconds/float64(n) + overheadSeconds)
			ratio := focus / solo
			if m.Experience >= focusMinXP && ratio < focusFloor[n] {
				t.Errorf("%s focusing with %d: %.0f %% of solo, floor %.0f %%", m.ID, n, 100*ratio, 100*focusFloor[n])
			}
			if ratio > 1.2+1e-9 {
				t.Errorf("%s focusing with %d: %.0f %% of solo, above the +20 %% cap", m.ID, n, 100*ratio)
			}
			// The party as a whole kills faster than one hunter: n members focusing
			// earn more together than one alone.
			if m.Experience >= focusMinXP && focus*float64(n) < solo {
				t.Errorf("%s: a party of %d focusing earns %.0f xp/h in all, less than solo %.0f", m.ID, n, focus*float64(n), solo)
			}
			row += fmt.Sprintf(" | %d: +%2d %% %6.0f (foco %3.0f %%)", n, pc.BonusPct(n), same, 100*ratio)
		}
		if debug {
			t.Log(row)
		}
	}
}
