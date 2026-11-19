package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Item attributes (docs/02-game-design.md "Atributos de items"). Every equipable (a
// weapon, a shield or an armor piece: content.Rolls) carries its own Mods: exactly one
// attribute of data/attributes.yaml, rolled with the World's seeded source at every
// creation of the item (loot, shops, rewards, crafting, staff, the market's mailbox of an
// old offer) and kept by every path that moves it. An instance with mods never stacks.
// What the worn items' attributes add up to is Player.gear, recomputed with the
// equipment (equipmentChanged) and read by the formulas: maximums, attack, armor,
// defense, the skills fights use, speed, regeneration, elemental protection and leech.

// Mods is what makes one item instance different from another of its definition: its
// attribute (an id of data/attributes.yaml, "" none) with its value, and its refine level
// (the forge; 0 here). The zero value is a plain item.
type Mods struct {
	Attr   string
	Value  int
	Refine int
}

// Zero reports whether m is a plain item's.
func (m Mods) Zero() bool { return m == Mods{} }

// msg is m on the wire (nil for a plain item).
func (m Mods) msg() *pb.ItemMods {
	if m.Zero() {
		return nil
	}
	return &pb.ItemMods{Attribute: m.Attr, Value: int32(m.Value), Refine: uint32(max(m.Refine, 0))}
}

// modsOf reads mods sent by a client (nil: none). Only a comparison key: the server never
// takes a value from the client.
func modsOf(m *pb.ItemMods) Mods {
	if m == nil {
		return Mods{}
	}
	return Mods{Attr: m.GetAttribute(), Value: int(m.GetValue()), Refine: int(m.GetRefine())}
}

// Mods returns the instance's mods (tests and tools).
func (it *Item) Mods() Mods { return it.mods }

// instance builds count units of def with mods. An equipable that comes without an
// attribute (just created, or saved before attributes existed) rolls its one now.
func (w *World) instance(def *content.Item, count int, mods Mods) *Item {
	it := newItem(def, count)
	it.mods = mods
	if mods.Attr == "" && content.Rolls(def) {
		if a, v, ok := w.cfg.Attributes.Roll(w.rng, def); ok {
			it.mods.Attr, it.mods.Value = a.ID, v
		}
	}
	return it
}

// created is a new instance of count units of def: an equipable rolls its attribute.
func (w *World) created(def *content.Item, count int) *Item { return w.instance(def, count, Mods{}) }

// needsRoll reports whether loading s rolls an attribute (an equipable saved without one,
// at any depth): what was loaded that way must be saved again.
func (w *World) needsRoll(s ItemState) bool {
	if def := w.byNum[s.ItemID]; def != nil && s.Mods.Attr == "" && len(w.cfg.Attributes.For(def)) > 0 {
		return true
	}
	return slices.ContainsFunc(s.Items, w.needsRoll)
}

// ---- what the worn items give ------------------------------------------------------

// gearBonus is what the attributes of p's worn items add up to (each attribute at most
// its cap).
type gearBonus struct {
	health, mana           int
	attack, armor, defend  int
	speed                  int
	healthRegen, manaRegen int
	lifeLeech, manaLeech   int
	// skill by skill id (sword, axe, club, distance, magic) and protection % by element.
	skill   map[string]int
	protect map[string]int
}

// wornGear sums the attributes of p's equipment. Only what is worn counts: the backpack
// and its content do not.
func (w *World) wornGear(p *Player) gearBonus {
	var g gearBonus
	if len(w.cfg.Attributes) == 0 {
		return g
	}
	byAttr := map[string]int{}
	for slot, it := range p.equip {
		if it == nil || slot == int(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK) || it.mods.Attr == "" {
			continue
		}
		byAttr[it.mods.Attr] += it.mods.Value
	}
	for id, v := range byAttr {
		a := w.cfg.Attributes.ByID(id)
		if a == nil {
			continue // retired from the pool: the item keeps it, it does nothing
		}
		if a.Cap > 0 {
			v = min(v, a.Cap)
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
			g.defend += v
		case content.EffectSpeed:
			g.speed += v
		case content.EffectHealthRegen:
			g.healthRegen += v
		case content.EffectManaRegen:
			g.manaRegen += v
		case content.EffectLifeLeech:
			g.lifeLeech += v
		case content.EffectManaLeech:
			g.manaLeech += v
		case content.EffectSkill:
			if g.skill == nil {
				g.skill = map[string]int{}
			}
			g.skill[a.Skill] += v
		case content.EffectProtection:
			if g.protect == nil {
				g.protect = map[string]int{}
			}
			g.protect[a.Element] += v
		}
	}
	return g
}

// applyGear recomputes p.gear and what follows from it: the maximums (health and mana
// never above them), the armor and the speed. A player in the world is told what changed:
// its stats and health bar, its speed. The sums are only redone when the worn instances
// with an attribute changed (Player.gearFrom): spending ammo or a rune's charge does not
// redo them. A path that changes a worn instance's mods in place (the forge) clears
// gearFrom.
func (w *World) applyGear(p *Player) {
	var worn [equipSlots]*Item
	for slot, it := range p.equip {
		if it != nil && slot != int(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK) && it.mods.Attr != "" {
			worn[slot] = it
		}
	}
	if worn != p.gearFrom {
		p.gear, p.gearFrom = w.wornGear(p), worn
	}
	g := p.gear
	before := healthPercent(p.health, p.maxHealth)
	was := [4]int{p.health, p.mana, p.maxHealth, p.maxMana}
	stats := p.vocation.AtLevel(p.level)
	p.maxHealth, p.maxMana = stats.Health+g.health, stats.Mana+g.mana
	p.health, p.mana = min(p.health, p.maxHealth), min(p.mana, p.maxMana)
	p.armor += g.armor
	if w.byChar[p.charID] != p {
		p.speed = withPct(p.baseSpeed+g.speed, speedPct(p.conds)) // joining: nobody to tell yet
		return
	}
	w.refreshSpeed(holder{p: p})
	if was != [4]int{p.health, p.mana, p.maxHealth, p.maxMana} {
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
		if p.health > 0 {
			w.healthBar(p, before)
		}
	}
}

// protected is dmg of element after p's protection against it (an elemental hit; armor
// and the hands never stop magic).
func protected(p *Player, element string, dmg int) int {
	if pct := p.gear.protect[element]; pct > 0 && dmg > 0 {
		return dmg - dmg*min(pct, 100)/100
	}
	return dmg
}

// leech gives p back the share of dmg its worn leech attributes say: a weapon's hit
// (melee, shot or wand) that dealt dmg. Nothing for a dead p.
func (w *World) leech(p *Player, dmg int) {
	if dmg <= 0 || p.health <= 0 || p.gear.lifeLeech <= 0 && p.gear.manaLeech <= 0 {
		return
	}
	hp := min(dmg*p.gear.lifeLeech/100, p.maxHealth-p.health)
	mp := min(dmg*p.gear.manaLeech/100, p.maxMana-p.mana)
	if hp <= 0 && mp <= 0 {
		return
	}
	pct := healthPercent(p.health, p.maxHealth)
	p.health += max(hp, 0)
	p.mana += max(mp, 0)
	w.healthBar(p, pct)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
}
