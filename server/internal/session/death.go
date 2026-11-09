package session

import (
	"strings"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/skills"
)

// i18n keys of the death messages (i18n/*/client.yaml).
const (
	// msgDied: "You died", with "experience" (lost, number) and "blessings" (consumed).
	msgDied = "death.died"
	// msgNotOwner: another player's corpse is still reserved for its owner.
	msgNotOwner = "death.corpse_not_owner"
)

// Blessings returns how many blessings p holds (bless.<id> storage values).
func (w *World) Blessings(p *Player) int {
	n := 0
	for k, v := range p.storage.Values() {
		if v != 0 && strings.HasPrefix(k, blessKey) {
			n++
		}
	}
	return n
}

// die is a player's death (docs/02-game-design.md, "Muerte"): items fall into its
// corpse, it loses experience and skills by the blessings it held (which it loses),
// and wakes up at its residence temple with full health and mana. The new state is
// saved at once so a crash cannot undo the death.
func (w *World) die(ctx *game.TickContext, p *Player) { w.dieBy(ctx, p, nil) }

// dieBy is die with the player whose hit killed p (nil for a monster or the world).
func (w *World) dieBy(ctx *game.TickContext, p, killer *Player) {
	d := w.cfg.Balance.Death
	at := p.pos
	p.recordEvent(ctx.Tick, eventDied, "", 0, 0)
	w.cancelTrade(p, tradeCancelDied) // T5.3
	// T5.2: the players that took part get the kill; a defeat in an arena costs nothing.
	if w.pvpDeath(ctx, p, killer) {
		w.arenaDefeat(ctx, p)
		return
	}
	blessings := w.Blessings(p)
	pen := skills.DeathPenalty(d, blessings, p.level)
	// T5.2: a murderer or an outlaw drops more, whatever its blessings.
	pen.EquipmentDropPct, pen.BackpackDropPct = w.deathDrop(ctx.Now, p, pen.EquipmentDropPct, pen.BackpackDropPct)

	// Corpse with the dropped items, in slot order (deterministic with the seeded rand).
	if w.corpseItem != nil {
		corpse := &Corpse{Item: newItem(w.corpseItem, 1), Owner: p.charID, OwnerUntil: ctx.Tick + w.corpseOwnerFor}
		for slot := 1; slot < equipSlots; slot++ {
			it := p.equip[slot]
			if it == nil {
				continue
			}
			chance := pen.EquipmentDropPct
			if slot == int(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK) {
				chance = pen.BackpackDropPct
			}
			if chance <= 0 || ctx.Rand.Float64()*100 >= chance {
				continue
			}
			w.econTree(p, EconDeath, "", it, -1)
			w.detach(it)
			if len(corpse.Item.items) < w.corpseItem.Slots() {
				it.parent = corpse.Item
				corpse.Item.items = append(corpse.Item.items, it)
			} else {
				w.drop(it, at) // never lost (unreserved): only if the corpse had fewer slots than the equipment
			}
			w.closeUnreachable(it)
		}
		w.equipmentChanged(p)
		w.addCorpse(ctx, at, corpse, w.playerCorpseFor)
	}

	// Experience and skills.
	lostXP := p.experience - skills.LoseExperience(p.experience, pen.XPPct)
	p.experience -= lostXP
	if level := skills.LevelFor(w.cfg.Balance.Experience, p.experience, 1); level != p.level {
		p.level = level
		stats := p.vocation.AtLevel(level)
		p.maxHealth, p.maxMana, p.capacity = stats.Health, stats.Mana, stats.Capacity
		p.baseSpeed = max(stats.Speed, 1)
	}
	// A death ends every condition (T3.2): the speed returns to its base, an invisible
	// player shows up again before it is teleported.
	w.clearConditions(ctx, holder{p: p}, false)
	w.refreshSpeed(holder{p: p})
	for i, id := range w.skillIDs {
		p.skills[i].Lose(w.cfg.Balance.Skills.Base[id], p.vocation.SkillFactor(id), pen.SkillPct)
		p.skills[i].carry = 0
	}
	for k := range p.storage.Values() {
		if strings.HasPrefix(k, blessKey) {
			p.storage.Set(k, 0)
		}
	}

	w.wakeAtTemple(ctx, p, false)
	w.sendInventory(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerSkills{PlayerSkills: &pb.PlayerSkills{Skills: w.skillList(p)}}})
	p.emit(systemMsg(msgDied,
		&pb.TextParam{Name: "experience", Value: &pb.TextParam_Number{Number: lostXP}},
		&pb.TextParam{Name: "blessings", Value: &pb.TextParam_Number{Number: int64(blessings)}}))
	w.save(w.snapshot(p, false))
}

// wakeAtTemple ends a death: full health and mana, no target, nobody attacking p, and p
// at its residence temple.
func (w *World) wakeAtTemple(ctx *game.TickContext, p *Player, arena bool) {
	p.health, p.mana = p.maxHealth, p.maxMana
	p.target = nil
	for _, m := range w.monsters {
		if m.target == p {
			m.target = nil
		}
	}
	w.pvpDied(ctx.Now, p, arena)
	temple := w.temple(p.town)
	to, ok := w.freeNear(temple, 3)
	if !ok {
		to = temple
	}
	w.Teleport(p, to)
}

// arenaDefeat is a death in a pvp zone at the hands of a player in it too (T5.2): no
// corpse, no loss of experience, skills, items or blessings; the conditions end and p
// wakes up at its temple.
func (w *World) arenaDefeat(ctx *game.TickContext, p *Player) {
	w.clearConditions(ctx, holder{p: p}, false)
	w.refreshSpeed(holder{p: p})
	w.wakeAtTemple(ctx, p, true)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	p.emit(systemMsg(msgPvPArenaDefeat))
	w.save(w.snapshot(p, false))
}

// reserved reports whether it lies in another player's corpse that is still reserved
// for its owner, so p cannot take it out (or use it).
func (w *World) reserved(tick game.Tick, p *Player, it *Item) bool {
	r := it.root()
	if !r.onGround {
		return false
	}
	for _, c := range w.corpses[r.pos] {
		if c.Item == r {
			return c.Owner != 0 && c.Owner != p.charID && tick < c.OwnerUntil
		}
	}
	return false
}

// initDeath reads the corpse times of balance.yaml death.
func (w *World) initDeath() {
	d := w.cfg.Balance.Death
	w.playerCorpseFor = ticksFor(max(d.CorpseMs, 1))
	w.corpseOwnerFor = 0
	if d.CorpseOwnerOnlyMs > 0 {
		w.corpseOwnerFor = ticksFor(d.CorpseOwnerOnlyMs)
	}
}
