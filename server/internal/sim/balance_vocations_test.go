package sim_test

// Balance check for the arcanist, the druid and the ranger (content audit M2-M5): the
// guardian sims (balance_test.go, balance_bosque_test.go, balance_volcan_test.go) duel
// with melee only; these play a whole career, level 1 to 50, with each vocation's own
// weapons, spells and a real mana budget. The guardian plays one too, with its melee kit
// and, since the spell progression (2026-11), its own heal and strikes: the yardstick.
//
// Each hunt is a Monte Carlo series of duels with the real formulas against one monster
// of the islands' bestiary (the target levels of the guardian sims), with the kit the
// shops sell at that level. Inside a fight the hunter:
//   - shoots its weapon every attack round: a wand or staff (combat.WandHit) or a bow or
//     crossbow with its ammo (melee formula with the distance skill);
//   - casts its best attack spell whenever the attack group is ready and the mana allows;
//   - casts its best self-heal under half health (the healing group is apart), and under a
//     third, when it cannot, drinks the biggest health potion the shops of its level sell
//     that the wound takes whole (the seaweed poultice; the health draught from the Bosque,
//     level 12; the concentrated one from Cinderstead, level 30);
//   - regenerates as its vocation, with the server's integer formula and the bonus of
//     balance.yaml well_fed (content.Regen.Tick): every hunter eats ship's biscuit, and
//     pays for it, the whole hunt; and drinks mana draughts with the consumable cooldown.
// Health and mana carry over from one fight to the next, with the 15 s of walking and
// looting in between. Three habits are tried and the best affordable one kept:
//   - frugal: attack spells only with the mana that regeneration gives, keeping a reserve
//     for heals; draughts only for a heal it needs;
//   - budget: draughts for attack spells too, while they cost at most budgetShare of what
//     the hunt has earned so far;
//   - full: draughts keep the attack spells going.
// A fourth one, dry (no mana draught at all), plays a second guardian career: the one
// that buys none must still reach its spells' magic levels, and it is the one that
// drinks the health draughts (the others' heal spells, fed by draughts, cost less).
// What the food, draughts, potions and ammo cost must stay well under what the hunt
// earns (coins plus a third of the items' value, what NPCs pay).
//
// The career picks, at each level, the monster and habit with the most XP per hour that
// a hunter can afford and survive, and adds the mana it spent to its magic level
// (skills.base.magic: tries = mana spent). So the magic level of each level comes from
// what the hunting really spends, not from a guess. Weapon skills follow the guardian
// sims' rule (skillStart + skillPerLevel × (level − 1)); a `skill: weapon` spell (the
// guardian's strikes) scales with that skill, the one of the weapon the hunter holds.
//
// DEBUG_BALANCE=1 prints each career, level by level.

import (
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/skills"
)

const (
	careerFights   = 400   // duels per hunt
	careerTo       = 50    // the career ends at this level
	maxDeaths      = 0.003 // a hunt that kills the hunter more often is skipped
	maxSpendShare  = 0.75  // draughts, potions and ammo: at most this share of the loot
	healBelowPct   = 50    // a self-heal under this % of health...
	potionBelowPct = 33    // ...and a health potion under this one
	npcBuyShare    = 1.0 / 3
)

// hunterKit is what a hunter of a vocation carries at a level.
type hunterKit struct {
	weapon, ammo string
	armor        []string
	shield       string // "" with a two-handed weapon
}

// armorAt is the armor and shield of the guardian's kit at level (kitFor): the ranger's
// too, the other vocation the heavy torso pieces of the compact catalog are for (lote 11).
func armorAt(level int) ([]string, string) {
	k := kitFor(level)
	return k.armor, k.shield
}

// robesAt is a caster's armor at level: the guardian's kit with the light torso line of
// the catalog (the robes) in place of the heavy one, and the same shield.
func robesAt(level int) ([]string, string) {
	switch {
	case level >= 30:
		return []string{"embersteel_helm", "ashweave_robe", "embersteel_greaves", "embersteel_sabatons", "cinder_amulet"},
			"embersteel_shield"
	case level >= 15:
		return []string{"stagleather_hood", "mossweave_robe", "stagleather_leggings", "stagleather_boots", "antler_amulet"},
			"elmwood_shield"
	}
	return armorAt(level) // bands 1 and 2: the same clothes for everyone
}

// tier is a weapon of a line from its band's level.
type tier struct {
	from   int
	weapon string
}

// weaponAt is the weapon of line at level.
func weaponAt(line []tier, level int) string {
	w := ""
	for _, t := range line {
		if level >= t.from {
			w = t.weapon
		}
	}
	return w
}

// casterLines: the wand and staff lines of the casters, one per band (lote 11).
var casterLines = map[string][]tier{
	"arcanist": {{1, "spark_wand"}, {5, "coral_wand"}, {10, "stormglass_wand"}, {30, "obsidian_wand"}},
	"druid":    {{1, "sapling_staff"}, {5, "rimewood_staff"}, {10, "hoarfrost_staff"}, {30, "blackfrost_staff"}},
}

// casterKit: the wand or staff line of each caster (content audit M3, m5) and the robes.
func casterKit(voc string, level int) hunterKit {
	k := hunterKit{weapon: weaponAt(casterLines[voc], level)}
	k.armor, k.shield = robesAt(level)
	return k
}

// bowLine and crossbowLine: the ranger's bows (two hands, no shield) and crossbows, each
// from the level it asks for, like every kit of the sims (TestKitWeaponsFromTheirLevel).
var (
	bowLine      = []tier{{1, "short_bow"}, {5, "yew_longbow"}, {10, "thornwood_longbow"}, {30, "embersteel_longbow"}}
	crossbowLine = []tier{{10, "smuggler_crossbow"}, {30, "embersteel_crossbow"}}
)

// bowKit: the ranger's two-handed bows (no shield).
func bowKit(level int) hunterKit {
	k := hunterKit{weapon: weaponAt(bowLine, level), ammo: "arrow"}
	k.armor, _ = armorAt(level)
	return k
}

// crossbowKit: the ranger's one-handed crossbows and a shield (content audit M4); before
// the first crossbow (band 3, level 10) it is the bow kit.
func crossbowKit(level int) hunterKit {
	if level < crossbowLine[0].from {
		return bowKit(level)
	}
	k := hunterKit{weapon: weaponAt(crossbowLine, level), ammo: "bolt"}
	k.armor, k.shield = armorAt(level)
	return k
}

// TestVocationKitsAreTheCatalogs: every kit of the careers is wearable at its level by
// its vocation (TestGuardianKitIsTheCatalogs does the guardian's).
func TestVocationKitsAreTheCatalogs(t *testing.T) {
	d := loadData(t)
	for level := 1; level < careerTo; level++ {
		for voc, kit := range map[string]hunterKit{
			"arcanist": casterKit("arcanist", level), "druid": casterKit("druid", level),
			"ranger": crossbowKit(level),
		} {
			d.wearable(t, voc, level, append([]string{kit.weapon, kit.shield}, kit.armor...)...)
		}
		b := bowKit(level)
		d.wearable(t, "ranger", level, append([]string{b.weapon}, b.armor...)...)
	}
}

// TestKitWeaponsFromTheirLevel: every kit of the sims takes a weapon at the level it asks
// for, not later. The sims model no purchase (the guardian's iron sword and every band 2
// weapon come at level 5, though chapter 1's coins pay for them at ~6-7): a weapon taken
// later than its level would hide what the catalog's piece does at its level, as the band 2
// longbow bought at 8 did (review of lote 11).
func TestKitWeaponsFromTheirLevel(t *testing.T) {
	d := loadData(t)
	kits := map[string]func(int) string{
		"guardian":        func(l int) string { return kitFor(l).weapon },
		"arcanist":        func(l int) string { return casterKit("arcanist", l).weapon },
		"druid":           func(l int) string { return casterKit("druid", l).weapon },
		"bow ranger":      func(l int) string { return bowKit(l).weapon },
		"crossbow ranger": func(l int) string { return crossbowKit(l).weapon },
	}
	for name, weaponAt := range kits {
		checked := map[string]bool{}
		for level := 1; level < careerTo; level++ {
			w := weaponAt(level)
			if checked[w] {
				continue
			}
			checked[w] = true
			from := max(1, d.item(t, w).Requires.Level)
			if got := weaponAt(from); got != w {
				t.Errorf("%s kit: %s asks for level %d but the kit holds %s there (it takes it later)", name, w, from, got)
			}
		}
	}
}

// commonTargets is every common monster of the three islands and its target level.
func commonTargets() map[string]int {
	out := map[string]int{}
	for _, m := range []map[string]int{targetLevel, bosqueTargetLevel, volcanTargetLevel} {
		for id, l := range m {
			out[id] = l
		}
	}
	return out
}

type habit int

const (
	frugal habit = iota
	budget
	full
	// dry: no mana draught at all, not even for a heal (frugal drinks for one), only
	// regeneration and food: the guardian that buys none, whose magic level must still
	// reach its spells (review of the spell progression, 2026-11).
	dry
)

// draughtHabits are the habits a career picks from by default.
var draughtHabits = []habit{frugal, budget, full}

func (h habit) String() string { return [...]string{"frugal", "budget", "full", "dry"}[h] }

// budgetShare is what a hunter of the budget habit spends on draughts, at most, out of
// what the hunt has earned so far.
const budgetShare = 0.6

// hunter is a character of a vocation at a level, with its magic level and kit.
type hunter struct {
	d                   *balanceData
	voc                 content.Vocation
	level, magic, skill int
	weapon, ammo        *content.Item
	armor, shield       int
	// kit is what it wears: each fight rolls their attributes (gear_test.go). magicBonus
	// is the kit's mean magic level attribute, for ranking the spells (it raises what they
	// do, never what they require).
	kit            []*content.Item
	magicBonus     int
	attacks, heals []*content.Spell
	conjure        *content.Spell // conjures the ammo (the ranger's arrows)
	regenPct       int            // extra regeneration while fed (balance.yaml well_fed)
	draught        *content.Item
	potions        []*content.Item // health potions the shops of its level sell, biggest first
	food           *content.Item   // eaten all along: what keeps well_fed going
}

func (d *balanceData) hunter(t *testing.T, voc string, level, magic int, k hunterKit) *hunter {
	t.Helper()
	h := &hunter{d: d, voc: d.vocations[voc], level: level, magic: magic,
		skill: skillStart + int(math.Floor(skillPerLevel*float64(level-1)))}
	h.weapon = d.item(t, k.weapon)
	if k.ammo != "" {
		h.ammo = d.item(t, k.ammo)
	}
	for _, id := range k.armor {
		h.armor += d.item(t, id).Armor.Armor
	}
	h.kit = append(h.kit, h.weapon)
	for _, id := range k.armor {
		h.kit = append(h.kit, d.item(t, id))
	}
	shieldID := ""
	if k.shield != "" && h.weapon.Weapon.Hands < 2 {
		h.shield = d.item(t, k.shield).Shield.Defense
		shieldID = k.shield
		h.kit = append(h.kit, d.item(t, k.shield))
	}
	h.magicBonus = round(d.gearMean(t, append([]string{k.weapon, shieldID}, k.armor...)...).skill["magic"])
	for _, id := range d.spells.IDs() {
		s := d.spells[id]
		if !s.CastBy(voc) || s.Level > level || s.MagicLevel > magic {
			continue
		}
		switch {
		case s.Effect.Damage != nil:
			h.attacks = append(h.attacks, s)
		case s.Effect.Heal != nil && s.Effect.Heal.Range == 0:
			h.heals = append(h.heals, s)
		case s.Effect.Conjure != nil && k.ammo != "" && s.Effect.Conjure.Item == k.ammo:
			h.conjure = s
		}
	}
	if c := d.balance.Conditions[fedCondition]; c != nil {
		h.regenPct = c.RegenPct
	}
	h.draught = d.item(t, "mana_draught")
	if level >= 30 { // Cinderstead sells the concentrated one: a hunter there carries it
		h.draught = d.item(t, "concentrated_mana_draught")
	}
	// Health potions by island, like the mana draughts: the Bosque sells the health
	// draught (its hunts start at level 11-12), Cinderstead also the concentrated one.
	if level >= 30 {
		h.potions = append(h.potions, d.item(t, "concentrated_health_draught"))
	}
	if level >= 12 {
		h.potions = append(h.potions, d.item(t, "health_draught"))
	}
	h.potions = append(h.potions, d.item(t, "seaweed_poultice"))
	h.food = d.item(t, "ship_biscuit") // the cheapest food per minute, sold in Puerto
	return h
}

// potion is the health potion h drinks with missing health: the biggest that heals no
// more than that (nothing wasted, as a player would pick), or the smallest.
func (h *hunter) potion(missing float64) *content.Item {
	for _, p := range h.potions {
		if float64(p.Consumable.HealHP) <= missing {
			return p
		}
	}
	return h.potions[len(h.potions)-1]
}

// fedCondition is the condition food gives (content audit m2).
const fedCondition = "well_fed"

// amount is the average of a spell scaling for h, without spread.
func (h *hunter) amount(s content.Scaling) float64 {
	v := s.Base + float64(h.level)*s.PerLevel + float64(h.magic+h.magicBonus)*s.PerMagicLevel
	if s.Skill != "" {
		v += float64(h.skill) * s.PerSkill
	}
	return v
}

// expected is the average damage of attack spell s on m.
func (h *hunter) expected(s *content.Spell, m *content.Monster) float64 {
	d := s.Effect.Damage
	return h.amount(d.Scaling) * (1 - float64(min(m.Resistances[d.Element], 100))/100)
}

// hunt is what a series of duels against one monster gave.
type hunt struct {
	monster       string
	habit         habit
	secondsPerKil float64 // fight plus overhead
	damagePct     float64 // health lost per fight, % of max
	deaths        float64 // per fight
	low           float64 // share of fights that took the hunter under healBelowPct
	manaPerKill   float64 // spent on spells (magic level tries)
	spendPerKill  float64 // copper: draughts, potions and ammo
	lootPerKill   float64 // copper: coins plus a third of the items' value
	draughts      float64 // per kill: mana draughts, health potions and ammo bought
	potions       float64
	ammoBought    float64
	xpPerHour     float64
	casts         map[string]float64 // per kill, by spell id
	potionsBy     map[string]float64 // health potions drunk per kill, by item id
}

func (u hunt) affordable() bool {
	return u.deaths <= maxDeaths && u.spendPerKill <= maxSpendShare*u.lootPerKill
}

// hunt runs careerFights duels of h against m with habit hb.
func (h *hunter) hunt(m *content.Monster, hb habit, seed uint64) hunt {
	r := rand.New(rand.NewPCG(seed, uint64(h.level)<<8|uint64(hb)))
	c := h.d.balance.Combat
	balanced := c.Modes["balanced"]
	stats := h.voc.AtLevel(h.level)
	regen := h.voc.Regen
	tickHP, tickMP := regen.Tick(h.regenPct) // the server's integer formula
	// Each fight is the kit with its own rolled attributes (gear_test.go): over the fights,
	// the kit's mean. wear rolls it: maximums, armor and defense, regeneration, the skill,
	// magic level and attack the attacks use, leech and protection.
	var g gearMean
	var maxHP, maxMP, regenHP, regenMP float64
	var player combat.PlayerTarget
	var skill, magic, attack int
	var hp, mp float64
	var f *foe
	wear := func() {
		g = h.d.rollGear(r, h.kit...)
		maxHP, maxMP = float64(stats.Health)+g.health, float64(stats.Mana)+g.mana
		player = combat.PlayerTarget{Armor: h.armor + int(g.armor), Defense: h.shield + int(g.defense) + h.weapon.Weapon.Defense,
			ModeDefense: balanced.Defense}
		regenHP, regenMP = float64(tickHP)+g.regenHP, float64(tickMP)+g.regenMP
		skill, magic, attack = h.skill+int(g.skill[h.weapon.Weapon.Type]), h.magic+int(g.skill["magic"]), int(g.attack)
		hp, mp = math.Min(hp, maxHP), math.Min(mp, maxMP)
	}
	// shot lands a weapon hit of dmg on the foe and gives the leech attributes' share of
	// what it dealt back (the server's integer leech, up to the maximums).
	shot := func(now, dmg int) {
		dealt := f.hit(now, dmg)
		hp = math.Min(maxHP, hp+float64(dealt*int(g.lifeLeech)/100))
		mp = math.Min(maxMP, mp+float64(dealt*int(g.manaLeech)/100))
	}
	wear()
	useMs := h.d.balance.Inventory.UseCooldownMs

	// Spells sorted by what they do on m; the best ready and affordable one is cast.
	attacks := slices.Clone(h.attacks)
	slices.SortStableFunc(attacks, func(a, b *content.Spell) int {
		return -cmpFloat(h.expected(a, m), h.expected(b, m))
	})
	attacks = slices.DeleteFunc(attacks, func(s *content.Spell) bool { return h.expected(s, m) <= 0 })
	heals := slices.Clone(h.heals)
	slices.SortStableFunc(heals, func(a, b *content.Spell) int {
		return -cmpFloat(h.amount(a.Effect.Heal.Scaling), h.amount(b.Effect.Heal.Scaling))
	})
	reserve := 0.0
	if len(heals) > 0 {
		reserve = float64(heals[0].Mana)
	}

	hp, mp = maxHP, maxMP
	var mana, spend, loot, damage, deaths, low float64
	stock := 0 // conjured ammo left
	var nDraught, nPotion, nAmmo float64
	casts, potionsBy := map[string]float64{}, map[string]float64{}
	perKill := h.d.huntLoot(m)
	// mayDrink: a draught for an attack spell (or to refill between fights) fits the habit.
	mayDrink := func() bool {
		switch hb {
		case full:
			return true
		case budget:
			return spend+float64(h.draught.Value) <= budgetShare*(loot+perKill)
		}
		return false
	}
	totalMs := 0
	f = newFoe(m, h.d.monsters, c, r) // its abilities and summons: foe_test.go
	ready := map[string]int{}
	for range careerFights {
		wear() // this fight's kit
		f.protect = g.protect
		f.start(0)
		now, nextShot, nextAttackGroup, nextHealGroup, nextUse := 0, 0, 0, 0, 0
		nextRegen := regen.IntervalMs
		for k := range ready {
			ready[k] = 0
		}
		lost := 0.0
		wounded := false       // under healBelowPct in this fight: a self-heal had its occasion
		drink := func() bool { // a mana draught, if the habit and the consumable cooldown allow
			if hb == dry || now < nextUse || mp >= maxMP {
				return false
			}
			nextUse = now + useMs
			mp = math.Min(maxMP, mp+float64(h.draught.Consumable.HealMP))
			spend += float64(h.draught.Value)
			nDraught++
			return true
		}
		for f.alive() && now < maxFightMs {
			// Heal first: the healing group is apart from the attack group.
			if hp < maxHP*healBelowPct/100 {
				wounded = true
				healed := false
				if now >= nextHealGroup {
					for _, s := range heals {
						if now < ready[s.ID] {
							continue
						}
						if mp < float64(s.Mana) {
							drink()
						}
						if mp < float64(s.Mana) {
							break
						}
						mp -= float64(s.Mana)
						mana += float64(s.Mana)
						casts[s.ID]++
						hp = math.Min(maxHP, hp+float64(combat.Scaled(r, s.Effect.Heal.Scaling, h.level, magic, skill)))
						ready[s.ID] = now + s.CooldownMs
						nextHealGroup = now + s.GroupCooldownMs
						healed = true
						break
					}
				}
				if !healed && hp < maxHP*potionBelowPct/100 && now >= nextUse {
					p := h.potion(maxHP - hp)
					nextUse = now + useMs
					hp = math.Min(maxHP, hp+float64(p.Consumable.HealHP))
					spend += float64(p.Value)
					nPotion++
					potionsBy[p.ID]++
				}
			}
			if now >= nextShot {
				nextShot = now + c.AttackIntervalMs
				w := h.weapon.Weapon
				switch {
				case w.Type == "wand":
					shot(now, combat.Resist(combat.WandHit(r, w.Attack+attack, c.WandMinFactor), f.cur().Resistances[w.Element]))
				case h.ammo != nil: // a bow or crossbow and its ammo
					maxHit := combat.MaxHit(c, skill, w.Attack+h.ammo.Ammo.Attack+attack, h.level, balanced.Attack)
					shot(now, combat.HitMonster(r, maxHit, f.target()))
					if stock > 0 {
						stock--
					} else {
						spend += float64(h.ammo.Value)
						nAmmo++
					}
				default: // melee: the guardian's reference career
					shot(now, combat.HitMonster(r, combat.MaxHit(c, skill, w.Attack+attack, h.level, balanced.Attack), f.target()))
				}
			}
			if now >= nextAttackGroup && f.alive() {
				for _, s := range attacks {
					if now < ready[s.ID] {
						continue
					}
					keep := reserve
					if h.conjure != nil && stock < h.conjure.Effect.Conjure.Count {
						keep += float64(h.conjure.Mana) // arrows before spells
					}
					if mp < float64(s.Mana)+keep && mayDrink() {
						drink()
					}
					if hb == full {
						keep = 0
					}
					if mp < float64(s.Mana)+keep {
						continue
					}
					mp -= float64(s.Mana)
					mana += float64(s.Mana)
					casts[s.ID]++
					d := s.Effect.Damage
					f.hit(now, combat.Resist(combat.Scaled(r, d.Scaling, h.level, magic, skill), f.cur().Resistances[d.Element]))
					ready[s.ID] = now + s.CooldownMs
					nextAttackGroup = now + s.GroupCooldownMs
					break
				}
			}
			if !f.alive() {
				break
			}
			// The next event: a shot, a spell, a heal, a draught, a monster attack or regen.
			step := min(nextShot, nextRegen)
			if nextAttackGroup > now {
				step = min(step, nextAttackGroup)
			}
			step = min(step, max(nextHealGroup, now+50), max(nextUse, now+50))
			step = min(step, f.nextAt())
			now = max(step, now+50)
			for now >= nextRegen {
				hp = math.Min(maxHP, hp+regenHP)
				mp = math.Min(maxMP, mp+regenMP)
				nextRegen += regen.IntervalMs
			}
			dmg := float64(f.act(now, player))
			hp -= dmg
			lost += dmg
			if hp <= 0 {
				deaths++
				hp, mp = maxHP, maxMP
			}
		}
		totalMs += now
		damage += lost
		if wounded {
			low++
		}
		loot += h.d.huntLoot(m)
		if h.regenPct > 0 { // the food that kept well_fed going through fight and walk
			spend += float64(h.food.Value) * (float64(now) + overheadSeconds*1000) / float64(h.food.Consumable.FoodMs)
		}
		// Walking and looting: regeneration and draughts (as the habit allows) to start the
		// next fight ready; a frugal hunter drinks only for a heal it needs.
		ticks := int(overheadSeconds * 1000 / float64(regen.IntervalMs))
		hp = math.Min(maxHP, hp+float64(ticks)*regenHP)
		mp = math.Min(maxMP, mp+float64(ticks)*regenMP)
		for range int(overheadSeconds * 1000 / float64(max(useMs, 1))) {
			if mp >= maxMP-float64(h.draught.Consumable.HealMP) || !mayDrink() {
				break
			}
			mp = math.Min(maxMP, mp+float64(h.draught.Consumable.HealMP))
			spend += float64(h.draught.Value)
			nDraught++
		}
		// Ammo conjured with the mana regeneration left over (draughts would cost more
		// than buying it).
		for h.conjure != nil && stock < 2*h.conjure.Effect.Conjure.Count && mp >= float64(h.conjure.Mana)+reserve {
			mp -= float64(h.conjure.Mana)
			mana += float64(h.conjure.Mana)
			stock += h.conjure.Effect.Conjure.Count
		}
		for hp < maxHP*0.7 && len(heals) > 0 && mp >= float64(heals[0].Mana) { // patch up
			mp -= float64(heals[0].Mana)
			mana += float64(heals[0].Mana)
			casts[heals[0].ID]++
			hp = math.Min(maxHP, hp+h.amount(heals[0].Effect.Heal.Scaling))
		}
	}
	n := float64(careerFights)
	u := hunt{
		monster: m.ID, habit: hb,
		secondsPerKil: float64(totalMs)/n/1000 + overheadSeconds,
		damagePct:     100 * damage / n / maxHP,
		deaths:        deaths / n,
		low:           low / n,
		manaPerKill:   mana / n,
		spendPerKill:  spend / n,
		lootPerKill:   loot / n,
		draughts:      nDraught / n,
		potions:       nPotion / n,
		ammoBought:    nAmmo / n,
		casts:         casts,
		potionsBy:     potionsBy,
	}
	for id := range u.casts {
		u.casts[id] /= n
	}
	for id := range u.potionsBy {
		u.potionsBy[id] /= n
	}
	u.xpPerHour = float64(m.Experience) * 3600 / u.secondsPerKil
	return u
}

func cmpFloat(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// huntLoot is the average copper a kill of m is worth to a hunter: coins, and a third of
// the value of the items (what NPCs pay).
func (d *balanceData) huntLoot(m *content.Monster) float64 {
	sum := 0.0
	for _, l := range m.Loot {
		lo, hi := l.CountRange()
		v := float64(d.items[l.Item].Value)
		if d.items[l.Item].Currency == nil {
			v *= npcBuyShare
		}
		sum += l.Chance * float64(lo+hi) / 2 * v
	}
	return sum
}

// careerLevel is one level of a career: where and how it was hunted.
type careerLevel struct {
	level, magic int
	best         hunt
	hours        float64 // to the next level
	affordable   bool
}

type career struct {
	voc    string
	levels []careerLevel
}

// hoursTo sums the hours from level from to level to.
func (c career) hoursTo(from, to int) float64 {
	h := 0.0
	for _, l := range c.levels {
		if l.level >= from && l.level < to {
			h += l.hours
		}
	}
	return h
}

// magicAt is the magic level the career has on reaching level.
func (c career) magicAt(level int) int {
	for _, l := range c.levels {
		if l.level == level {
			return l.magic
		}
	}
	return c.levels[len(c.levels)-1].magic
}

// spendShare is what the hunts from level from to level to cost, over what they earned.
func (c career) spendShare(from, to int) float64 {
	spend, loot := 0.0, 0.0
	for _, l := range c.levels {
		if l.level >= from && l.level < to {
			kills := l.hours * 3600 / l.best.secondsPerKil
			spend += kills * l.best.spendPerKill
			loot += kills * l.best.lootPerKill
		}
	}
	return spend / max(loot, 1)
}

func (c career) String() string {
	var b strings.Builder
	for _, l := range c.levels {
		fmt.Fprintf(&b, "%s lvl %2d ml %2d  %-17s %-6s %5.1f s/kill %5.1f%% hp (%4.1f%% under half)  %6.0f xp/h  mana/kill %5.1f  spend %5.1f / loot %5.1f  %5.2f h%s\n",
			c.voc, l.level, l.magic, l.best.monster, l.best.habit, l.best.secondsPerKil, l.best.damagePct, 100*l.best.low,
			l.best.xpPerHour, l.best.manaPerKill, l.best.spendPerKill, l.best.lootPerKill, l.hours,
			map[bool]string{true: "", false: "  (unaffordable)"}[l.affordable])
		ids := make([]string, 0, len(l.best.casts))
		for id := range l.best.casts {
			ids = append(ids, id)
		}
		slices.Sort(ids)
		for _, id := range ids {
			fmt.Fprintf(&b, "    %s %.2f/kill", id, l.best.casts[id])
		}
		b.WriteString("\n")
	}
	return b.String()
}

// runCareer plays voc from level 1 to careerTo with the kit of kitAt, picking at each
// level among the habits given (draughtHabits when none is).
func (d *balanceData) runCareer(t *testing.T, voc string, kitAt func(int) hunterKit, habits ...habit) career {
	t.Helper()
	if len(habits) == 0 {
		habits = draughtHabits
	}
	cv := d.balance.Experience
	magic := d.balance.Skills.Base["magic"]
	factor := d.vocations[voc].SkillFactor("magic")
	ml := skills.Progress{Level: magic.StartLevel}
	targets := commonTargets()
	ids := make([]string, 0, len(targets))
	for id := range targets {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	out := career{voc: voc}
	for level := 1; level < careerTo; level++ {
		h := d.hunter(t, voc, level, ml.Level, kitAt(level))
		var best, fallback hunt
		for _, id := range ids {
			if targets[id] > level || targets[id] < level-15 {
				continue
			}
			for _, hb := range habits {
				u := h.hunt(d.monsters[id], hb, uint64(len(id)))
				if u.affordable() && u.xpPerHour > best.xpPerHour {
					best = u
				}
				if u.deaths <= maxDeaths && u.xpPerHour > fallback.xpPerHour {
					fallback = u
				}
			}
		}
		cl := careerLevel{level: level, magic: ml.Level, best: best, affordable: best.xpPerHour > 0}
		if !cl.affordable {
			cl.best = fallback
		}
		if cl.best.xpPerHour <= 0 {
			t.Fatalf("%s level %d: no monster to hunt", voc, level)
		}
		cl.hours = float64(cv.TotalFor(level+1)-cv.TotalFor(level)) / cl.best.xpPerHour
		kills := cl.hours * 3600 / cl.best.secondsPerKil
		ml.Add(magic, factor, int64(kills*cl.best.manaPerKill))
		out.levels = append(out.levels, cl)
	}
	if os.Getenv("DEBUG_BALANCE") != "" {
		t.Logf("career of the %s:\n%s", voc, out)
	}
	return out
}

func TestVocationCareers(t *testing.T) {
	d := loadData(t)
	// The guardian's career is the yardstick: the same harness with its melee kit.
	guardianKit := func(level int) hunterKit {
		k := kitFor(level)
		return hunterKit{weapon: k.weapon, armor: k.armor, shield: k.shield}
	}
	guardian := d.runCareer(t, "guardian", guardianKit)
	// The same guardian buying no mana draught, not even for a heal: the magic level of its
	// spells must not be a toll in gold (review of the spell progression, 2026-11).
	dryGuardian := d.runCareer(t, "guardian", guardianKit, dry)
	careers := map[string]career{
		"arcanist": d.runCareer(t, "arcanist", func(l int) hunterKit { return casterKit("arcanist", l) }),
		"druid":    d.runCareer(t, "druid", func(l int) hunterKit { return casterKit("druid", l) }),
		"ranger":   d.runCareer(t, "ranger", crossbowKit), // with a shield, as its description says
	}
	bowRanger := d.runCareer(t, "ranger", bowKit)
	vocs := []string{"arcanist", "druid", "ranger"}
	all := append([]string{"guardian"}, vocs...) // the checks of every career, the yardstick's too
	careers["guardian"] = guardian
	bands := [][2]int{{1, 8}, {8, 15}, {15, 20}, {20, 25}, {25, 30}, {30, 40}, {40, 50}}
	if os.Getenv("DEBUG_BALANCE") != "" {
		for _, b := range bands {
			line := fmt.Sprintf("levels %2d-%2d: guardian %6.2f h", b[0], b[1], guardian.hoursTo(b[0], b[1]))
			for _, v := range vocs {
				line += fmt.Sprintf("  %s %6.2f h (spend %3.0f%%)", v, careers[v].hoursTo(b[0], b[1]), 100*careers[v].spendShare(b[0], b[1]))
			}
			t.Log(line + fmt.Sprintf("  bow ranger %6.2f h", bowRanger.hoursTo(b[0], b[1])))
		}
		line := "guardian spend:"
		dryLine := "guardian without mana draughts:"
		for _, b := range bands {
			line += fmt.Sprintf("  %d-%d %3.0f%%", b[0], b[1], 100*guardian.spendShare(b[0], b[1]))
			dryLine += fmt.Sprintf("  %d-%d %5.2f h (%3.0f%%)", b[0], b[1], dryGuardian.hoursTo(b[0], b[1]), 100*dryGuardian.spendShare(b[0], b[1]))
		}
		t.Log(line)
		t.Log(dryLine)
		magicLine := func(name string, c career) {
			t.Logf("%s magic level: 8 -> %d, 20 -> %d, 30 -> %d, 40 -> %d, 49 -> %d", name,
				c.magicAt(8), c.magicAt(20), c.magicAt(30), c.magicAt(40), c.magicAt(49))
		}
		for _, v := range all {
			magicLine(v, careers[v])
		}
		magicLine("guardian without mana draughts", dryGuardian)
		t.Logf("whole career: guardian %.1f h, without mana draughts %.1f h", guardian.hoursTo(1, careerTo), dryGuardian.hoursTo(1, careerTo))
	}

	t.Run("pace near the guardian's", func(t *testing.T) {
		// No vocation levels much slower or faster than the tank on any band: the casters
		// trade gold (draughts) for speed, the ranger arrows for safety.
		for _, v := range vocs {
			for _, b := range bands {
				g, c := guardian.hoursTo(b[0], b[1]), careers[v].hoursTo(b[0], b[1])
				if r := c / g; r < 0.5 || r > 1.5 {
					t.Errorf("%s levels %d-%d in %.2f h, %.2f x the guardian's %.2f h (want 0.5-1.5)", v, b[0], b[1], c, r, g)
				}
			}
		}
	})

	t.Run("hunting pays for its draughts and ammo", func(t *testing.T) {
		for _, v := range all {
			for _, l := range careers[v].levels {
				// Levels 1-2: a ranger buys its first arrows (conjure_arrows is level 3).
				if !l.affordable && l.level >= 3 {
					t.Errorf("%s level %d: no hunt pays for itself (best %s %s: spend %.1f, loot %.1f per kill)",
						v, l.level, l.best.monster, l.best.habit, l.best.spendPerKill, l.best.lootPerKill)
				}
			}
			for _, b := range bands[1:] {
				if s := careers[v].spendShare(b[0], b[1]); s > maxSpendShare {
					t.Errorf("%s levels %d-%d spend %.0f %% of the loot (want <= %.0f %%)", v, b[0], b[1], 100*s, 100*maxSpendShare)
				}
			}
		}
	})

	t.Run("magic level from the mana really spent", func(t *testing.T) {
		want := map[string][4]int{ // magic level at 30 and at 49: [min30, max30, min49, max49]
			"guardian": {2, 7, 3, 9},
			"arcanist": {17, 26, 28, 42},
			"druid":    {17, 26, 28, 42},
			"ranger":   {4, 14, 7, 20},
		}
		for _, v := range all {
			w, c := want[v], careers[v]
			if m := c.magicAt(30); m < w[0] || m > w[1] {
				t.Errorf("%s: magic level %d at level 30 (want %d-%d)", v, m, w[0], w[1])
			}
			if m := c.magicAt(49); m < w[2] || m > w[3] {
				t.Errorf("%s: magic level %d at level 49 (want %d-%d)", v, m, w[2], w[3])
			}
			// Every spell's magic level is there within a few levels of its level (by the
			// career's last level for the spells of its last levels).
			for _, id := range d.spells.IDs() {
				s := d.spells[id]
				if !s.CastBy(v) || s.MagicLevel == 0 {
					continue
				}
				at := min(s.Level+4, careerTo-1)
				if m := c.magicAt(at); m < s.MagicLevel {
					t.Errorf("%s: %s needs magic level %d at level %d, the career has %d at level %d",
						v, id, s.MagicLevel, s.Level, m, at)
				}
			}
		}
	})

	t.Run("the guardian reaches its spells without mana draughts", func(t *testing.T) {
		// Review of the spell progression (2026-11): the guardian regenerates ~1 mana per
		// 7 s and trains magic slowly, so a magic level its regeneration never reaches made
		// its strikes a toll of hundreds of draughts. With regeneration and food alone it
		// has each spell's magic level within a few levels of the spell's level.
		for _, id := range d.spells.IDs() {
			s := d.spells[id]
			if !s.CastBy("guardian") || s.MagicLevel == 0 {
				continue
			}
			at := min(s.Level+4, careerTo-1)
			if m := dryGuardian.magicAt(at); m < s.MagicLevel {
				t.Errorf("%s needs magic level %d at level %d; without mana draughts the guardian has %d at level %d",
					id, s.MagicLevel, s.Level, m, at)
			}
		}
	})

	t.Run("every spell is affordable at its level and cast", func(t *testing.T) {
		// Spell progression (2026-11): the vocations keep learning up to level ~50.
		for _, v := range all {
			voc := d.vocations[v]
			single := false // v has a single-target attack spell
			for _, s := range d.spells {
				single = single || s.CastBy(v) && s.Effect.Damage != nil && s.Effect.Damage.Range > 0
			}
			for _, id := range d.spells.IDs() {
				s := d.spells[id]
				e := s.Effect
				if !s.CastBy(v) || e.Damage == nil && e.Heal == nil {
					continue
				}
				if s.Level >= careerTo {
					t.Errorf("%s: %s is level %d, past the career (%d): nothing checks it", v, id, s.Level, careerTo)
					continue
				}
				// A full pool at its level pays for two casts.
				if pool := voc.AtLevel(s.Level).Mana; 2*s.Mana > pool {
					t.Errorf("%s: %s costs %d mana, more than half of the %d of level %d", v, id, s.Mana, pool, s.Level)
				}
				// The hunts of its first levels cast it: every self-heal (under half health),
				// every single-target attack and, for a vocation without those (the guardian),
				// its areas. The casters' areas may wait for packs: in a duel an area hits
				// one monster and a cheaper bolt does as much.
				if e.Heal != nil && e.Heal.Range > 0 || e.Damage != nil && e.Damage.Radius > 0 && single {
					continue
				}
				casts, low := 0.0, 0.0
				for _, l := range careers[v].levels {
					if l.level >= s.Level && l.level <= s.Level+4 {
						casts += l.best.casts[id]
						low += l.best.low
					}
				}
				switch {
				case casts > 0:
				case e.Heal == nil || low > 0: // an attack, or a heal its hunts needed and lacked
					t.Errorf("%s: no hunt of levels %d-%d casts %s", v, s.Level, min(s.Level+4, careerTo-1), id)
				default:
					// A self-heal those hunts never had an occasion for: none took the hunter
					// under half its health. The ranger shoots from range, and with the band 2
					// longbow from level 5 Puerto's duels never do (review of lote 11): its
					// heal of level 4 is for packs and slips, which a duel does not model. It
					// must then serve the first hunt that does wound that far.
					first := careerLevel{}
					for _, l := range careers[v].levels {
						if l.level > s.Level+4 && l.best.low > 0 {
							first = l
							break
						}
					}
					switch {
					case first.level == 0:
						t.Errorf("%s: no hunt from level %d takes it under half its health: %s has no use", v, s.Level, id)
					case first.best.casts[id] == 0:
						t.Errorf("%s: level %d is the first hunt under half health past %s's level %d, and it does not cast it",
							v, first.level, id, s.Level)
					}
				}
			}
		}
	})

	t.Run("the health draughts serve past the poultice", func(t *testing.T) {
		// Spell progression (2026-11): a guardian of level 45 has ~760 health and the 40 of
		// the poultice no longer keeps up. From the Bosque on, a hunter under a third of its
		// health drinks a health draught...
		for _, v := range all {
			for _, level := range []int{20, 40} {
				h := d.hunter(t, v, level, careers[v].magicAt(level), hunterKit{weapon: "iron_sword"})
				hp := float64(h.voc.AtLevel(level).Health)
				if p := h.potion(hp * (100 - potionBelowPct) / 100); p.ID == "seaweed_poultice" {
					t.Errorf("%s level %d (%.0f health): drinks a %s", v, level, hp, p.ID)
				}
			}
		}
		// ...but the careers with mana draughts never get there in their duels: their heal
		// spells, fed by draughts, keep them over a third, and for less per point of health.
		// The draughts serve whoever heals without mana: the guardian that buys none drinks
		// each one where it is sold (potionsBy counts them by item), and its hunts pay for it.
		for _, p := range []struct {
			id   string
			from int // the level from which its shops are the hunter's
		}{{"health_draught", 12}, {"concentrated_health_draught", 30}} {
			drunk := 0.0
			for _, l := range dryGuardian.levels {
				if l.level >= p.from {
					drunk += l.best.potionsBy[p.id]
				}
			}
			if drunk == 0 {
				t.Errorf("the guardian without mana draughts drinks no %s from level %d", p.id, p.from)
			}
		}
		for _, l := range dryGuardian.levels {
			if !l.affordable && l.level >= 12 { // where it drinks them (level 1: food over a rat's loot)
				t.Errorf("the guardian without mana draughts, level %d: no hunt pays for itself (best %s: spend %.1f, loot %.1f per kill)",
					l.level, l.best.monster, l.best.spendPerKill, l.best.lootPerKill)
			}
		}
		for _, b := range bands[2:] {
			if s := dryGuardian.spendShare(b[0], b[1]); s > maxSpendShare {
				t.Errorf("the guardian without mana draughts, levels %d-%d: spends %.0f %% of the loot (want <= %.0f %%)",
					b[0], b[1], 100*s, 100*maxSpendShare)
			}
		}
		// About 0.5 copper per point: under the poultice's, over the mana draughts' 0.4.
		poultice := d.item(t, "seaweed_poultice")
		limit := float64(poultice.Value) / float64(poultice.Consumable.HealHP)
		for _, id := range []string{"health_draught", "concentrated_health_draught"} {
			it := d.item(t, id)
			if per := float64(it.Value) / float64(it.Consumable.HealHP); per >= limit || per < 0.4 {
				t.Errorf("%s: %.2f copper per point of health (want 0.40 to %.2f, the poultice's)", id, per, limit)
			}
		}
	})

	t.Run("crossbow and shield hold up against the bow", func(t *testing.T) {
		// Content audit M4: the one-handed crossbow leaves the left hand to a shield. It
		// hits less than the bow of its tier but takes less damage, and levels about as fast.
		for _, b := range bands[1:] {
			x, bow := careers["ranger"].hoursTo(b[0], b[1]), bowRanger.hoursTo(b[0], b[1])
			if r := x / bow; r > 1.3 {
				t.Errorf("levels %d-%d: the crossbow ranger takes %.2f x the bow ranger's time", b[0], b[1], r)
			}
		}
		// Health lost per second of fight against a monster of the level that hits back.
		for level, id := range map[int]string{14: "wreck_looter", 22: "coffer_smuggler", 36: "obsidian_delver", 46: "slag_golem"} {
			ml := careers["ranger"].magicAt(level)
			x := d.hunter(t, "ranger", level, ml, crossbowKit(level))
			bow := d.hunter(t, "ranger", level, ml, bowKit(level))
			if x.shield == 0 {
				t.Errorf("level %d: the crossbow kit has no shield", level)
			}
			hx, hb := x.hunt(d.monsters[id], budget, 7), bow.hunt(d.monsters[id], budget, 7)
			px := hx.damagePct / (hx.secondsPerKil - overheadSeconds)
			pb := hb.damagePct / (hb.secondsPerKil - overheadSeconds)
			if debug := os.Getenv("DEBUG_BALANCE") != ""; debug {
				t.Logf("level %d vs %s: crossbow %.2f %%/s (%.1f s), bow %.2f %%/s (%.1f s)", level, id, px, hx.secondsPerKil, pb, hb.secondsPerKil)
			}
			if px >= pb {
				t.Errorf("level %d vs %s: crossbow and shield lose %.2f %% health per second of fight, the bow %.2f %%",
					level, id, px, pb)
			}
		}
	})

	t.Run("each caster has an area its island does not resist", func(t *testing.T) {
		// Content audit M5: Volcán shrugs off fire (ember_ring), Bosque earth (bramble_burst).
		check := func(voc string, level int, island map[string]int, newID, oldID string) {
			h := d.hunter(t, voc, level, careers[voc].magicAt(level), casterKit(voc, level))
			newS, oldS := d.spells[newID], d.spells[oldID]
			if newS == nil || oldS == nil || newS.Effect.Damage == nil || newS.Effect.Damage.Radius == 0 {
				t.Fatalf("%s or %s is not an area spell", newID, oldID)
			}
			if newS.Level > level || newS.MagicLevel > h.magic {
				t.Errorf("%s: %s not castable at level %d (magic level %d)", voc, newID, level, h.magic)
			}
			for id := range island {
				m := d.monsters[id]
				if h.expected(newS, m) <= h.expected(oldS, m) {
					t.Errorf("%s level %d vs %s: %s does %.0f, no more than %s's %.0f",
						voc, level, id, newID, h.expected(newS, m), oldID, h.expected(oldS, m))
				}
			}
		}
		check("arcanist", 30, volcanTargetLevel, "tempest_ring", "ember_ring")
		check("druid", 18, bosqueTargetLevel, "rime_burst", "bramble_burst")
	})
}

// TestVocationSpellBands: vocation identity (owner's request, 2026-11-23). Every vocation
// learns a spell of its own (only it casts it) in each band of levels 1 to 30, and the
// spells several vocations share are support basics; the careers above cast each damage
// or heal spell in its first levels ("every spell is affordable at its level and cast").
func TestVocationSpellBands(t *testing.T) {
	d := loadData(t)
	bands := [][2]int{{1, 7}, {8, 15}, {16, 23}, {24, 30}}
	for _, v := range []string{"guardian", "arcanist", "ranger", "druid"} {
		for _, b := range bands {
			var own []string
			for _, id := range d.spells.IDs() {
				s := d.spells[id]
				if len(s.Vocations) == 1 && s.CastBy(v) && s.Level >= b[0] && s.Level <= b[1] {
					own = append(own, id)
				}
			}
			if len(own) == 0 {
				t.Errorf("%s learns no spell of its own in levels %d-%d", v, b[0], b[1])
			}
		}
	}
	for _, id := range d.spells.IDs() {
		s := d.spells[id]
		if len(s.Vocations) > 1 && (s.Effect.Damage != nil || s.Effect.Heal != nil || s.Level > 10) {
			t.Errorf("%s is shared by %v: shared spells are early support basics", id, s.Vocations)
		}
	}
}
