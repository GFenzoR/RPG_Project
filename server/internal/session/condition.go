package session

import (
	"fmt"
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Conditions (T3.2, docs/02-game-design.md "Condiciones"): poison, burning and shocked
// hit their holder every interval with their element; slowed and hasted change its
// speed (and so StepTicks); keen_eye raises a combat skill; invisible hides a player.
// The rules of each one are balance.yaml conditions; a source (spell, monster attack)
// gives its strength and duration.
//
// Every active condition owns exactly one scheduler event: its next hit, or its end.
// Nothing scans creatures every tick, so a thousand poisoned monsters cost a heap
// operation per hit (docs/07-performance-budget.md).

// EffectBuff is the effect of a condition spell on its target (or a cure on the caster).
const EffectBuff = 7

// i18n keys of the condition system messages (i18n/*/client.yaml).
const msgNothingToCure = "magic.nothing_to_cure"

// ConditionState is a condition as saved with the character: the time to its next hit
// (damage) or to its end (the others), and the hits left and their damage.
type ConditionState struct {
	ID     string
	LeftMs int
	Ticks  int
	Damage int
}

// condition is an active condition of a player or a monster. Loop goroutine only.
type condition struct {
	def *content.ConditionDef
	// source is the creature that applied it (a player's share of a monster's
	// experience), 0 for none.
	source uint32
	damage int // per hit (damage kind)
	ticks  int // hits left (damage kind)
	// at is the tick of the next hit (damage kind) or of the end (the others).
	at    game.Tick
	event game.EventID
	every game.Tick // interval between hits (damage kind)
	// due is the event function, built once: a reschedule allocates nothing.
	due game.EventFunc
}

// holder is the creature that has a condition: exactly one of p and m is set.
type holder struct {
	p *Player
	m *Monster
}

func (h holder) list() *[]*condition {
	if h.p != nil {
		return &h.p.conds
	}
	return &h.m.conds
}

func (w *World) present(h holder) bool {
	if h.p != nil {
		return w.byClient[h.p.client] == h.p
	}
	return w.monByID[h.m.id] == h.m
}

func findCond(list []*condition, id string) *condition {
	for _, c := range list {
		if c.def.ID == id {
			return c
		}
	}
	return nil
}

// initConditions checks that every condition the spells and monsters apply exists.
func (w *World) initConditions() error {
	cs := w.cfg.Balance.Conditions
	if err := w.cfg.Spells.CheckConditions(cs); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	for _, id := range w.cfg.Monsters.IDs() {
		for i, a := range w.cfg.Monsters[id].Attacks {
			if err := a.Condition.Check(cs); err != nil {
				return fmt.Errorf("session: monster %q: attacks[%d]: %w", id, i, err)
			}
		}
	}
	for _, id := range cs.IDs() {
		if d := cs[id]; d.Kind == content.ConditionSkill {
			if _, ok := w.skillIdx[d.Skill]; !ok {
				return fmt.Errorf("session: condition %q raises unknown skill %q", id, d.Skill)
			}
		}
	}
	return nil
}

// applyCondition rolls a's chance and, if it passes, gives h the condition. A monster
// that resists the element of a damage condition fully (100 % or more) is immune.
func (w *World) applyCondition(ctx *game.TickContext, h holder, a *content.ConditionApply, source uint32) bool {
	def := w.cfg.Balance.Conditions[a.ID]
	if def == nil {
		return false
	}
	if a.Chance > 0 && ctx.Rand.Float64() >= a.Chance {
		return false
	}
	if def.Kind == content.ConditionDamage && h.m != nil && h.m.kind.def.Resistances[def.Element] >= 100 {
		return false
	}
	if def.Kind == content.ConditionInvisible && h.m != nil {
		return false // only players hide (T3.2)
	}
	w.addCondition(ctx, h, def, source, a.Damage, a.Ticks, ticksFor(a.DurationMs))
	return true
}

// addCondition gives h the condition def, or stacks it on the one h has (def.Stacking):
// a damage condition with ticks hits of damage, the others for dur ticks.
func (w *World) addCondition(ctx *game.TickContext, h holder, def *content.ConditionDef, source uint32, damage, ticks int, dur game.Tick) {
	for _, id := range def.Cancels {
		w.removeCondition(ctx, h, id)
	}
	list := h.list()
	c := findCond(*list, def.ID)
	if def.Kind == content.ConditionDamage {
		ticks = min(ticks, def.MaxTicks)
		if c == nil {
			c = &condition{def: def, source: source, damage: damage, ticks: ticks, every: ticksFor(def.IntervalMs)}
			w.scheduleCondition(ctx, h, c, ctx.Tick+c.every)
			*list = append(*list, c)
		} else {
			before := c.ticks
			if def.Stacking == content.StackAdd {
				c.ticks = min(c.ticks+ticks, def.MaxTicks)
			} else {
				c.ticks = max(c.ticks, ticks)
			}
			// The hits left count for whoever made them: a stronger application, or an
			// equal one that added hits, takes over the experience share.
			if damage > c.damage || damage == c.damage && c.ticks > before {
				c.damage, c.source = damage, source
			}
		}
		w.conditionsChanged(h)
		return
	}
	limit := ctx.Tick + ticksFor(def.MaxMs)
	end := min(ctx.Tick+dur, limit)
	if c == nil {
		c = &condition{def: def, source: source}
		w.scheduleCondition(ctx, h, c, end)
		*list = append(*list, c)
		w.conditionStarted(ctx, h, c)
		w.conditionsChanged(h)
		return
	}
	if def.Stacking == content.StackAdd {
		end = min(c.at+dur, limit)
	} else {
		end = max(c.at, end)
	}
	if end != c.at {
		ctx.Sched.Cancel(c.event)
		w.scheduleCondition(ctx, h, c, end)
	}
	w.conditionsChanged(h)
}

func (w *World) scheduleCondition(ctx *game.TickContext, h holder, c *condition, at game.Tick) {
	c.at = max(at, ctx.Tick+1) // the scheduler never runs an event in the current tick
	if c.due == nil {
		c.due = func(ctx *game.TickContext) { w.conditionDue(ctx, h, c) }
	}
	c.event = ctx.Sched.At(c.at, c.due)
}

// conditionDue is c's event: the next hit of a damage condition, or the end of the others.
func (w *World) conditionDue(ctx *game.TickContext, h holder, c *condition) {
	if !w.present(h) || findCond(*h.list(), c.def.ID) != c {
		return
	}
	if c.def.Kind != content.ConditionDamage {
		w.dropCondition(ctx, h, c)
		return
	}
	w.conditionHit(ctx, h, c)
	if !w.present(h) || findCond(*h.list(), c.def.ID) != c {
		return // the hit killed it (a dead player's conditions end) or it logged out
	}
	c.ticks--
	if c.ticks <= 0 {
		w.dropCondition(ctx, h, c)
		return
	}
	w.scheduleCondition(ctx, h, c, ctx.Tick+c.every)
	w.conditionsChanged(h)
}

// conditionHit is one hit of a damage condition: the monster's resistance applies, armor
// does not. A player in a protection zone is not hurt (the hit still counts).
func (w *World) conditionHit(ctx *game.TickContext, h holder, c *condition) {
	el := c.def.Element
	if p := h.p; p != nil {
		if !w.inProtection(p.pos) {
			w.damagePlayer(ctx, p, c.damage, el)
		}
		return
	}
	m := h.m
	dmg := min(combat.Resist(c.damage, m.kind.def.Resistances[el]), m.health)
	m.health -= dmg
	if dmg > 0 && c.source != 0 {
		w.addShare(m, c.source, dmg)
		w.contribute(ctx, w.playerByID(c.source))
	}
	w.hitEvents(m.id, m.pos, dmg, healthPercent(m.health, m.maxHealth), el)
	if m.health <= 0 {
		w.killMonster(ctx, m)
	}
}

// removeCondition ends h's condition id, if it has it, and reports whether it did.
func (w *World) removeCondition(ctx *game.TickContext, h holder, id string) bool {
	c := findCond(*h.list(), id)
	if c == nil {
		return false
	}
	ctx.Sched.Cancel(c.event)
	w.dropCondition(ctx, h, c)
	return true
}

// dropCondition takes c (whose event is not pending) off h and undoes its effect.
func (w *World) dropCondition(ctx *game.TickContext, h holder, c *condition) {
	list := h.list()
	if i := slices.Index(*list, c); i >= 0 {
		*list = slices.Delete(*list, i, i+1)
	}
	w.conditionEnded(ctx, h, c)
	w.conditionsChanged(h)
}

// clearConditions ends every condition of h (death, a monster that died). With quiet,
// nothing is sent and no effect is undone: the holder is leaving the world.
func (w *World) clearConditions(ctx *game.TickContext, h holder, quiet bool) {
	list := h.list()
	if len(*list) == 0 {
		return
	}
	old := *list
	*list = nil
	for _, c := range old {
		ctx.Sched.Cancel(c.event)
	}
	if quiet {
		return
	}
	for _, c := range old {
		w.conditionEnded(ctx, h, c)
	}
	w.conditionsChanged(h)
}

// conditionStarted applies the lasting effect of a timed condition that just started.
func (w *World) conditionStarted(ctx *game.TickContext, h holder, c *condition) {
	switch c.def.Kind {
	case content.ConditionSpeed:
		w.refreshSpeed(h)
	case content.ConditionInvisible:
		w.hide(ctx, h.p)
	}
}

func (w *World) conditionEnded(_ *game.TickContext, h holder, c *condition) {
	switch c.def.Kind {
	case content.ConditionSpeed:
		w.refreshSpeed(h)
	case content.ConditionInvisible:
		w.unhide(h.p)
	}
}

// conditionsChanged sends a player its conditions (monsters' are not sent).
func (w *World) conditionsChanged(h holder) {
	if h.p != nil {
		h.p.conditionsDirty = true
	}
}

// sendConditions emits p's PlayerConditions if they changed this tick (at flush, so
// several changes in one tick cost one message).
func (w *World) sendConditions(p *Player) {
	if !p.conditionsDirty {
		return
	}
	p.conditionsDirty = false
	msg := &pb.PlayerConditions{Conditions: make([]*pb.ActiveCondition, 0, len(p.conds))}
	for _, c := range p.conds {
		msg.Conditions = append(msg.Conditions, &pb.ActiveCondition{
			ConditionId: c.def.ID, RemainingMs: uint32(max(w.leftMs(c), 0)), Ticks: uint32(max(c.ticks, 0)),
		})
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerConditions{PlayerConditions: msg}})
}

// leftMs is the time left of c: to its end, or its hits left × interval.
func (w *World) leftMs(c *condition) int {
	tickMs := int(game.TickDuration.Milliseconds())
	next := max(int(c.at)-int(w.nowTick()), 0) * tickMs
	if c.def.Kind == content.ConditionDamage {
		return next + (c.ticks-1)*int(c.every)*tickMs
	}
	return next
}

// ---- speed, skills and invisibility ------------------------------------------------

// speedPct is the sum of h's speed conditions.
func speedPct(list []*condition) int {
	pct := 0
	for _, c := range list {
		if c.def.Kind == content.ConditionSpeed {
			pct += c.def.SpeedPct
		}
	}
	return pct
}

func withPct(base, pct int) int { return max(base*(100+pct)/100, 1) }

// refreshSpeed recomputes h's speed from its base and its conditions and tells who
// needs it: the player its stats, the clients that see the creature CreatureSpeed.
func (w *World) refreshSpeed(h holder) {
	var id uint32
	var speed int
	if p := h.p; p != nil {
		speed = withPct(p.baseSpeed, speedPct(p.conds))
		if speed == p.speed {
			return
		}
		p.speed, id = speed, p.id
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
		w.eachWatcher(p, func(o *Player) {
			if o != p {
				o.emit(speedMsg(id, speed))
			}
		})
		return
	}
	m := h.m
	speed = withPct(m.kind.def.Speed, speedPct(m.conds))
	if speed == m.speed {
		return
	}
	m.speed = speed
	w.eachObserver(nil, m.pos, func(o *Player) {
		if o.Knows(m.id) {
			o.emit(speedMsg(m.id, speed))
		}
	})
}

func speedMsg(id uint32, speed int) *pb.ServerMessage {
	return &pb.ServerMessage{Message: &pb.ServerMessage_CreatureSpeed{CreatureSpeed: &pb.CreatureSpeed{Id: id, Speed: uint32(speed)}}}
}

// combatSkill is p's level in skill id plus its skill conditions (keen_eye): what
// attacks and spells use. Training, the skills panel and saves use the plain level.
func (w *World) combatSkill(p *Player, id string) int {
	lvl := w.skillLevel(p, id)
	for _, c := range p.conds {
		if c.def.Kind == content.ConditionSkill && c.def.Skill == id {
			lvl += c.def.Amount
		}
	}
	return lvl
}

// hide makes p invisible: the clients that knew it get CreatureDisappear and from now
// on nobody else is sent it (AOI filters it, docs/01-architecture.md "Trampas y
// anti-bot"). Monsters without sees_invisible drop it as a target on their next think.
func (w *World) hide(_ *game.TickContext, p *Player) {
	if p == nil || p.invisible {
		return
	}
	p.invisible = true
	w.eachObserver(p, p.pos, func(o *Player) {
		if o.forget(p.id) {
			o.emit(disappearMsg(p.id))
		}
	})
}

// unhide ends p's invisibility: it appears to every client that sees its tile.
func (w *World) unhide(p *Player) {
	if p == nil || !p.invisible {
		return
	}
	p.invisible = false
	w.appearToObservers(p)
}

// reveal ends p's invisibility because it attacked or cast (the rule of T3.2).
func (w *World) reveal(ctx *game.TickContext, p *Player) {
	if p != nil && p.invisible {
		for _, c := range p.conds {
			if c.def.Kind == content.ConditionInvisible {
				w.removeCondition(ctx, holder{p: p}, c.def.ID)
				return
			}
		}
	}
}

// seesPlayer reports whether monster m may see player t (invisibility).
func seesPlayer(m *Monster, t *Player) bool { return !t.invisible || m.kind.def.Behavior.SeesInvisible }

// ---- persistence --------------------------------------------------------------------

// conditionStates returns p's conditions that survive a logout (def.Persists).
func (w *World) conditionStates(p *Player) []ConditionState {
	var out []ConditionState
	for _, c := range p.conds {
		if !c.def.Persists {
			continue
		}
		left := max(int(c.at)-int(w.nowTick()), 1) * int(game.TickDuration.Milliseconds())
		out = append(out, ConditionState{ID: c.def.ID, LeftMs: left, Ticks: c.ticks, Damage: c.damage})
	}
	return out
}

// loadConditions gives a joining p its saved conditions. Unknown ones, or ones that do
// not persist any more, are dropped; hits and times are clamped to today's balance
// (max_ticks, interval_ms, max_ms). The saved damage is kept: it came from a source.
func (w *World) loadConditions(ctx *game.TickContext, p *Player, saved []ConditionState) {
	h := holder{p: p}
	for _, s := range saved {
		def := w.cfg.Balance.Conditions[s.ID]
		if def == nil || !def.Persists || findCond(p.conds, s.ID) != nil {
			continue
		}
		left := ticksFor(max(s.LeftMs, 1))
		c := &condition{def: def}
		if def.Kind == content.ConditionDamage {
			if s.Ticks <= 0 || s.Damage <= 0 {
				continue
			}
			c.every = ticksFor(def.IntervalMs)
			c.ticks, c.damage = min(s.Ticks, def.MaxTicks), s.Damage
			left = min(left, c.every)
		} else {
			left = min(left, ticksFor(def.MaxMs))
		}
		w.scheduleCondition(ctx, h, c, ctx.Tick+left)
		p.conds = append(p.conds, c)
		if def.Kind != content.ConditionDamage {
			w.conditionStarted(ctx, h, c)
		}
	}
	p.conditionsDirty = len(p.conds) > 0 // a new client starts with none
}

// nowTick is the current tick outside a TickContext (snapshots, flush): the scheduler's
// position, which the loop sets before commands run. 0 before anyone joined.
func (w *World) nowTick() game.Tick {
	if w.sched == nil {
		return 0
	}
	return w.sched.Now()
}
