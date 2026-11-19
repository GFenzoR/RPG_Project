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
// saved at once so a crash cannot undo the death (deathSave: a link-dead player leaves
// the world with it).
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
	packDropped := false
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
			packDropped = packDropped || slot == int(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK)
			w.detach(it)
			if len(corpse.Item.items) < w.corpseItem.Slots() {
				it.parent = corpse.Item
				corpse.Item.items = append(corpse.Item.items, it)
			} else {
				w.drop(it, at)      // never lost (unreserved): only if the corpse had fewer slots than the equipment
				w.holdGround(p, it) // T5.3 fail-safe: reserved like the corpse while p is held
			}
			w.closeUnreachable(it)
		}
		w.equipmentChanged(p)
		w.addCorpse(ctx, at, corpse, w.playerCorpseFor)
		w.holdCorpse(p, corpse.Item) // T5.3 fail-safe: reserved while p's transfers wait (hold.go)
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

	if packDropped {
		w.newBackpack(p)
	}
	w.wakeAtTemple(ctx, p, false)
	w.sendInventory(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerSkills{PlayerSkills: &pb.PlayerSkills{Skills: w.skillList(p)}}})
	died := systemMsg(msgDied,
		&pb.TextParam{Name: "experience", Value: &pb.TextParam_Number{Number: lostXP}},
		&pb.TextParam{Name: "blessings", Value: &pb.TextParam_Number{Number: int64(blessings)}})
	p.emit(died)
	w.diedLinkDeadNotice(p, died)
	w.deathSave(ctx, p)
}

// newBackpack puts an empty inventory.start_container in p's backpack slot after a death
// dropped its backpack (only then: a character that took its backpack off and died would
// get backpacks for free): what the old backpack held stays in the corpse, but without a container a
// player can hold no coin and pick up nothing, so it could never buy another (the
// playtest's M5: a death above the novice levels left a character stuck for good).
func (w *World) newBackpack(p *Player) {
	slot := pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK
	if w.startContainer == nil || p.equip[slot] != nil {
		return
	}
	w.attach(p, newItem(w.startContainer, 1), place{kind: locSlot, slot: slot})
	w.econItem(p, EconDeath, "new_backpack", w.startContainer, 1)
	w.equipmentChanged(p)
}

// wakeAtTemple ends a death: full health and mana, no target, nobody attacking p, its
// fight over (no logout or sailing block; a PvP lock stays) and p at its residence temple.
func (w *World) wakeAtTemple(ctx *game.TickContext, p *Player, arena bool) {
	p.health, p.mana = p.maxHealth, p.maxMana
	p.target = nil
	p.fightAt = 0
	for _, m := range w.monsters {
		if m.target == p {
			m.setTarget(nil)
		}
	}
	w.pvpDied(ctx.Now, p, arena)
	temple := w.temple(p.town)
	to, ok := w.freeNear(temple, 3)
	if !ok {
		to = temple
	}
	if w.byClient[p.client] == p { // as Teleport: the ones who saw p see it die there
		w.relocate(p, to, goneDeath)
	}
}

// arenaDefeat is a death in a pvp zone at the hands of a player in it too (T5.2): no
// corpse, no loss of experience, skills, items or blessings; the conditions end, but for
// the food (well_fed: it was paid for, and an arena defeat costs nothing), and p wakes up
// at its temple.
func (w *World) arenaDefeat(ctx *game.TickContext, p *Player) {
	fed := 0
	if c := findCond(p.conds, foodCondition); c != nil {
		fed = w.leftMs(c)
	}
	w.clearConditions(ctx, holder{p: p}, false)
	if fed > 0 {
		w.feed(ctx, p, fed)
	}
	w.refreshSpeed(holder{p: p})
	w.wakeAtTemple(ctx, p, true)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	defeat := systemMsg(msgPvPArenaDefeat)
	p.emit(defeat)
	if _, died := w.diedAway[p.charID]; !died { // a death's notice says more: it stays
		w.diedLinkDeadNotice(p, defeat)
	}
	w.deathSave(ctx, p)
}

// reserved reports whether it lies in another player's corpse that is still reserved
// for its owner, so p cannot take it out, use it or put anything into it. Past
// corpse_owner_only_ms, a corpse its owner left while held stays reserved (hold.go,
// holdCorpse) until the database has the transfers it may come from, and for good if one
// was not stored (the owner is locked out until a restart). A corpse left before the hold
// is not: its items come from a state the database has.
func (w *World) reserved(tick game.Tick, p *Player, it *Item) bool {
	r := it.root()
	if !r.onGround {
		return false
	}
	for _, c := range w.corpses[r.pos] {
		if c.Item != r {
			continue
		}
		if c.Owner == 0 || c.Owner == p.charID {
			return false
		}
		if tick < c.OwnerUntil {
			return true
		}
		g, held := w.heldGround[r]
		return held && g.char == c.Owner
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
