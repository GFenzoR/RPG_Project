package sim_test

// Balance check for the Isla Volcánica bestiary (levels 25-60, Chapter 3, T5.5), with the
// same Monte Carlo duel as TestPuertoBalance and the embersteel kit Brasal sells or smiths.
//
// Targets: each common monster lasts 5-15 s and costs 10-40 % of max health at its target
// level; XP grows with the target level (and beyond Bosque's); hunting the island's best
// monster takes a guardian from 25 to 30 in 3.5-10 h, from 30 to 40 in 9.5-28 h and from
// 40 to 50 in 14-41 h (0.4-1.2 times the balance.yaml pace, as Bosque does: real players
// hunt worse than the best spot); loot stays a small gold faucet.
// The chapter boss is a long fight that needs healing or a group: 30-90 s and 60-200 %
// of max health at its target level.

import (
	"os"
	"testing"
)

var volcanTargetLevel = map[string]int{
	"ash_hound":         27,
	"cinder_salamander": 31,
	"obsidian_delver":   35,
	"slag_golem":        41,
	"ember_wyrmling":    50,
}

// volcanBoss is the Chapter 3 boss (ch3_warden) and its target level.
var volcanBoss = map[string]int{"slagbound_warden": 44}

// volcanKit is what Brasal (smith's shop and embersteel recipes) adds to the forest kit.
func volcanKit(level int) kit {
	legs := []string{"stagleather_leggings", "tarred_boots"}
	switch {
	case level >= 45:
		return kit{"wyrmfang_blade", append([]string{"embersteel_helm", "wyrmscale_mail"}, legs...), "embersteel_shield"}
	case level >= 36:
		return kit{"embersteel_sabre", append([]string{"embersteel_helm", "embersteel_cuirass"}, legs...), "embersteel_shield"}
	case level >= 34:
		return kit{"embersteel_sabre", append([]string{"embersteel_helm", "embersteel_cuirass"}, legs...), "elmwood_shield"}
	case level >= 30:
		return kit{"embersteel_sabre", append([]string{"embersteel_helm", "stagleather_coat"}, legs...), "elmwood_shield"}
	default:
		return bosqueKit(level)
	}
}

func TestVolcanBalance(t *testing.T) {
	d := loadData(t)
	volcan := d.island("volcan")
	if len(volcan) < 5 {
		t.Fatalf("only %d Volcán monsters", len(volcan))
	}
	for _, m := range volcan {
		_, common := volcanTargetLevel[m.ID]
		_, boss := volcanBoss[m.ID]
		if !common && !boss {
			t.Errorf("%s has no target level", m.ID)
		}
	}
	debug := os.Getenv("DEBUG_BALANCE") != ""

	t.Run("fights", func(t *testing.T) {
		for id, level := range volcanTargetLevel {
			m := d.monsters[id]
			if m == nil {
				t.Errorf("unknown monster %s", id)
				continue
			}
			s := d.simulateWith(t, m, level, volcanKit(level))
			if debug {
				t.Logf("%-17s lvl %2d  %5.1f s  %5.1f %% hp  %6.0f xp/h  loot %.1f",
					id, level, s.seconds, s.damagePct, d.xpPerHourWith(t, m, level, volcanKit(level)), d.lootValue(t, m))
			}
			if s.seconds < 5 || s.seconds > 15 || s.damagePct < 10 || s.damagePct > 40 {
				t.Errorf("%s at level %d: %.1f s (want 5-15), %.1f %% health (want 10-40)",
					id, level, s.seconds, s.damagePct)
			}
		}
	})

	t.Run("boss", func(t *testing.T) {
		for id, level := range volcanBoss {
			m := d.monsters[id]
			if m == nil {
				t.Fatalf("unknown boss %s", id)
			}
			s := d.simulateWith(t, m, level, volcanKit(level))
			if debug {
				t.Logf("%-17s lvl %2d  %5.1f s  %5.1f %% hp  loot %.1f", id, level, s.seconds, s.damagePct, d.lootValue(t, m))
			}
			if s.seconds < 30 || s.seconds > 90 || s.damagePct < 60 || s.damagePct > 200 {
				t.Errorf("%s at level %d: %.1f s (want 30-90), %.1f %% health (want 60-200)",
					id, level, s.seconds, s.damagePct)
			}
			for cid := range volcanTargetLevel {
				if m.Experience <= d.monsters[cid].Experience {
					t.Errorf("boss %s gives no more XP than %s", id, cid)
				}
			}
		}
	})

	t.Run("experience grows with target level", func(t *testing.T) {
		for lowID, low := range volcanTargetLevel {
			for highID, high := range volcanTargetLevel {
				if high > low && d.monsters[highID].Experience <= d.monsters[lowID].Experience {
					t.Errorf("%s (level %d) gives no more XP than %s (level %d)", highID, high, lowID, low)
				}
			}
		}
		// The island picks up where Bosque ends.
		for vID := range volcanTargetLevel {
			for bID := range bosqueTargetLevel {
				if d.monsters[vID].Experience <= d.monsters[bID].Experience {
					t.Errorf("%s gives no more XP than Bosque's %s", vID, bID)
				}
			}
		}
	})

	t.Run("pace", func(t *testing.T) {
		cv := d.balance.Experience
		hours := func(from, to int) float64 {
			h := 0.0
			for lvl := from; lvl < to; lvl++ {
				best := 0.0
				for id, tl := range volcanTargetLevel {
					if tl <= lvl {
						best = max(best, d.xpPerHourWith(t, d.monsters[id], lvl, volcanKit(lvl)))
					}
				}
				for id, tl := range bosqueTargetLevel {
					if tl <= lvl {
						best = max(best, d.xpPerHourWith(t, d.monsters[id], lvl, volcanKit(lvl)))
					}
				}
				h += float64(cv.TotalFor(lvl+1)-cv.TotalFor(lvl)) / best
			}
			return h
		}
		to30, to40, to50 := hours(25, 30), hours(30, 40), hours(40, 50)
		if debug {
			t.Logf("25->30 in %.2f h, 30->40 in %.2f h, 40->50 in %.2f h", to30, to40, to50)
		}
		if to30 < 3.5 || to30 > 10 || to40 < 9.5 || to40 > 28 || to50 < 14 || to50 > 41 {
			t.Errorf("25->30 in %.2f h (want 3.5-10), 30->40 in %.2f h (want 9.5-28), 40->50 in %.2f h (want 14-41)",
				to30, to40, to50)
		}
	})

	t.Run("loot is a small gold faucet", func(t *testing.T) {
		for id := range volcanTargetLevel {
			m := d.monsters[id]
			if r := d.lootValue(t, m) / float64(m.Experience); r < 0.1 || r > 1.5 {
				t.Errorf("%s: %.2f copper per XP (want 0.1-1.5)", id, r)
			}
		}
	})
}
