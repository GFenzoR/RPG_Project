package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// SetHealth sets a monster's health (tests only).
func (m *Monster) SetHealth(h int) { m.health = h }

// EquipForTest gives p a weapon and a shield until equipment exists (T1.8).
func (p *Player) EquipForTest(weapon, shield *content.Item) { p.weapon, p.shield = weapon, shield }

// Level returns p's level (tests only).
func (w *World) Level(p *Player) int { return p.level }

// Mana returns p's mana (tests only).
func (w *World) Mana(p *Player) int { return p.mana }

// MonsterHealth returns m's health (tests only).
func (w *World) MonsterHealth(m *Monster) int { return m.health }

// DropForTest puts count units of def on the ground at pos (tests only, loop goroutine).
func (w *World) DropForTest(def *content.Item, count int, pos world.Pos) {
	w.drop(newItem(def, count), pos)
	w.tileChanged(pos)
}

// Viewers returns how many players have container it open (tests only).
func (it *Item) Viewers() int { return len(it.viewers) }

// GroundAt returns the runtime items on pos, bottom first (tests only).
func (w *World) GroundAt(pos world.Pos) []*Item { return w.ground[pos] }

// CountItem returns how many units of item id p carries, equipment included (tests).
func (w *World) CountItem(p *Player, id string) int { return w.countItem(p, w.cfg.Items[id], true) }

// Money returns the money p carries (tests only).
func (w *World) Money(p *Player) int64 { return w.money(p) }

// GiveForTest puts n units of item id in p's backpack (tests only, loop goroutine).
func (w *World) GiveForTest(p *Player, id string, n int) { w.giveItem(p, w.cfg.Items[id], n) }

// RestoreForTest refills p's health (tests only, loop goroutine).
func (w *World) RestoreForTest(p *Player) { p.health = p.maxHealth }

// DieForTest kills p now (as if a monster had taken its last hit point).
func (w *World) DieForTest(ctx *game.TickContext, p *Player) { w.die(ctx, p) }

// MaxMana returns p's maximum mana.
func (p *Player) MaxMana() int { return p.maxMana }

// Map returns the world's map.
func (w *World) Map() *world.Map { return w.m }

// SetHealthForTest sets p's health (tests only, loop goroutine).
func (p *Player) SetHealthForTest(h int) { p.health = h }

// ApplyConditionForTest gives p (or, if p is nil, m) condition a from source (tests only,
// loop goroutine). It reports whether it took (chance, immunity).
func (w *World) ApplyConditionForTest(ctx *game.TickContext, p *Player, m *Monster, a *content.ConditionApply, source uint32) bool {
	if p != nil {
		return w.applyCondition(ctx, holder{p: p}, a, source)
	}
	return w.applyCondition(ctx, holder{m: m}, a, source)
}

// ConditionsForTest returns p's conditions: id → hits left (damage) or ms left (others).
func (w *World) ConditionsForTest(p *Player) map[string]int {
	out := map[string]int{}
	for _, c := range p.conds {
		if c.ticks > 0 {
			out[c.def.ID] = c.ticks
		} else {
			out[c.def.ID] = w.leftMs(c)
		}
	}
	return out
}

// MonsterConditionsForTest returns the ids of m's conditions.
func (m *Monster) MonsterConditionsForTest() []string {
	var out []string
	for _, c := range m.conds {
		out = append(out, c.def.ID)
	}
	return out
}

// CombatSkillForTest is p's skill level as combat uses it (with keen_eye).
func (w *World) CombatSkillForTest(p *Player, id string) int { return w.combatSkill(p, id) }

// DamageShareForTest is the damage creature id dealt to m (its experience share).
func (m *Monster) DamageShareForTest(id uint32) int {
	for _, d := range m.damage {
		if d.player == id {
			return d.amount
		}
	}
	return 0
}
