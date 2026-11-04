package sim_test

// Balance check for the Isla del Bosque bestiary (levels 10-30, Chapter 2, T3.6), with the
// same Monte Carlo duel as TestPuertoBalance and the kit the forest town sells or crafts.
//
// Targets: each monster lasts 5-15 s and costs 10-40 % of max health at its target level;
// XP grows with the target level; hunting the island's best monster takes a guardian from
// level 15 to 20 in 2-5 h and from 20 to 25 in 3-7 h; loot stays a small gold faucet.

import (
	"os"
	"testing"
)

var bosqueTargetLevel = map[string]int{
	"bramble_stag":    11,
	"mire_toad":       13,
	"coffer_smuggler": 16,
	"thornling":       20,
	"hollow_crawler":  24,
}

// bosqueKit is what Puerto and the forest town (shop and elm recipes) provide.
func bosqueKit(level int) kit {
	switch {
	case level >= 16:
		return kit{"thornwood_blade", []string{"sailcloth_cap", "stagleather_coat", "stagleather_leggings", "tarred_boots"}, "elmwood_shield"}
	case level >= 14:
		return kit{"boarding_saber", []string{"sailcloth_cap", "stagleather_coat", "stagleather_leggings", "tarred_boots"}, "elmwood_shield"}
	case level >= 12:
		return kit{"boarding_saber", []string{"sailcloth_cap", "leather_jerkin", "stagleather_leggings", "tarred_boots"}, "elmwood_shield"}
	default:
		return kitFor(level)
	}
}

func TestBosqueBalance(t *testing.T) {
	d := loadData(t)
	bosque := d.island("bosque")
	if len(bosque) < 3 {
		t.Fatalf("only %d Bosque monsters", len(bosque))
	}
	for _, m := range bosque {
		if _, ok := bosqueTargetLevel[m.ID]; !ok {
			t.Errorf("%s has no target level", m.ID)
		}
	}
	debug := os.Getenv("DEBUG_BALANCE") != ""

	t.Run("fights", func(t *testing.T) {
		for id, level := range bosqueTargetLevel {
			m := d.monsters[id]
			if m == nil {
				t.Errorf("unknown monster %s", id)
				continue
			}
			s := d.simulateWith(t, m, level, bosqueKit(level))
			if debug {
				t.Logf("%-17s lvl %2d  %5.1f s  %5.1f %% hp  %6.0f xp/h  loot %.1f",
					id, level, s.seconds, s.damagePct, d.xpPerHourWith(t, m, level, bosqueKit(level)), d.lootValue(t, m))
			}
			if s.seconds < 5 || s.seconds > 15 || s.damagePct < 10 || s.damagePct > 40 {
				t.Errorf("%s at level %d: %.1f s (want 5-15), %.1f %% health (want 10-40)",
					id, level, s.seconds, s.damagePct)
			}
		}
	})

	t.Run("experience grows with target level", func(t *testing.T) {
		for lowID, low := range bosqueTargetLevel {
			for highID, high := range bosqueTargetLevel {
				if high > low && d.monsters[highID].Experience <= d.monsters[lowID].Experience {
					t.Errorf("%s (level %d) gives no more XP than %s (level %d)", highID, high, lowID, low)
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
				for id, tl := range bosqueTargetLevel {
					if tl <= lvl {
						best = max(best, d.xpPerHourWith(t, d.monsters[id], lvl, bosqueKit(lvl)))
					}
				}
				h += float64(cv.TotalFor(lvl+1)-cv.TotalFor(lvl)) / best
			}
			return h
		}
		to20, to25 := hours(15, 20), hours(20, 25)
		if debug {
			t.Logf("15->20 in %.2f h, 20->25 in %.2f h", to20, to25)
		}
		if to20 < 2 || to20 > 5 || to25 < 3 || to25 > 7 {
			t.Errorf("15->20 in %.2f h (want 2-5), 20->25 in %.2f h (want 3-7)", to20, to25)
		}
	})

	t.Run("loot is a small gold faucet", func(t *testing.T) {
		for id := range bosqueTargetLevel {
			m := d.monsters[id]
			if r := d.lootValue(t, m) / float64(m.Experience); r < 0.1 || r > 1.5 {
				t.Errorf("%s: %.2f copper per XP (want 0.1-1.5)", id, r)
			}
		}
	})
}
