package session

import (
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
	msgLoot         = "combat.loot"
	msgLootNone     = "combat.loot_none"
	msgDefeated     = "combat.defeated"
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
	w.markActive()
	for _, m := range w.monsters {
		if w.isActive(m.pos) {
			w.think(ctx, m)
		}
	}
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
	c := w.cfg.Balance.Combat
	// Fists until weapons (T1.8) and skill progress (T1.7) exist.
	maxHit := combat.MaxHit(c, w.fistSkill, c.FistAttack, p.level, w.mode(p).Attack)
	w.damageMonster(ctx, m, p, combat.HitMonster(ctx.Rand, maxHit, m.kind.target))
}

// damageMonster applies one hit of player p to m.
func (w *World) damageMonster(ctx *game.TickContext, m *Monster, p *Player, dmg int) {
	dmg = min(dmg, m.health)
	m.health -= dmg
	if dmg > 0 {
		w.addShare(m, p.id, dmg)
	}
	w.hitEvents(m.id, m.pos, dmg, healthPercent(m.health, m.maxHealth))
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

// hitEvents tells everyone who sees pos about a hit on creature id: the effect, the
// damage number and the new health bar.
func (w *World) hitEvents(id uint32, pos world.Pos, dmg int, pct uint32) {
	effect := uint32(EffectBlock)
	if dmg > 0 {
		effect = EffectHit
	}
	w.eachObserver(nil, pos, func(o *Player) {
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

// monsterAttacks runs m's melee attacks that are due against its adjacent target.
// Distance attacks and spells arrive with T1.9 (magic) and are skipped.
func (w *World) monsterAttacks(ctx *game.TickContext, m *Monster) {
	t := m.target
	for i, a := range m.kind.def.Attacks {
		if a.Type != "melee" || ctx.Tick < m.nextAttack[i] {
			continue
		}
		m.nextAttack[i] = ctx.Tick + m.kind.attackTicks[i]
		if a.Chance < 1 && ctx.Rand.Float64() >= a.Chance {
			continue
		}
		dmg := combat.HitPlayer(ctx.Rand, w.cfg.Balance.Combat, a.Min, a.Max, a.Element == "physical",
			combat.PlayerTarget{ModeDefense: w.mode(t).Defense}) // no armor or shield until T1.8
		w.damagePlayer(ctx, t, dmg)
		if m.target != t { // t was defeated and left
			return
		}
	}
}

func (w *World) damagePlayer(ctx *game.TickContext, p *Player, dmg int) {
	dmg = min(dmg, p.health)
	p.health -= dmg
	w.hitEvents(p.id, p.pos, dmg, healthPercent(p.health, p.maxHealth))
	if dmg > 0 {
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	}
	if p.health <= 0 {
		w.defeat(ctx, p)
	}
}

// defeat is a stand-in for death until T1.11 (penalties, corpse, blessings): the player
// wakes up at its temple with full health and loses nothing.
func (w *World) defeat(ctx *game.TickContext, p *Player) {
	p.health = p.maxHealth
	p.target = nil
	for _, m := range w.monsters {
		if m.target == p {
			m.target = nil
		}
	}
	to, ok := w.freeNear(w.temple(""), 3)
	if !ok {
		to = w.temple("")
	}
	w.Teleport(p, to)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	p.emit(systemMsg(msgDefeated))
	_ = ctx
}

// ---- death, loot and experience ----------------------------------------------------

func (w *World) killMonster(ctx *game.TickContext, m *Monster) {
	def := m.kind.def
	// Experience, shared by the damage each online player dealt.
	total := 0
	var owner *Player
	best := 0
	for _, s := range m.damage {
		if p := w.playerByID(s.player); p != nil {
			total += s.amount
			if s.amount > best {
				owner, best = p, s.amount
			}
		}
	}
	for _, s := range m.damage {
		p := w.playerByID(s.player)
		if p == nil || total == 0 {
			continue
		}
		if xp := def.Experience * int64(s.amount) / int64(total); xp > 0 {
			w.gainExperience(p, xp)
		}
	}

	// Remains with the loot, on the tile where it died.
	corpse := &Corpse{Monster: def.ID}
	for _, l := range m.kind.loot {
		if ctx.Rand.Float64() >= l.chance {
			continue
		}
		n := combat.Roll(ctx.Rand, l.lo, l.hi)
		if !l.stackable {
			for range n {
				corpse.Loot = append(corpse.Loot, &pb.ItemStack{ItemId: uint32(l.id)})
			}
			continue
		}
		corpse.Loot = append(corpse.Loot, &pb.ItemStack{ItemId: uint32(l.id), Count: uint32(n)})
	}
	pos := m.pos
	w.removeMonster(m)
	w.addCorpse(ctx, pos, corpse)
	if owner != nil {
		owner.emit(lootMsg(corpse))
	}
	if m.slot != nil {
		w.scheduleRespawn(ctx, m.slot, game.Tick(m.slot.spawn.RespawnSeconds)*game.Tick(1000/game.TickDuration.Milliseconds()))
	}
}

// gainExperience adds xp to p. Levels and their stats arrive with T1.7.
func (w *World) gainExperience(p *Player, xp int64) {
	p.experience += xp
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	w.eachObserver(nil, p.pos, func(o *Player) {
		o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_FloatingText{FloatingText: &pb.FloatingText{
			Pos: posMsg(p.pos), Kind: pb.FloatingTextKind_FLOATING_TEXT_KIND_EXPERIENCE, Amount: uint64(xp),
		}}})
	})
}

func (w *World) addCorpse(ctx *game.TickContext, pos world.Pos, c *Corpse) {
	w.ground[pos] = append(w.ground[pos], w.corpseItem)
	w.corpses[pos] = append(w.corpses[pos], c)
	w.tileChanged(pos)
	ctx.Sched.After(w.corpseFor, func(*game.TickContext) {
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
	items := w.ground[pos]
	for i := len(items) - 1; i >= 0; i-- {
		if items[i] == w.corpseItem {
			items = append(items[:i], items[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(w.corpses, pos)
	} else {
		w.corpses[pos] = list
	}
	if len(items) == 0 {
		delete(w.ground, pos)
	} else {
		w.ground[pos] = items
	}
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
	for _, id := range w.ground[pos] {
		t.Items = append(t.Items, &pb.ItemStack{ItemId: uint32(id)})
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
	if len(c.Loot) == 0 {
		return systemMsg(msgLootNone, params...)
	}
	for _, it := range c.Loot {
		params = append(params, &pb.TextParam{Name: "item", Value: &pb.TextParam_Item{Item: it}})
	}
	return systemMsg(msgLoot, params...)
}
