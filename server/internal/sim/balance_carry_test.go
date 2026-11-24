package sim_test

// Realistic loads (owner, 2026-11-23; docs/02 "Unidades", "Cargas realistas"): capacity
// and item weights are real grams, a starting character carries some 40-45 kg. The hunting
// loop must stay playable: a character in its level's kit, with its supplies, carries a
// normal hunt's loot home. This checks it every five levels up to 50 for every vocation,
// against every common monster of that level, with the kits of the balance sims, the
// tools an explorer carries (a rope and a shovel) and a purse.

import (
	"fmt"
	"os"
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

const (
	// huntKills is a normal hunt: about 30 minutes at ~30 s a kill (a 5-15 s fight, the
	// walk and the looting).
	huntKills = 60
	// lootLuck: the expected loot is raised this much for a lucky hunt.
	lootLuck = 1.15
)

// heavyHaul are the monsters whose loot is raw material by the kilo (logs, ore, slag
// cores): nobody carries 60 kills of it home, the hunter picks or goes back sooner. They
// must still leave room for heavyKills kills (some 8 minutes); docs/02 "Cargas realistas"
// lists them and docs/14 leaves their drops to the owner.
var heavyHaul = map[string]bool{"thornling": true, "obsidian_delver": true, "slag_golem": true}

// heavyKills is the hunt a heavyHaul monster must allow.
const heavyKills = 15

// carryLevels are the levels TestHuntLootFits checks: every five, so every common monster
// is hunted at one of them (TestHuntLootFits fails if one is not).
var carryLevels = []int{1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50}

// carryKit is what a vocation wears at level: the kits of the careers
// (balance_vocations_test.go), the guardian's of the melee sims.
func carryKit(voc string, level int) hunterKit {
	switch voc {
	case "guardian":
		k := kitFor(level)
		return hunterKit{weapon: k.weapon, armor: k.armor, shield: k.shield}
	case "ranger":
		return crossbowKit(level) // the heavier ranger: plate, shield and a crossbow
	default:
		return casterKit(voc, level)
	}
}

// supply is a stack a hunter brings.
type supply struct {
	item  string
	count int
}

// carrySupplies is what a vocation brings to a hunt besides its kit: a rope and a shovel
// (the tools one keeps in the backpack), a purse (100 copper and 10 silver coins: change
// for the shops) and food for everyone; health draughts for the guardian, mana draughts
// for the casters, some of both and its ammo for the ranger.
func carrySupplies(voc string, ammo string) []supply {
	s := []supply{{"rope", 1}, {"shovel", 1}, {"copper_coin", 100}, {"silver_coin", 10}, {"ship_biscuit", 10}}
	switch voc {
	case "guardian":
		s = append(s, supply{"health_draught", 10})
	case "ranger":
		s = append(s, supply{"health_draught", 5}, supply{"mana_draught", 5}, supply{ammo, 100})
	default:
		s = append(s, supply{"mana_draught", 20})
	}
	return s
}

// huntLootGrams is the expected weight of the loot of kills kills of m: every drop it can
// give, coins too, at its chance and mean count.
func (d *balanceData) huntLootGrams(t *testing.T, m *content.Monster, kills int) float64 {
	t.Helper()
	per := 0.0
	for _, l := range m.Loot {
		lo, hi := l.CountRange()
		per += l.Chance * float64(lo+hi) / 2 * float64(d.item(t, l.Item).Weight)
	}
	return per * float64(kills)
}

// huntersOf is every common monster whose target level is within [level-4, level+2],
// sorted: what a hunter of level hunts.
func huntersOf(level int) []string {
	var out []string
	for id, l := range commonTargets() {
		if l >= level-4 && l <= level+2 {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out
}

// carried is the grams of kit, the backpack, the tools, the purse and the supplies.
func (d *balanceData) carried(t *testing.T, voc string, level int) int {
	t.Helper()
	k := carryKit(voc, level)
	g := d.item(t, "backpack").Weight
	for _, id := range append([]string{k.weapon, k.shield}, k.armor...) {
		if id != "" {
			g += d.item(t, id).Weight
		}
	}
	ammo := k.ammo
	if ammo == "" {
		ammo = "arrow"
	}
	for _, s := range carrySupplies(voc, ammo) {
		g += s.count * d.item(t, s.item).Weight
	}
	return g
}

func TestHuntLootFits(t *testing.T) {
	d := loadData(t)
	debug := os.Getenv("DEBUG_BALANCE") != ""
	hunted, tooHeavy := map[string]bool{}, map[string]bool{}
	for _, level := range carryLevels {
		monsters := huntersOf(level)
		if len(monsters) == 0 {
			t.Fatalf("no common monster to hunt at level %d", level)
		}
		for _, id := range monsters {
			hunted[id] = true
		}
		for _, voc := range []string{"guardian", "arcanist", "ranger", "druid"} {
			v, ok := d.vocations[voc]
			if !ok {
				t.Fatalf("no vocation %s", voc)
			}
			capacity := v.AtLevel(level).Capacity
			worn := d.carried(t, voc, level)
			free := capacity - worn
			for _, id := range monsters {
				m := d.monsters[id]
				if m == nil {
					t.Fatalf("unknown monster %s", id)
				}
				kills := huntKills
				if heavyHaul[id] {
					kills = heavyKills
				}
				loot := d.huntLootGrams(t, m, kills) * lootLuck
				line := fmt.Sprintf("level %d %s: capacity %.1f kg, kit and supplies %.1f kg, %.1f kg free, %d %s %.1f kg (full after %.0f kills)",
					level, voc, kg(capacity), kg(worn), kg(free), kills, id, loot/1000, float64(free)*float64(kills)/loot)
				if debug {
					t.Log(line)
				}
				if loot > float64(free) {
					t.Errorf("%s: does not fit", line)
				}
				if heavyHaul[id] && d.huntLootGrams(t, m, huntKills)*lootLuck > float64(free) {
					tooHeavy[id] = true
				}
			}
		}
	}
	for id := range commonTargets() {
		if !hunted[id] {
			t.Errorf("no level of carryLevels hunts %s", id)
		}
	}
	// A heavy hauler whose whole hunt fits every vocation is no exception any more.
	for id := range heavyHaul {
		if !tooHeavy[id] {
			t.Errorf("%s fits a hunt of %d kills: take it out of heavyHaul", id, huntKills)
		}
	}
}

// TestCapacityIsRealistic: the capacities of data/vocations.yaml are human loads
// (docs/02 "Cargas realistas"): 35-45 kg at level 1 with the guardian strongest and the
// arcanist weakest, about 80-120 kg at level 75, the top band of the catalog.
func TestCapacityIsRealistic(t *testing.T) {
	d := loadData(t)
	strongest, weakest := "", ""
	for id, v := range d.vocations {
		start, top := v.AtLevel(1).Capacity, v.AtLevel(75).Capacity
		if start < 35_000 || start > 45_000 {
			t.Errorf("%s starts with %.1f kg, want 35-45 kg", id, kg(start))
		}
		if top < 80_000 || top > 120_000 {
			t.Errorf("%s carries %.1f kg at level 75, want 80-120 kg", id, kg(top))
		}
		if strongest == "" || start > d.vocations[strongest].AtLevel(1).Capacity {
			strongest = id
		}
		if weakest == "" || start < d.vocations[weakest].AtLevel(1).Capacity {
			weakest = id
		}
	}
	if strongest != "guardian" || weakest != "arcanist" {
		t.Errorf("strongest %s and weakest %s at level 1, want guardian and arcanist", strongest, weakest)
	}
}

func kg(grams int) float64 { return float64(grams) / 1000 }
