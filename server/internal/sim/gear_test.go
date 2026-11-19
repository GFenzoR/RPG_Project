package sim_test

import (
	"math"
	"math/rand/v2"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// Item attributes (docs/02 "Atributos de items"): every piece of a kit carries one random
// attribute, a bonus, so the duels give the hunter its kit's attributes and the band
// targets hold for ordinary rolls. The fights of the bestiaries draw a kit per fight
// (rollGear: the mean over the fights); a vocation's career takes the kit's mean
// (gearMean: each piece's content.Attributes.Mean, by effect, never above a cap), with the
// integer numbers of the formulas (attack, armor, defense, skills) rounded.

// gearMean is what a kit's attributes add on average.
type gearMean struct {
	health, mana, attack, armor, defense, regenHP, regenMP, lifeLeech, manaLeech float64
	// skill by skill id (magic = magic level) and protection % by element.
	skill   map[string]float64
	protect map[string]float64
}

// gearMean sums the mean attributes of the items ids (empty ids are skipped).
func (d *balanceData) gearMean(t *testing.T, ids ...string) gearMean {
	t.Helper()
	byAttr := map[string]float64{}
	for _, id := range ids {
		if id == "" {
			continue
		}
		for attr, v := range d.attrs.Mean(d.item(t, id)) {
			byAttr[attr] += v
		}
	}
	return d.gearOf(byAttr)
}

// rollGear is what one kit gives when each of the items defs rolls its attribute as the
// server does (content.Attributes.Roll): a duel that draws a kit per fight has, over its
// fights, the kit's mean attributes in the integer formulas as they are.
func (d *balanceData) rollGear(r *rand.Rand, defs ...*content.Item) gearMean {
	byAttr := map[string]float64{}
	for _, def := range defs {
		if a, v, ok := d.attrs.Roll(r, def); ok {
			byAttr[a.ID] += float64(v)
		}
	}
	return d.gearOf(byAttr)
}

// gearOf adds the attributes byAttr up by effect, each one at most its cap.
func (d *balanceData) gearOf(byAttr map[string]float64) gearMean {
	g := gearMean{skill: map[string]float64{}, protect: map[string]float64{}}
	for id, v := range byAttr {
		a := d.attrs.ByID(id)
		if a.Cap > 0 {
			v = math.Min(v, float64(a.Cap))
		}
		switch a.Effect {
		case content.EffectMaxHealth:
			g.health += v
		case content.EffectMaxMana:
			g.mana += v
		case content.EffectAttack:
			g.attack += v
		case content.EffectArmor:
			g.armor += v
		case content.EffectDefense:
			g.defense += v
		case content.EffectHealthRegen:
			g.regenHP += v
		case content.EffectManaRegen:
			g.regenMP += v
		case content.EffectLifeLeech:
			g.lifeLeech += v
		case content.EffectManaLeech:
			g.manaLeech += v
		case content.EffectSkill:
			g.skill[a.Skill] += v
		case content.EffectProtection:
			g.protect[a.Element] += v
		}
	}
	return g
}

func round(v float64) int { return int(math.Round(v)) }

// The pool is in the duels: a kit gets something from its attributes, and only what its
// pieces may roll.
func TestGearMeanOfAKit(t *testing.T) {
	d := loadData(t)
	k := kitFor(10)
	g := d.gearMean(t, append([]string{k.weapon, k.shield}, k.armor...)...)
	if g.health <= 0 || g.attack <= 0 || g.armor <= 0 || g.defense <= 0 || g.skill["sword"] <= 0 {
		t.Fatalf("a level 10 kit's mean attributes: %+v", g)
	}
	if g.skill["magic"] != 0 || g.skill["axe"] != 0 {
		t.Fatalf("a sword kit rolls magic or axe: %+v", g.skill)
	}
	wand := d.gearMean(t, "coral_wand")
	if wand.attack != 0 || wand.skill["magic"] <= 0 || wand.mana <= 0 {
		t.Fatalf("a wand's mean attributes: %+v", wand)
	}
}
