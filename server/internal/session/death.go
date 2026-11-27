package session

import (
	"slices"
	"strings"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/skills"
)

// i18n keys of the death messages (i18n/*/client.yaml).
const (
	// msgDied: "You died", with "experience" (lost, number) and "blessings" (consumed).
	msgDied = "death.died"
	// msgDiedNovice goes before msgDied when the novice protection applied and nothing
	// dropped: "level" is death.novice_max_level, where the protection ends.
	msgDiedNovice = "death.novice"
	// msgNoviceBack follows msgDied when the death's lost level put the character back
	// under the novice protection ("level": death.novice_max_level).
	msgNoviceBack = "death.novice_back"
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
	// The level the novice protection reaches, if it covered this death. Taken from the
	// final drops: the notice promises that nothing falls, so a PvP mark that raised them
	// (possible only if the balance lets a novice fight players) silences it.
	noviceUntil := 0
	if skills.IsNovice(d, p.level) && pen.EquipmentDropPct == 0 && pen.BackpackDropPct == 0 {
		noviceUntil = d.NoviceMaxLevel
	}

	// Corpse with the dropped items, in slot order (deterministic with the seeded rand).
	// What the pockets hold falls with the backpack, on its roll, also without a backpack
	// (pockets.go): the pockets themselves are part of p and stay. The corpse has room for
	// all of it (playerCorpse): nothing falls loose next to it.
	if w.corpseItem != nil {
		corpse := &Corpse{Item: newItem(w.playerCorpse(p), 1), Owner: p.charID, OwnerUntil: ctx.Tick + w.corpseOwnerFor}
		corpse.Item.mods.BodyOf = p.name // "body of <player>" (docs/02 "Muerte")
		// The body lies the way the player faced, a woman's or a man's (docs/05 "Restos").
		corpse.Item.mods.Facing = fallFacing(p.dir)
		corpse.Item.mods.BodySex = p.look.Sex
		fall := func(it *Item) {
			w.econTree(p, EconDeath, "", it, -1)
			w.detach(it)
			it.parent = corpse.Item
			corpse.Item.items = append(corpse.Item.items, it)
			w.closeUnreachable(it)
		}
		for slot := 1; slot < equipSlots; slot++ {
			it := p.equip[slot]
			pack := slot == int(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK)
			pockets := pack && p.pockets != nil && len(p.pockets.items) > 0
			if it == nil && !pockets {
				continue
			}
			chance := pen.EquipmentDropPct
			if pack {
				chance = pen.BackpackDropPct
			}
			if chance <= 0 || ctx.Rand.Float64()*100 >= chance {
				continue
			}
			if it != nil {
				fall(it)
			}
			if pockets {
				// A copy: fall detaches each item from p.pockets.items while this walks it.
				for _, held := range slices.Clone(p.pockets.items) {
					fall(held)
				}
			}
		}
		w.equipmentChanged(p)
		w.addCorpse(ctx, at, corpse, w.playerCorpseFor)
		w.holdCorpse(p, corpse.Item) // T5.3 fail-safe: reserved while p's transfers wait (hold.go)
	}

	// Experience and skills.
	lostXP := p.experience - skills.LoseExperience(p.experience, pen.XPPct)
	p.experience -= lostXP
	noviceBack := false // the lost level put p back under the protection
	if level := skills.LevelFor(w.cfg.Balance.Experience, p.experience, 1); level != p.level {
		noviceBack = skills.NoviceNoticeFor(d, p.level, level) == skills.NoticeRegained
		p.level = level
		p.questDirty = true // the milestones' level marks of the quest log (questRecheck)
		stats := p.vocation.AtLevel(level)
		p.maxHealth, p.maxMana, p.capacity = stats.Health+p.gear.health, stats.Mana+p.gear.mana, stats.Capacity
		p.baseSpeed = w.mv.LevelSpeed(stats.Speed, level)
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

	// No free backpack (the playtest of 2026-11-19): p wakes up with its pockets, empty if
	// they fell with the backpack, where it can hold coins and pick things up again.
	w.wakeAtTemple(ctx, p, false)
	w.sendInventory(p)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerSkills{PlayerSkills: &pb.PlayerSkills{Skills: w.skillList(p)}}})
	died := systemMsg(msgDied,
		&pb.TextParam{Name: "experience", Value: &pb.TextParam_Number{Number: lostXP}},
		&pb.TextParam{Name: "blessings", Value: &pb.TextParam_Number{Number: int64(blessings)}},
		&pb.TextParam{Name: "novice_until", Value: &pb.TextParam_Number{Number: int64(noviceUntil)}})
	if noviceUntil > 0 {
		p.emit(systemMsg(msgDiedNovice, &pb.TextParam{Name: "level", Value: &pb.TextParam_Number{Number: int64(noviceUntil)}}))
	}
	p.emit(died)
	if noviceBack {
		p.emit(systemMsg(msgNoviceBack, &pb.TextParam{Name: "level", Value: &pb.TextParam_Number{Number: int64(d.NoviceMaxLevel)}}))
	}
	// Only death.died waits for a link-dead player: its novice_until carries the protection
	// to the death window, the two chat lines around it are lost.
	w.diedLinkDeadNotice(p, died)
	w.deathSave(ctx, p)
}

// playerCorpse returns the container p's death leaves: CorpseItem, with room for
// everything that may fall into it (a piece in each equipment slot and whatever the
// pockets hold, also past inventory.pocket_slots after a balance lowered it). Nothing
// falls loose next to the corpse, where its owner-only time would not cover it: a
// murderer or an outlaw may lose everything (docs/02 "Muerte"), ten pieces and four
// pockets where the monsters' remains have 10 places. A larger one is CorpseItem's
// definition with more slots (the same numeric id, sprite and name; the container window
// shows its capacity): a corpse is never saved (houseItems leaves it out), so nothing reads
// it back with fewer.
func (w *World) playerCorpse(p *Player) *content.Item {
	need := equipSlots - 1
	if p.pockets != nil {
		need += len(p.pockets.items)
	}
	if w.corpseItem.Slots() >= need {
		return w.corpseItem
	}
	if def := w.playerCorpseDef; def != nil && def.Slots() >= need {
		return def
	}
	def := *w.corpseItem
	def.Container = &struct {
		Slots int `yaml:"slots"`
	}{Slots: need}
	w.playerCorpseDef = &def
	return w.playerCorpseDef
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
