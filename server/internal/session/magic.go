package session

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Magic (T1.9): mana, magic level, spells cast by words or hotkey with their own and
// their group's cooldown, elemental damage against monster resistances, line of sight,
// wands and runes (docs/02-game-design.md, "Combate"; docs/05-network-protocol.md).

// Elements of data/ (common.schema.json "element"), in protocol order.
const (
	ElementPhysical = "physical"
	// WeaponWand is the weapon type of wands: a distance attack of their element.
	WeaponWand = "wand"
	// SkillMagic is the magic level: it rises with the mana spent.
	SkillMagic = "magic"
)

var elements = [...]string{ElementPhysical, "fire", "ice", "energy", "earth", "holy", "death"}

// Effect and projectile ids added by T1.9 (protocol constants until data/effects.yaml).
const (
	// EffectHeal: a heal on the caster.
	EffectHeal = 3
	// EffectConjure: the caster conjured an item.
	EffectConjure = 4
	// EffectElementBase + element index (0 physical … 6 death): an elemental hit or a
	// tile of an area spell.
	EffectElementBase = 10
	// ProjectileElementBase + element index: a wand shot, an attack spell or a monster's
	// distance attack flying from one tile to another.
	ProjectileElementBase = 1
)

// i18n keys of the magic system messages (i18n/*/client.yaml).
const (
	msgSpellVocation   = "magic.vocation"
	msgSpellLevel      = "magic.level_required"
	msgMagicLevel      = "magic.magic_level_required"
	msgNoMana          = "magic.no_mana"
	msgSpellNotReady   = "magic.not_ready"
	msgNoTarget        = "magic.no_target"
	msgOutOfRange      = "magic.out_of_range"
	msgNoSight         = "magic.no_sight"
	msgSpellProtection = "magic.protection_zone"
	msgNoRoom          = "magic.no_room"
	msgConjured        = "magic.conjured"
)

func elementIndex(e string) uint32 {
	for i, x := range elements {
		if x == e {
			return uint32(i)
		}
	}
	return 0
}

func elementEffect(e string) uint32 { return EffectElementBase + elementIndex(e) }

// initMagic indexes the spells by words and checks that conjured items exist and that
// runes name a spell (only when spells are loaded: tools and tests may run without).
func (w *World) initMagic() error {
	w.spellWords = w.cfg.Spells.ByWords()
	w.magicIdx = -1
	if i, ok := w.skillIdx[SkillMagic]; ok {
		w.magicIdx = i
	}
	if len(w.cfg.Spells) == 0 {
		return nil
	}
	for _, id := range w.cfg.Spells.IDs() {
		if c := w.cfg.Spells[id].Effect.Conjure; c != nil && w.cfg.Items[c.Item] == nil {
			return fmt.Errorf("session: spell %q conjures unknown item %q", id, c.Item)
		}
	}
	for _, it := range w.cfg.Items {
		if it.Rune == nil {
			continue
		}
		// A rune aims at a creature: only single-target damage spells fit (no free
		// conjuring, no area centred on the user instead of the target).
		s := w.cfg.Spells[it.Rune.Spell]
		if s == nil || s.Effect.Damage == nil || s.Effect.Damage.Range == 0 {
			return fmt.Errorf("session: rune %q must cast a known single-target damage spell, not %q", it.ID, it.Rune.Spell)
		}
	}
	return nil
}

func (w *World) magicLevel(p *Player) int {
	if w.magicIdx < 0 {
		return 0
	}
	return p.skills[w.magicIdx].Level
}

func num(name string, v int) *pb.TextParam {
	return &pb.TextParam{Name: name, Value: &pb.TextParam_Number{Number: int64(v)}}
}

// ---- intents -------------------------------------------------------------------

// castSpell runs a CastSpell: by spell id (hotkey) or by words. Unknown ones are ignored.
func (w *World) castSpell(ctx *game.TickContext, p *Player, m *pb.CastSpell) {
	var s *content.Spell
	switch v := m.GetSpell().(type) {
	case *pb.CastSpell_SpellId:
		s = w.cfg.Spells[v.SpellId]
	case *pb.CastSpell_Words:
		s = w.spellWords[content.NormalizeWords(v.Words)]
	}
	if s != nil {
		w.cast(ctx, p, s, m.GetTarget())
	}
}

// say runs a Say: text on the say channel that matches a spell's words casts it. The
// chat itself (showing the text to others) arrives with T1.13.
func (w *World) say(ctx *game.TickContext, p *Player, m *pb.Say) {
	if m.GetChannel() != pb.ChatChannel_CHAT_CHANNEL_SAY {
		return
	}
	if s := w.spellWords[content.NormalizeWords(m.GetText())]; s != nil {
		w.cast(ctx, p, s, nil)
	}
}

// cast checks vocation, level, magic level, cooldowns and mana, applies s and then
// spends the mana (which trains the magic level) and starts both cooldowns. A cast that
// fails (no target, out of range, no line of sight...) costs nothing.
func (w *World) cast(ctx *game.TickContext, p *Player, s *content.Spell, target *pb.ActionTarget) {
	switch {
	case !s.CastBy(p.vocation.ID):
		p.emit(systemMsg(msgSpellVocation))
		return
	case p.level < s.Level:
		p.emit(systemMsg(msgSpellLevel, num("level", s.Level)))
		return
	case w.magicLevel(p) < s.MagicLevel:
		p.emit(systemMsg(msgMagicLevel, num("level", s.MagicLevel)))
		return
	case ctx.Tick < p.spellReady[s.ID] || ctx.Tick < p.groupReady[s.Group]:
		p.emit(systemMsg(msgSpellNotReady))
		return
	case p.mana < s.Mana:
		p.emit(systemMsg(msgNoMana))
		return
	}
	if !w.applySpell(ctx, p, s, target) {
		return
	}
	p.mana -= s.Mana
	if s.Mana > 0 && w.magicIdx >= 0 {
		w.addTries(p, w.magicIdx, int64(s.Mana))
	}
	w.startCooldown(ctx, p, s, true)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
}

// startCooldown blocks s (if own) and its group, and tells the client.
func (w *World) startCooldown(ctx *game.TickContext, p *Player, s *content.Spell, own bool) {
	if p.spellReady == nil {
		p.spellReady, p.groupReady = map[string]game.Tick{}, map[string]game.Tick{}
	}
	cd := &pb.SpellCooldown{SpellId: s.ID, Group: s.Group}
	if own && s.CooldownMs > 0 {
		t := ticksFor(s.CooldownMs)
		p.spellReady[s.ID] = ctx.Tick + t
		cd.CooldownMs = uint32(t) * uint32(game.TickDuration.Milliseconds())
	}
	if s.GroupCooldownMs > 0 {
		t := ticksFor(s.GroupCooldownMs)
		p.groupReady[s.Group] = ctx.Tick + t
		cd.GroupCooldownMs = uint32(t) * uint32(game.TickDuration.Milliseconds())
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_SpellCooldown{SpellCooldown: cd}})
}

// ---- effects ---------------------------------------------------------------------

// applySpell applies s's effect for p and reports whether it happened. Rejections tell
// p why.
func (w *World) applySpell(ctx *game.TickContext, p *Player, s *content.Spell, target *pb.ActionTarget) bool {
	e := s.Effect
	switch {
	case e.Damage != nil && e.Damage.Range > 0:
		return w.boltSpell(ctx, p, e.Damage, target)
	case e.Damage != nil:
		return w.areaSpell(ctx, p, e.Damage)
	case e.Heal != nil:
		w.heal(p, combat.Scaled(ctx.Rand, *e.Heal, p.level, w.magicLevel(p)))
		return true
	case e.Conjure != nil:
		return w.conjure(p, w.cfg.Items[e.Conjure.Item])
	}
	return false
}

// spellTarget resolves the monster a targeted spell aims at: the creature or the tile
// of target, or p's current target.
func (w *World) spellTarget(p *Player, target *pb.ActionTarget) *Monster {
	switch t := target.GetTarget().(type) {
	case *pb.ActionTarget_CreatureId:
		if p.Knows(t.CreatureId) {
			return w.monByID[t.CreatureId]
		}
		return nil
	case *pb.ActionTarget_Pos:
		if pos, ok := posFromMsg(t.Pos); ok {
			return w.monsterAt(pos)
		}
		return nil
	}
	return p.target
}

// boltSpell hits one monster at up to d.Range tiles in line of sight.
func (w *World) boltSpell(ctx *game.TickContext, p *Player, d *content.SpellDamage, target *pb.ActionTarget) bool {
	m := w.spellTarget(p, target)
	switch {
	case m == nil:
		p.emit(systemMsg(msgNoTarget))
		return false
	case w.inProtection(p.pos) || w.inProtection(m.pos):
		p.emit(systemMsg(msgSpellProtection))
		return false
	case m.pos.Z != p.pos.Z || chebyshev(p.pos, m.pos) > d.Range:
		p.emit(systemMsg(msgOutOfRange))
		return false
	case !w.m.LineOfSight(p.pos, m.pos):
		p.emit(systemMsg(msgNoSight))
		return false
	}
	w.projectile(p.pos, m.pos, d.Element)
	dmg := combat.Resist(combat.Scaled(ctx.Rand, d.Scaling, p.level, w.magicLevel(p)), m.kind.def.Resistances[d.Element])
	w.damageMonster(ctx, m, p, dmg, d.Element)
	return true
}

// inArea reports whether a tile at offset (dx, dy) lies in a round area of radius r.
func inArea(dx, dy, r int) bool { return dx*dx+dy*dy <= r*r+r }

// areaSpell hits every monster within d.Radius tiles of p that p has line of sight to
// (walls shield what is behind them). Each monster rolls its own damage.
func (w *World) areaSpell(ctx *game.TickContext, p *Player, d *content.SpellDamage) bool {
	if w.inProtection(p.pos) {
		p.emit(systemMsg(msgSpellProtection))
		return false
	}
	r := d.Radius
	effect := elementEffect(d.Element)
	for dy := -r; dy <= r; dy++ {
		for dx := -r; dx <= r; dx++ {
			x, y := int(p.pos.X)+dx, int(p.pos.Y)+dy
			if !inArea(dx, dy, r) || x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
				continue
			}
			to := world.Pos{X: uint16(x), Y: uint16(y), Z: p.pos.Z}
			if (dx != 0 || dy != 0) && !w.m.LineOfSight(p.pos, to) {
				continue
			}
			msg := &pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: posMsg(to), EffectId: effect}}}
			w.eachObserver(nil, to, func(o *Player) { o.emit(msg) })
		}
	}
	// Collect first: a monster that dies leaves the sector being walked.
	var hit []*Monster
	w.eachMonsterInRect(int(p.pos.X)-r, int(p.pos.Y)-r, int(p.pos.X)+r, int(p.pos.Y)+r, p.pos.Z, func(m *Monster) {
		if m.pos.Z == p.pos.Z && inArea(int(m.pos.X)-int(p.pos.X), int(m.pos.Y)-int(p.pos.Y), r) &&
			!w.inProtection(m.pos) && w.m.LineOfSight(p.pos, m.pos) {
			hit = append(hit, m)
		}
	})
	for _, m := range hit {
		if w.monByID[m.id] != m {
			continue
		}
		dmg := combat.Resist(combat.Scaled(ctx.Rand, d.Scaling, p.level, w.magicLevel(p)), m.kind.def.Resistances[d.Element])
		w.damageMonster(ctx, m, p, dmg, d.Element)
	}
	return true
}

// heal gives p up to amount health, with its effect and floating text.
func (w *World) heal(p *Player, amount int) {
	hp := min(max(amount, 0), p.maxHealth-p.health)
	pct := healthPercent(p.health, p.maxHealth)
	p.health += hp
	w.eachObserver(nil, p.pos, func(o *Player) {
		o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: posMsg(p.pos), EffectId: EffectHeal}}})
		if hp > 0 {
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_FloatingText{FloatingText: &pb.FloatingText{
				Pos: posMsg(p.pos), Kind: pb.FloatingTextKind_FLOATING_TEXT_KIND_HEAL, Amount: uint64(hp),
			}}})
		}
	})
	w.healthBar(p, pct)
}

// conjure puts a new def (a rune with all its charges) in p's backpack.
func (w *World) conjure(p *Player, def *content.Item) bool {
	bp := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]
	if def == nil || bp == nil || bp.def.Container == nil || len(bp.items) >= bp.def.Slots() {
		p.emit(systemMsg(msgNoRoom))
		return false
	}
	if def.Weight > p.capacity-p.carried() {
		p.emit(systemMsg(msgTooHeavy))
		return false
	}
	it := newItem(def, def.StackLimit())
	w.attach(p, it, place{kind: locContainer, cont: bp})
	w.containerChanged(bp)
	w.eachObserver(nil, p.pos, func(o *Player) {
		o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: posMsg(p.pos), EffectId: EffectConjure}}})
	})
	p.emit(systemMsg(msgConjured, &pb.TextParam{Name: "item", Value: &pb.TextParam_Item{Item: it.stack()}}))
	return true
}

// projectile shows a projectile of element flying from one tile to another to everyone
// who sees either end.
func (w *World) projectile(from, to world.Pos, element string) {
	msg := &pb.ServerMessage{Message: &pb.ServerMessage_Projectile{Projectile: &pb.Projectile{
		From: posMsg(from), To: posMsg(to), ProjectileId: ProjectileElementBase + elementIndex(element),
	}}}
	w.eachObserver(nil, from, func(o *Player) { o.emit(msg) })
	w.eachObserver(nil, to, func(o *Player) {
		if !Sees(o.pos, from) {
			o.emit(msg)
		}
	})
}

// ---- wands and runes -------------------------------------------------------------

// wandFight is playerFight with a wand: every attack round it shoots its target at up
// to weapon.range tiles in line of sight. Chasing stops once the target is in range.
func (w *World) wandFight(ctx *game.TickContext, p *Player, m *Monster) {
	wp := p.weapon.Weapon
	inRange := chebyshev(p.pos, m.pos) <= max(wp.Range, 1)
	if inRange && ctx.Tick < p.nextAttack {
		return
	}
	if !inRange || !w.m.LineOfSight(p.pos, m.pos) {
		if p.chase && !p.Walking() && ctx.Tick >= p.readyAt {
			if d, ok := w.chaseStep(p.pos, m.pos, false); ok {
				p.stopWalk()
				p.queue = append(p.queue, d)
			}
		}
		return
	}
	p.nextAttack = ctx.Tick + w.attackFor
	element := wp.Element
	if element == "" {
		element = ElementPhysical
	}
	w.projectile(p.pos, m.pos, element)
	dmg := combat.Resist(combat.WandHit(ctx.Rand, wp.Attack, w.cfg.Balance.Combat.WandMinFactor), m.kind.def.Resistances[element])
	w.damageMonster(ctx, m, p, dmg, element)
}

// useRune casts it's spell on target (or the current target) without mana or words.
// It needs the rune's magic level, respects the spell group's cooldown and spends one
// charge; the last charge removes the rune.
func (w *World) useRune(ctx *game.TickContext, p *Player, it *Item, target *pb.ActionTarget) {
	r := it.def.Rune
	s := w.cfg.Spells[r.Spell]
	switch {
	case s == nil:
		p.emit(systemMsg(msgCannotUse))
		return
	case w.magicLevel(p) < r.MagicLevel:
		p.emit(systemMsg(msgMagicLevel, num("level", r.MagicLevel)))
		return
	case ctx.Tick < p.groupReady[s.Group]:
		p.emit(systemMsg(msgSpellNotReady))
		return
	}
	if !w.applySpell(ctx, p, s, target) {
		return
	}
	w.startCooldown(ctx, p, s, false)
	w.useUp(it)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
}

// useItemOn runs a UseItemOn: a rune is cast on the creature or tile.
func (w *World) useItemOn(ctx *game.TickContext, p *Player, m *pb.UseItemOn) {
	it, from := w.itemAt(p, m.GetFrom(), m.GetItemId(), m.GetStackIndex())
	if it == nil {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	if from.kind == locGround && !w.near(p, from.pos) || from.kind == locContainer && !w.reaches(p, from.cont) {
		p.emit(systemMsg(msgTooFar))
		return
	}
	if from.kind == locContainer && w.reserved(ctx.Tick, p, it) {
		p.emit(systemMsg(msgNotOwner))
		return
	}
	if it.def.Rune == nil || m.GetTo() == nil {
		p.emit(systemMsg(msgCannotUse))
		return
	}
	w.useRune(ctx, p, it, m.GetTo())
}
