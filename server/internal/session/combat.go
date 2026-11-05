package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Effect ids of Effect.effect_id (docs/05-network-protocol.md). They are protocol
// constants until data/effects.yaml exists.
const (
	// EffectHit: a hit that dealt damage.
	EffectHit = 1
	// EffectBlock: a hit that armor or defense stopped completely (or a miss).
	EffectBlock = 2
)

// i18n keys of the system messages combat sends (i18n/*/client.yaml).
const (
	msgCannotAttack = "combat.cannot_attack"
	msgNoAmmo       = "combat.no_ammo"
	msgLoot         = "combat.loot"
	msgLootNone     = "combat.loot_none"
)

// combatSystem runs every tick after walking: players attack their targets, monsters in
// active sectors think, and (on the first tick) the map's spawns are populated.
func (w *World) combatSystem(ctx *game.TickContext) {
	if !w.spawned && len(w.slots) > 0 {
		w.spawnAll(ctx)
	}
	for _, p := range w.players {
		if p.target != nil {
			w.playerFight(ctx, p)
		}
	}
	if len(w.monsters) == 0 {
		return
	}
	// Only the monsters of active sectors are visited: idle parts of the world cost
	// nothing. A monster that steps into a later sector is not thought twice.
	w.markActive()
	slices.Sort(w.activeKeys)
	for _, k := range w.activeKeys {
		w.thinkBuf = append(w.thinkBuf[:0], w.msectors[k]...)
		for _, m := range w.thinkBuf {
			if m.thought != ctx.Tick {
				m.thought = ctx.Tick
				w.think(ctx, m)
			}
		}
	}
	clear(w.thinkBuf)
}

// ---- intents ---------------------------------------------------------------------

func (w *World) setTarget(p *Player, id uint32) {
	if id == 0 {
		p.target = nil
		return
	}
	m := w.monByID[id]
	if m == nil || !p.Knows(id) || m.pos.Z != p.pos.Z || w.inProtection(p.pos) || w.inProtection(m.pos) {
		// Players are not targets until PvP; NPCs never are.
		p.target = nil
		p.emit(systemMsg(msgCannotAttack))
		return
	}
	if m != p.afkTarget {
		// A different monster: the anti-AFK clock restarts. Re-targeting the same one
		// (even after clearing the target) keeps it, so it cannot be reset by the client.
		// Only then it is a recent event too: toggling the same target cannot flood the
		// report context (T4.1).
		p.afkTarget, p.answeredAt = m, 0
		p.recordEvent(w.nowTick(), eventAttack, m.kind.def.ID, 0, 0)
	}
	p.active(w.nowTick())
	p.target = m
}

func (w *World) setFightMode(p *Player, stance pb.FightStance, chase bool) {
	if stance < pb.FightStance_FIGHT_STANCE_OFFENSIVE || stance > pb.FightStance_FIGHT_STANCE_DEFENSIVE {
		return
	}
	p.stance, p.chase = stance, chase
}

// mode returns the balance.yaml factors of p's stance.
func (w *World) mode(p *Player) content.CombatMode {
	return w.cfg.Balance.Combat.Modes[content.Stances[p.stance-1]]
}

// ---- player attacks --------------------------------------------------------------

func (w *World) playerFight(ctx *game.TickContext, p *Player) {
	m := p.target
	if m.pos.Z != p.pos.Z || !Sees(p.pos, m.pos) {
		p.target = nil // out of view: the client got CreatureDisappear and drops it too
		return
	}
	if w.inProtection(p.pos) {
		return
	}
	if wp := p.weapon; wp != nil && wp.Weapon != nil {
		switch wp.Weapon.Type {
		case WeaponWand:
			w.wandFight(ctx, p, m)
			return
		case WeaponDistance:
			w.distanceFight(ctx, p, m)
			return
		}
	}
	if chebyshev(p.pos, m.pos) > 1 {
		if p.chase && !p.Walking() && ctx.Tick >= p.readyAt {
			if d, ok := w.chaseStep(p.pos, m.pos, false); ok {
				p.stopWalk()
				p.queue = append(p.queue, d)
			}
		}
		return
	}
	if ctx.Tick < p.nextAttack {
		return
	}
	p.nextAttack = ctx.Tick + w.attackFor
	// Every swing trains the weapon's skill, hit or miss (fists without a weapon).
	skill, attack := w.meleeSkill(p)
	maxHit := combat.MaxHit(w.cfg.Balance.Combat, max(w.combatSkill(p, skill), 1), attack, p.level, w.mode(p).Attack)
	w.train(p, skill, w.afk(ctx, p))
	w.damageMonster(ctx, m, p, combat.HitMonster(ctx.Rand, maxHit, m.kind.target), ElementPhysical)
}

// distanceFight is playerFight with a distance weapon (T3.1): every attack round, within
// weapon.range tiles and in line of sight, it spends one ammo of the weapon's weapon.ammo
// from the ammo slot and shoots it. The hit is physical, like melee, with the distance
// skill and attack = weapon + ammo; every shot trains distance, hit or miss. Without the
// right ammo it does not shoot and tells the player once per round.
func (w *World) distanceFight(ctx *game.TickContext, p *Player, m *Monster) {
	wp := p.weapon.Weapon
	if !w.rangedReady(ctx, p, m, wp.Range) {
		return
	}
	p.nextAttack = ctx.Tick + w.attackFor
	ammo := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_AMMO]
	if ammo == nil || ammo.def.Ammo == nil || ammo.def.Ammo.Type != wp.Ammo {
		p.emit(systemMsg(msgNoAmmo))
		return
	}
	attack := wp.Attack + ammo.def.Ammo.Attack
	maxHit := combat.MaxHit(w.cfg.Balance.Combat, max(w.combatSkill(p, SkillDistance), 1), attack, p.level, w.mode(p).Attack)
	w.train(p, SkillDistance, w.afk(ctx, p))
	w.useUp(p, ammo)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}}) // capacity
	w.projectile(p.pos, m.pos, ElementPhysical)
	w.damageMonster(ctx, m, p, combat.HitMonster(ctx.Rand, maxHit, m.kind.target), ElementPhysical)
}

// damageMonster applies one hit of player p, of element, to m.
func (w *World) damageMonster(ctx *game.TickContext, m *Monster, p *Player, dmg int, element string) {
	dmg = min(dmg, m.health)
	m.health -= dmg
	w.reveal(ctx, p) // T3.2: attacking ends invisibility
	w.markFight(ctx, p)
	if dmg > 0 {
		w.addShare(m, p.id, dmg)
		w.contribute(ctx, p)
	}
	w.hitEvents(m.id, m.pos, dmg, healthPercent(m.health, m.maxHealth), element)
	if m.health <= 0 {
		w.killMonster(ctx, m)
		return
	}
	if m.target == nil && w.validTarget(m, p) {
		m.target, m.state = p, StateAlert // even a passive monster fights back
	}
}

func (w *World) addShare(m *Monster, id uint32, dmg int) {
	for i := range m.damage {
		if m.damage[i].player == id {
			m.damage[i].amount += dmg
			return
		}
	}
	m.damage = append(m.damage, damageShare{player: id, amount: dmg})
}

// hitEvents tells everyone who sees pos about a hit of element on creature id: the
// effect, the damage number and the new health bar.
func (w *World) hitEvents(id uint32, pos world.Pos, dmg int, pct uint32, element string) {
	effect := uint32(EffectBlock)
	switch {
	case dmg > 0 && element != ElementPhysical:
		effect = elementEffect(element)
	case dmg > 0:
		effect = EffectHit
	}
	w.eachObserver(nil, pos, func(o *Player) {
		if !o.Knows(id) {
			return // T3.2: hits on an invisible player reach only who sees it
		}
		o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: posMsg(pos), EffectId: effect}}})
		if dmg > 0 {
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_FloatingText{FloatingText: &pb.FloatingText{
				Pos: posMsg(pos), Kind: pb.FloatingTextKind_FLOATING_TEXT_KIND_DAMAGE, Amount: uint64(dmg),
			}}})
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureHealth{CreatureHealth: &pb.CreatureHealth{Id: id, HealthPercent: pct}}})
		}
	})
}

// ---- monster attacks -------------------------------------------------------------

// monsterAttacks runs m's attacks that are due against its target: melee ones when it
// is adjacent, distance attacks and spells (T1.9) within their range and line of sight,
// with a projectile. A monster spell hits only its target (no area yet).
func (w *World) monsterAttacks(ctx *game.TickContext, m *Monster) {
	t := m.target
	d := chebyshev(m.pos, t.pos)
	for i, a := range m.kind.def.Attacks {
		if ctx.Tick < m.nextAttack[i] || m.pos.Z != t.pos.Z {
			continue
		}
		ranged := a.Type != "melee"
		if !ranged && d > 1 || ranged && (d > max(a.Range, 1) || !w.m.LineOfSight(m.pos, t.pos)) {
			continue
		}
		m.nextAttack[i] = ctx.Tick + m.kind.attackTicks[i]
		w.contribute(ctx, t) // T3.3: tanking counts for shared experience
		w.markFight(ctx, t)  // T3.5: no sailing right after
		if t.afkTarget == m {
			t.answeredAt = max(ctx.Tick, 1) // the player's target fights back: not AFK training
		}
		if a.Chance < 1 && ctx.Rand.Float64() >= a.Chance {
			continue
		}
		if ranged {
			w.projectileAt(m.pos, t, a.Element)
		}
		physical := a.Element == ElementPhysical
		pt := combat.PlayerTarget{ModeDefense: w.mode(t).Defense}
		if physical {
			pt.Armor = t.armor
		}
		if physical && t.shield != nil && t.shield.Shield != nil {
			pt.ShieldDefense = t.shield.Shield.Defense
			w.trainShield(ctx, t)
		}
		dmg := combat.HitPlayer(ctx.Rand, w.cfg.Balance.Combat, a.Min, a.Max, physical, pt)
		w.damagePlayer(ctx, t, dmg, a.Element)
		if m.target != t { // t was defeated and left
			return
		}
		if a.Condition != nil && dmg > 0 {
			w.applyCondition(ctx, holder{p: t}, a.Condition, m.id) // T3.2: a poisoning bite
		}
	}
}

func (w *World) damagePlayer(ctx *game.TickContext, p *Player, dmg int, element string) {
	w.markFight(ctx, p)
	dmg = min(dmg, p.health)
	p.health -= dmg
	w.hitEvents(p.id, p.pos, dmg, healthPercent(p.health, p.maxHealth), element)
	if dmg > 0 {
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	}
	if p.health <= 0 {
		w.die(ctx, p)
	}
}

// ---- death, loot and experience ----------------------------------------------------

func (w *World) killMonster(ctx *game.TickContext, m *Monster) {
	def := m.kind.def
	// Experience, by the damage each online player dealt; a party with shared
	// experience pools its members' shares (T3.3). The loot still goes to who dealt the
	// most damage.
	var owner *Player
	best := 0
	for _, s := range m.damage {
		if p := w.playerByID(s.player); p != nil && s.amount > best {
			owner, best = p, s.amount
		}
	}
	w.shareExperience(ctx.Tick, m.pos, def.Experience, m.damage)
	for _, s := range m.damage {
		if p := w.playerByID(s.player); p != nil {
			w.questKill(p, def.ID)
			p.recordEvent(ctx.Tick, eventKill, def.ID, 0, 0)
		}
	}

	// Remains with the loot, on the tile where it died. Loot beyond the remains'
	// slots is lost (data/monsters keeps loot tables short).
	corpse := &Corpse{Monster: def.ID, Item: newItem(w.corpseItem, 1)}
	add := func(it *Item) {
		if len(corpse.Item.items) < w.corpseItem.Slots() {
			it.parent = corpse.Item
			corpse.Item.items = append(corpse.Item.items, it)
		}
	}
	for _, l := range m.kind.loot {
		if ctx.Rand.Float64() >= l.chance {
			continue
		}
		n := combat.Roll(ctx.Rand, l.lo, l.hi)
		if !l.def.Stackable {
			for range n {
				add(newItem(l.def, l.def.StackLimit())) // a rune drops with all its charges
			}
			continue
		}
		for n > 0 {
			c := min(n, l.def.StackLimit())
			add(newItem(l.def, c))
			n -= c
		}
	}
	for _, it := range corpse.Item.items {
		w.econLoot(owner, def.ID, it)
	}
	pos := m.pos
	w.clearConditions(ctx, holder{m: m}, true)
	w.removeMonster(m)
	w.addCorpse(ctx, pos, corpse, w.corpseFor)
	if owner != nil {
		owner.emit(lootMsg(corpse))
	}
	if m.slot != nil {
		w.scheduleRespawn(ctx, m.slot, game.Tick(m.slot.spawn.RespawnSeconds)*game.Tick(1000/game.TickDuration.Milliseconds()))
	}
}

func (w *World) addCorpse(ctx *game.TickContext, pos world.Pos, c *Corpse, lasts game.Tick) {
	w.drop(c.Item, pos)
	w.corpses[pos] = append(w.corpses[pos], c)
	w.tileChanged(pos)
	ctx.Sched.After(lasts, func(*game.TickContext) {
		w.removeCorpse(pos, c)
	})
}

func (w *World) removeCorpse(pos world.Pos, c *Corpse) {
	list := w.corpses[pos]
	for i, q := range list {
		if q == c {
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(w.corpses, pos)
	} else {
		w.corpses[pos] = list
	}
	// The remains decay with whatever is still inside them (logged: loot and dropped
	// items were logged when they were created or lost).
	for _, it := range c.Item.items {
		w.econWorldTree(c.Owner, EconDecay, c.Monster, it)
	}
	w.closeAll(c.Item)
	w.detach(c.Item)
	w.tileChanged(pos)
}

// tileChanged sends the full stack of pos to everyone who sees it.
func (w *World) tileChanged(pos world.Pos) {
	ground, _, ok := w.m.Tile(pos)
	if !ok {
		return
	}
	t := &pb.Tile{Items: []*pb.ItemStack{{ItemId: uint32(ground)}}}
	for _, id := range w.m.Stack(pos) {
		t.Items = append(t.Items, &pb.ItemStack{ItemId: uint32(id)})
	}
	for _, it := range w.ground[pos] {
		t.Items = append(t.Items, it.stack())
	}
	w.eachObserver(nil, pos, func(o *Player) {
		o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_TileUpdate{TileUpdate: &pb.TileUpdate{Pos: posMsg(pos), Tile: t}}})
	})
}

// ---- messages ------------------------------------------------------------------------

func systemMsg(key string, params ...*pb.TextParam) *pb.ServerMessage {
	return &pb.ServerMessage{Message: &pb.ServerMessage_ChatMessage{ChatMessage: &pb.Message{
		Kind: pb.MessageKind_MESSAGE_KIND_SYSTEM,
		Body: &pb.Message_Localized{Localized: &pb.LocalizedText{Key: key, Params: params}},
	}}}
}

// lootMsg is "Loot of <monster>: <items>" (one "item" parameter per stack) or
// "<monster> had nothing".
func lootMsg(c *Corpse) *pb.ServerMessage {
	params := []*pb.TextParam{{Name: "monster", Value: &pb.TextParam_ContentId{ContentId: c.Monster}}}
	if len(c.Item.items) == 0 {
		return systemMsg(msgLootNone, params...)
	}
	for _, it := range c.Loot() {
		params = append(params, &pb.TextParam{Name: "item", Value: &pb.TextParam_Item{Item: it}})
	}
	return systemMsg(msgLoot, params...)
}
