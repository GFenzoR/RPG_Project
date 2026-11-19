package sim_test

// Balance check for the Isla del Puerto bestiary (levels 1-15, Chapter 1), ported from
// the provisional TypeScript model (packages/content-schema, T1.5) now that the melee
// formulas exist (internal/combat, numbers in data/balance.yaml).
//
// Each fight is a Monte Carlo duel with the real formulas: a guardian at the monster's
// target level, with that level's kit, against one monster. It does not run the session
// World yet because players cannot equip items until T1.8; when they can, this should
// become a World fight with a real kit.
//
// Targets (skill add-monster + balance.yaml pace):
//   - Each monster lasts 5-15 s and costs the player 10-40 % of max health (2-40 % for
//     the level 1-2 pests).
//   - Hunting the island's best monster for each level reaches level 8 in ~1 h and level
//     15 in ~3.6 h (the curve between "8 in 1 h" and "20 in 8 h").
//   - XP grows with the monster's target level, and loot stays a small gold faucet.
//
// DEBUG_BALANCE=1 prints the per-monster table.

import (
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

var dataDir = filepath.Join("..", "..", "..", "data")

// targetLevel is the level a guardian should be to hunt each Puerto monster comfortably.
var targetLevel = map[string]int{
	"bilge_rat":        1,
	"thieving_gull":    2,
	"wolf":             4,
	"gloom_bat":        4,
	"tide_crab":        5,
	"bristleback_boar": 7,
	"moss_spider":      8,
	"wreck_looter":     10,
	"ore_beetle":       12,
	"drowned_miner":    14,
}

// pests: a fresh guardian has ~145 health, so they are meant to be nearly harmless.
var pests = map[string]bool{"bilge_rat": true, "thieving_gull": true}

const (
	// Expected melee skill of a guardian who hunts at each level: start + perLevel*(L-1).
	skillStart    = 10
	skillPerLevel = 1.5
	// Walking, looting and short rests between kills.
	overheadSeconds = 15.0
	fights          = 4000
	maxFightMs      = 120_000
)

type kit struct {
	weapon string
	armor  []string
	shield string
}

// kitFor is the guardian's kit at each level: the band of the compact catalog it has
// reached (lote 11, docs/02 "Catálogo de equipo"), what the shops of the three islands sell
// or smith. A new character wears the tunic and the barrel lid; the cap, trousers and boots
// of band 1 come with the first coins, at level 5 with the band 2 sword and shield. Band 3
// brings its weapons at level 10 and its armor, shield and amulet at 15; band 4 everything
// at 30. The rings are rare loot (and band 3 and 4 ones carry no armor): out of the kit.
func kitFor(level int) kit {
	band1 := []string{"sailcloth_cap", "patched_tunic", "canvas_trousers", "tarred_boots"}
	switch {
	case level >= 30:
		return kit{"embersteel_sabre", []string{"embersteel_helm", "embersteel_cuirass", "embersteel_greaves",
			"embersteel_sabatons", "cinder_amulet"}, "embersteel_shield"}
	case level >= 15:
		return kit{"boarding_saber", []string{"stagleather_hood", "stagleather_coat", "stagleather_leggings",
			"stagleather_boots", "antler_amulet"}, "elmwood_shield"}
	case level >= 10:
		return kit{"boarding_saber", band1, "plank_shield"}
	case level >= 5:
		return kit{"iron_sword", band1, "plank_shield"}
	default:
		return kit{"rusty_cutlass", []string{"patched_tunic"}, "barrel_lid_shield"}
	}
}

// wearable fails t unless a character of voc and level can wear every item of ids: it is
// in the catalog (not retired) and asks for no more level and no other vocation. The kits
// of the balance sims are the catalog's, not a wish list.
func (d *balanceData) wearable(t *testing.T, voc string, level int, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if id == "" {
			continue
		}
		it := d.item(t, id)
		switch {
		case it.Retired:
			t.Errorf("level %d %s kit: %s is retired", level, voc, id)
		case it.Requires.Level > level:
			t.Errorf("level %d %s kit: %s asks for level %d", level, voc, id, it.Requires.Level)
		case len(it.Requires.Vocations) > 0 && !slices.Contains(it.Requires.Vocations, voc):
			t.Errorf("level %d %s kit: %s is for %v", level, voc, id, it.Requires.Vocations)
		}
	}
}

func TestGuardianKitIsTheCatalogs(t *testing.T) {
	d := loadData(t)
	for level := 1; level <= 60; level++ {
		k := kitFor(level)
		d.wearable(t, "guardian", level, append([]string{k.weapon, k.shield}, k.armor...)...)
	}
}

type balanceData struct {
	monsters  content.Monsters
	items     content.Items
	guardian  content.Vocation
	vocations content.Vocations
	spells    content.Spells
	balance   content.Balance
	// attrs is the attribute pool every kit piece rolls from (gear_test.go).
	attrs content.Attributes
}

func loadData(t *testing.T) *balanceData {
	t.Helper()
	ms, err := content.LoadMonsters(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := content.LoadItems(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	vs, err := content.LoadVocations(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := content.LoadBalance(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	spells, err := content.LoadSpells(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	attrs, err := content.LoadAttributes(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	return &balanceData{monsters: ms, items: items, guardian: vs["guardian"], vocations: vs, spells: spells, balance: b,
		attrs: attrs}
}

func (d *balanceData) item(t *testing.T, id string) *content.Item {
	t.Helper()
	it := d.items[id]
	if it == nil {
		t.Fatalf("unknown item %s", id)
	}
	return it
}

type fightStats struct{ seconds, damagePct float64 }

func (d *balanceData) simulate(t *testing.T, m *content.Monster, level int) fightStats {
	t.Helper()
	return d.simulateWith(t, m, level, kitFor(level))
}

// simulateWith is simulate with an explicit kit (each island has its own shops).
func (d *balanceData) simulateWith(t *testing.T, m *content.Monster, level int, k kit) fightStats {
	t.Helper()
	r := rand.New(rand.NewPCG(1, uint64(level)))
	c := d.balance.Combat
	weapon := d.item(t, k.weapon).Weapon
	if weapon == nil {
		t.Fatalf("%s is not a weapon", k.weapon)
	}
	armor := 0
	for _, id := range k.armor {
		if a := d.item(t, id).Armor; a != nil {
			armor += a.Armor
		}
	}
	shield := 0
	if s := d.item(t, k.shield).Shield; s != nil {
		shield = s.Defense
	}
	balanced := c.Modes["balanced"]
	pieces := []*content.Item{d.item(t, k.weapon), d.item(t, k.shield)}
	for _, id := range k.armor {
		pieces = append(pieces, d.item(t, id))
	}
	baseHP := float64(d.guardian.AtLevel(level).Health)
	baseSkill := skillStart + int(math.Floor(skillPerLevel*float64(level-1)))

	totalMs, totalDmg := 0, 0.0
	f := newFoe(m, d.monsters, c, r) // its abilities and summons: foe_test.go
	for range fights {
		// Each fight is a kit with its own rolled attributes (gear_test.go): over the
		// fights, a kit's mean attributes.
		g := d.rollGear(r, pieces...)
		maxHit := combat.MaxHit(c, baseSkill+int(g.skill[weapon.Type]), weapon.Attack+int(g.attack), level, balanced.Attack)
		player := combat.PlayerTarget{Armor: armor + int(g.armor), Defense: shield + int(g.defense) + weapon.Defense,
			ModeDefense: balanced.Defense}
		f.protect = g.protect
		taken, leeched, now, nextPlayer := 0, 0, 0, 0
		f.start(0)
		for f.alive() && now < maxFightMs {
			tMonster := f.nextAt()
			if nextPlayer <= tMonster {
				now = nextPlayer
				dmg := combat.HitMonster(r, maxHit, f.target())
				f.hit(now, dmg)
				leeched += dmg * int(g.lifeLeech) / 100 // the server's integer leech
				nextPlayer += c.AttackIntervalMs
				continue
			}
			now = tMonster
			taken += f.act(now, player)
		}
		totalMs += now
		// Health lost, as a share of this kit's maximum; leech gives back at most that.
		totalDmg += float64(max(taken-leeched, 0)) / (baseHP + g.health)
	}
	return fightStats{
		seconds:   float64(totalMs) / fights / 1000,
		damagePct: 100 * totalDmg / fights,
	}
}

func (d *balanceData) xpPerHour(t *testing.T, m *content.Monster, level int) float64 {
	return d.xpPerHourWith(t, m, level, kitFor(level))
}

func (d *balanceData) xpPerHourWith(t *testing.T, m *content.Monster, level int, k kit) float64 {
	s := d.simulateWith(t, m, level, k)
	return float64(m.Experience) * 3600 / (s.seconds + overheadSeconds)
}

func (d *balanceData) lootValue(t *testing.T, m *content.Monster) float64 {
	sum := 0.0
	for _, l := range m.Loot {
		lo, hi := l.CountRange()
		sum += l.Chance * float64(lo+hi) / 2 * float64(d.item(t, l.Item).Value)
	}
	return sum
}

func (d *balanceData) puerto() []*content.Monster { return d.island("puerto") }

func (d *balanceData) island(tag string) []*content.Monster {
	var out []*content.Monster
	for _, id := range d.monsters.IDs() {
		m := d.monsters[id]
		if slices.Contains(monsterTags(id), tag) {
			out = append(out, m)
		}
	}
	return out
}

// monsterTags reads the tags of a monster (content.Monster does not need them).
func monsterTags(id string) []string {
	var f struct {
		Tags []string `yaml:"tags"`
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "monsters", id+".yaml"))
	if err != nil || yaml.Unmarshal(raw, &f) != nil {
		return nil
	}
	return f.Tags
}

func TestPuertoBalance(t *testing.T) {
	d := loadData(t)
	puerto := d.puerto()
	if len(puerto) < 8 {
		t.Fatalf("only %d Puerto monsters", len(puerto))
	}
	for _, m := range puerto {
		if _, ok := targetLevel[m.ID]; !ok {
			t.Errorf("%s has no target level", m.ID)
		}
	}

	t.Run("fights", func(t *testing.T) {
		for id, level := range targetLevel {
			m := d.monsters[id]
			if m == nil {
				t.Errorf("unknown monster %s", id)
				continue
			}
			s := d.simulate(t, m, level)
			if os.Getenv("DEBUG_BALANCE") != "" {
				t.Logf("%-17s lvl %2d  %5.1f s  %5.1f %% hp  %6.0f xp/h  loot %.1f",
					id, level, s.seconds, s.damagePct, d.xpPerHour(t, m, level), d.lootValue(t, m))
			}
			minDmg := 10.0
			if pests[id] {
				minDmg = 2
			}
			if s.seconds < 5 || s.seconds > 15 || s.damagePct < minDmg || s.damagePct > 40 {
				t.Errorf("%s at level %d: %.1f s (want 5-15), %.1f %% health (want %.0f-40)",
					id, level, s.seconds, s.damagePct, minDmg)
			}
		}
	})

	t.Run("experience grows with target level", func(t *testing.T) {
		for lowID, low := range targetLevel {
			for highID, high := range targetLevel {
				if high > low && d.monsters[highID].Experience <= d.monsters[lowID].Experience {
					t.Errorf("%s (level %d) gives no more XP than %s (level %d)", highID, high, lowID, low)
				}
			}
		}
	})

	t.Run("pace", func(t *testing.T) {
		cv := d.balance.Experience
		hoursTo := func(goal int) float64 {
			hours := 0.0
			for lvl := 1; lvl < goal; lvl++ {
				best := 0.0
				for id, tl := range targetLevel {
					if tl <= lvl {
						best = max(best, d.xpPerHour(t, d.monsters[id], lvl))
					}
				}
				hours += float64(cv.TotalFor(lvl+1)-cv.TotalFor(lvl)) / best
			}
			return hours
		}
		to8, to15 := hoursTo(8), hoursTo(15)
		if os.Getenv("DEBUG_BALANCE") != "" {
			t.Logf("level 8 in %.2f h, level 15 in %.2f h", to8, to15)
		}
		if to8 < 0.6 || to8 > 1.5 || to15 < 2.5 || to15 > 5 {
			t.Errorf("level 8 in %.2f h (want 0.6-1.5), level 15 in %.2f h (want 2.5-5)", to8, to15)
		}
	})

	t.Run("quest items near the quest level", func(t *testing.T) {
		// Shops and dialog give_item count as level 1; loot at the monster's target level.
		easy := map[string]bool{}
		giveItem := regexp.MustCompile(`give_item:\s*([a-z0-9_]+)`)
		npcs, _ := filepath.Glob(filepath.Join(dataDir, "npcs", "*.yaml"))
		for _, f := range npcs {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			for _, m := range giveItem.FindAllSubmatch(raw, -1) {
				easy[string(m[1])] = true
			}
			var npc struct {
				Shop struct {
					Sells []struct {
						Item string `yaml:"item"`
					} `yaml:"sells"`
				} `yaml:"shop"`
			}
			if err := yaml.Unmarshal(raw, &npc); err != nil {
				t.Fatalf("%s: %v", f, err)
			}
			for _, o := range npc.Shop.Sells {
				easy[o.Item] = true
			}
		}
		quests, _ := filepath.Glob(filepath.Join(dataDir, "quests", "*.yaml"))
		for _, f := range quests {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			var q struct {
				ID       string `yaml:"id"`
				MinLevel int    `yaml:"min_level"`
				Steps    []struct {
					CompleteWhen struct {
						HasItem *struct {
							Item string `yaml:"item"`
						} `yaml:"has_item"`
					} `yaml:"complete_when"`
				} `yaml:"steps"`
			}
			if err := yaml.Unmarshal(raw, &q); err != nil {
				t.Fatalf("%s: %v", f, err)
			}
			for _, s := range q.Steps {
				if s.CompleteWhen.HasItem == nil {
					continue
				}
				want := s.CompleteWhen.HasItem.Item
				source := math.MaxInt
				if easy[want] {
					source = 1
				}
				for _, m := range d.monsters {
					for _, l := range m.Loot {
						if l.Item == want {
							if tl, ok := targetLevel[m.ID]; ok {
								source = min(source, tl)
							}
							if tl, ok := bosqueTargetLevel[m.ID]; ok {
								source = min(source, tl)
							}
							if tl, ok := volcanTargetLevel[m.ID]; ok {
								source = min(source, tl)
							}
							if tl, ok := volcanBoss[m.ID]; ok {
								source = min(source, tl)
							}
						}
					}
				}
				if source > max(q.MinLevel, 1)+4 {
					t.Errorf("%s: %s first obtainable at level %d", q.ID, want, source)
				}
			}
		}
	})

	t.Run("loot is a small gold faucet", func(t *testing.T) {
		for id := range targetLevel {
			m := d.monsters[id]
			if r := d.lootValue(t, m) / float64(m.Experience); r < 0.1 || r > 1.5 {
				t.Errorf("%s: %.2f copper per XP (want 0.1-1.5)", id, r)
			}
		}
	})
}
