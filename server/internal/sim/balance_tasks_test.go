package sim_test

// Rewards of the hunting tasks and the side quests of lote 12 (docs/02 "Tareas" and
// "Quests secundarias"), measured against the hunts of the balance sims: the same Monte
// Carlo duel at the monster's target level (kitFor), so the numbers are the best hunt's,
// as the pace targets are.
//
//   - A task (a repeatable quest of a real island) adds at most a quarter, and at least a
//     tenth, to the experience and the loot an hour of its hunt gives, once every 20 hours
//     or more, and pays no item an NPC buys for more than its gold (it would pay more than
//     it says).
//   - A side quest of lote 12 pays 10-15 % of the experience of its band (its level and
//     the three after it), gold worth 4-10 minutes of its reference hunt's loot, and at
//     most one equipable, of an obtainable band and wearable at its level.
//
// DEBUG_BALANCE=1 prints the numbers docs/02 quotes.

import (
	"maps"
	"os"
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// huntHour is an hour of hunting monster id at its target level: experience and loot value.
type huntHour struct {
	level            int
	xpHour, goldHour float64
}

func (d *balanceData) hourOf(t *testing.T, id string) huntHour {
	t.Helper()
	level, ok := targetLevel[id]
	for _, levels := range []map[string]int{bosqueTargetLevel, volcanTargetLevel} {
		if l, in := levels[id]; in {
			level, ok = l, true
		}
	}
	m := d.monsters[id]
	if !ok || m == nil {
		t.Fatalf("%s has no target level", id)
	}
	s := d.simulateWith(t, m, level, kitFor(level))
	kills := 3600 / (s.seconds + overheadSeconds)
	return huntHour{level: level, xpHour: float64(m.Experience) * kills, goldHour: d.lootValue(t, m) * kills}
}

// givers maps each quest to the NPCs whose dialog starts it.
func givers(npcs content.NPCs) map[string][]*content.NPC {
	out := map[string][]*content.NPC{}
	for _, n := range npcs {
		for _, node := range n.Dialog.Nodes {
			for _, o := range node.Options {
				for _, a := range o.Action {
					if a.StartQuest != "" && !slices.Contains(out[a.StartQuest], n) {
						out[a.StartQuest] = append(out[a.StartQuest], n)
					}
				}
			}
		}
	}
	return out
}

func rewardSums(q *content.Quest) (xp, gold int64, items []string) {
	for _, r := range q.Rewards {
		xp, gold = xp+r.XP, gold+r.Gold
		if r.Item != "" {
			items = append(items, r.Item)
		}
	}
	return xp, gold, items
}

func TestTaskRewards(t *testing.T) {
	d := loadData(t)
	quests, err := content.LoadQuests(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	npcs, err := content.LoadNPCs(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	buyFor := map[string]int64{} // the best price an NPC pays for each item
	for _, n := range npcs {
		if n.Shop != nil {
			for _, o := range n.Shop.Buys {
				buyFor[o.Item] = max(buyFor[o.Item], o.Price)
			}
		}
	}
	by := givers(npcs)
	debug := os.Getenv("DEBUG_BALANCE") != ""
	tasks := 0
	for _, id := range slices.Sorted(maps.Keys(quests)) {
		q := quests[id]
		if q.Repeatable == nil {
			continue
		}
		// The sandbox island's practice task (docs/16) pays for three rats every three
		// minutes: a dev_only NPC gives it, and no production server has that island.
		dev := len(by[id]) > 0
		for _, n := range by[id] {
			dev = dev && n.DevOnly
		}
		if dev {
			continue
		}
		tasks++
		if len(by[id]) == 0 {
			t.Errorf("%s: no NPC gives it", id)
		}
		if q.Repeatable.CooldownHours < 20 {
			t.Errorf("%s: a %.2f-hour cooldown (the quarter of an hour is per day: 20 hours or more)", id, q.Repeatable.CooldownHours)
		}
		var prey string
		for _, s := range q.Steps {
			if k := s.CompleteWhen.Kill; k != nil {
				if prey != "" {
					t.Errorf("%s: more than one kill step", id)
				}
				prey = k.Monster
			}
		}
		if prey == "" {
			t.Errorf("%s: a task without a kill step", id)
			continue
		}
		h := d.hourOf(t, prey)
		xp, gold, items := rewardSums(q)
		for _, it := range items {
			if buyFor[it] > gold {
				t.Errorf("%s rewards %s, which an NPC buys for %d (more than its %d gold)", id, it, buyFor[it], gold)
			}
		}
		if debug {
			t.Logf("%-18s %-17s lvl %2d  %6.0f xp/h  %6.0f gold/h  reward %5d xp (%4.1f %%)  %5d gold (%4.1f %%)",
				id, prey, h.level, h.xpHour, h.goldHour, xp, 100*float64(xp)/h.xpHour, gold, 100*float64(gold)/h.goldHour)
		}
		if f := float64(xp) / h.xpHour; f < 0.10 || f > 0.25 {
			t.Errorf("%s: %d xp is %.1f %% of an hour of %s at level %d (%.0f xp; want 10-25 %%)", id, xp, 100*f, prey, h.level, h.xpHour)
		}
		if f := float64(gold) / h.goldHour; f < 0.10 || f > 0.25 {
			t.Errorf("%s: %d gold is %.1f %% of an hour of %s's loot at level %d (%.0f; want 10-25 %%)", id, gold, 100*f, prey, h.level, h.goldHour)
		}
	}
	if tasks < 4 {
		t.Errorf("only %d hunting tasks", tasks)
	}
}

// sideQuestBands is each side quest of lote 12: its band (its level and the three after
// it) and the hunt its gold is measured against (the band's best hunt on its island).
var sideQuestBands = map[string]struct {
	from int
	hunt string
}{
	"ferryman_jetty":  {22, "hollow_crawler"},
	"tanner_chitin":   {25, "hollow_crawler"},
	"captain_fenders": {30, "cinder_salamander"},
	"smith_ring":      {42, "slag_golem"},
	"flame_crater":    {45, "ember_wyrmling"},
}

func TestSideQuestRewards(t *testing.T) {
	d := loadData(t)
	quests, err := content.LoadQuests(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	cv := d.balance.Experience
	debug := os.Getenv("DEBUG_BALANCE") != ""
	for id, band := range sideQuestBands {
		q := quests[id]
		if q == nil || q.Repeatable != nil || q.Chapter != 0 || q.MinLevel != band.from {
			t.Errorf("%s: not a side quest from level %d", id, band.from)
			continue
		}
		xp, gold, items := rewardSums(q)
		bandXP := float64(cv.TotalFor(band.from+3) - cv.TotalFor(band.from))
		h := d.hourOf(t, band.hunt)
		minutes := float64(gold) / h.goldHour * 60
		if debug {
			t.Logf("%-16s %2d-%2d  %5d xp (%4.1f %% of %6.0f)  %4d gold (%4.1f min of %s)  %v",
				id, band.from, band.from+3, xp, 100*float64(xp)/bandXP, bandXP, gold, minutes, band.hunt, items)
		}
		if f := float64(xp) / bandXP; f < 0.10 || f > 0.15 {
			t.Errorf("%s: %d xp is %.1f %% of the experience from %d to %d (want 10-15 %%)", id, xp, 100*f, band.from, band.from+3)
		}
		if minutes < 4 || minutes > 10 {
			t.Errorf("%s: %d gold is %.1f minutes of %s's loot (want 4-10)", id, gold, minutes, band.hunt)
		}
		equipables := 0
		for _, it := range items {
			def := d.item(t, it)
			if !content.Rolls(def) {
				continue
			}
			equipables++
			if def.Retired || def.Requires.Level > band.from || def.Requires.Level >= 50 {
				t.Errorf("%s rewards %s (level %d, retired %v): not a piece of an obtainable band at level %d",
					id, it, def.Requires.Level, def.Retired, band.from)
			}
		}
		if equipables > 1 {
			t.Errorf("%s rewards %d equipables (at most one)", id, equipables)
		}
	}
}
