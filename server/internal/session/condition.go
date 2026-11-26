package session

import (
	"fmt"
	"maps"
	"slices"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Conditions (T3.2, docs/02-game-design.md "Condiciones"): poison, burning and shocked
// hit their holder every interval with their element; slowed and hasted change its
// speed (and so StepMs); keen_eye raises a combat skill; invisible hides a player.
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
	// Author is the character of the player that applied it (T5.2), 0 for a monster or the
	// world: after a relog its hits are still that player's attack.
	Author int64
	// AuthorHit is when Author last hurt the holder outside an arena, as the holder
	// remembered it (self-defense, and the attack a condition may continue), and
	// AuthorUnjust whether any of those hits was unjustified. Zero: nothing remembered.
	AuthorHit    time.Time
	AuthorUnjust bool
	// SavedAt is the clock time of the snapshot that saved a condition with an Author
	// (zero for the others): such a condition runs on while its holder is away
	// (loadConditions), so a relog neither cuts nor defers its author's attack.
	SavedAt time.Time
}

// condition is an active condition of a player or a monster. Loop goroutine only.
type condition struct {
	def *content.ConditionDef
	// source is the creature that applied it (a player's share of a monster's
	// experience), 0 for none.
	source uint32
	// author is the character of the player that applied it, 0 for a monster or the
	// world (T5.2). A player's condition on a player is that player's attack: it is found
	// by character, so a relog of either side (a new creature id) does not lose it.
	author int64
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
	if err := checkStatusIDs(cs); err != nil {
		return err
	}
	if err := w.cfg.Spells.CheckConditions(cs); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	for _, id := range w.cfg.Monsters.IDs() {
		for i, a := range w.cfg.Monsters[id].AllAttacks() {
			if err := a.Condition.Check(cs); err != nil {
				return fmt.Errorf("session: monster %q: attack %d (its own, then its phases'): %w", id, i, err)
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
	return w.checkFood()
}

// checkFood: food (consumable.food_ms) needs the food condition, a regen one (content
// audit m2) that adds up (stacking: add: with refresh a second meal would not lengthen
// it, and stomachFull counts on the sum), and pure food may not last longer than its
// max_ms (it could never be eaten).
func (w *World) checkFood() error {
	fed := w.cfg.Balance.Conditions[foodCondition]
	for _, id := range slices.Sorted(maps.Keys(w.cfg.Items)) { // a stable first error
		c := w.cfg.Items[id].Consumable
		if c == nil || c.FoodMs <= 0 {
			continue
		}
		switch {
		case fed == nil || fed.Kind != content.ConditionRegen:
			return fmt.Errorf("session: item %q is food but balance.yaml conditions has no %q of kind %q", id, foodCondition, content.ConditionRegen)
		case fed.Stacking != content.StackAdd:
			return fmt.Errorf("session: condition %q must stack with add: every meal adds its food_ms", foodCondition)
		case c.HealHP == 0 && c.HealMP == 0 && c.FoodMs > fed.MaxMs:
			return fmt.Errorf("session: food %q lasts %d ms, more than %s max_ms %d: it could never be eaten", id, c.FoodMs, foodCondition, fed.MaxMs)
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
			c = &condition{def: def, source: source, author: w.authorOf(h, source), damage: damage, ticks: ticks,
				every: ticksFor(def.IntervalMs)}
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
			// equal one that added hits, takes over the experience share (and, on a
			// player, the attack: T5.2).
			if damage > c.damage || damage == c.damage && c.ticks > before {
				c.damage, c.source, c.author = damage, source, w.authorOf(h, source)
			}
		}
		w.conditionsChanged(h)
		return
	}
	limit := ctx.Tick + ticksFor(def.MaxMs)
	end := min(ctx.Tick+dur, limit)
	if c == nil {
		c = &condition{def: def, source: source, author: w.authorOf(h, source)}
		w.scheduleCondition(ctx, h, c, end)
		*list = append(*list, c)
		w.conditionStarted(ctx, h, c)
		w.conditionsChanged(h)
		return
	}
	// A new application only moves the end: source and author stay those of the first.
	// Only a damage condition's author acts (its hits are an attack); the author of a slow
	// is saved with it and only gives back, after a relog, its holder's memory of that
	// player's attack (recallHit), which an attack of its own keeps anyway.
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
		if w.inProtection(p.pos) {
			return
		}
		if a, pvp := w.pvpSource(c, p); pvp {
			// T5.2: another player's condition is that player's attack. It hurts only while
			// its author is in the world (link-dead counts) and could attack p now, and it
			// never starts an unjustified attack (see conditionMayHurt).
			if a != nil && w.conditionMayHurt(ctx.Tick, a, p) {
				w.hurtPlayer(ctx, a, p, c.damage, el, false)
			}
			return
		}
		w.damagePlayer(ctx, p, c.damage, el)
		return
	}
	m := h.m
	if src := w.playerByID(c.source); src != nil && w.beyondLeash(ctx.Tick, m, src) {
		// A burn whose author stands where m may not go and cannot hit back ends without
		// hurting: no kill from out of its leash. Only that condition: m keeps its fight
		// (someone inside its leash may be killing it).
		w.dropCondition(ctx, h, c)
		return
	}
	dmg := min(combat.Resist(c.damage, m.kind.def.Resistances[el]), m.health)
	m.health -= dmg
	m.calmAt = ctx.Tick
	if dmg > 0 && c.source != 0 {
		// Like a hit (damageMonster): unanswered while m's attacks do not reach its author.
		src := w.playerByID(c.source)
		w.addShare(ctx.Tick, m, c.source, dmg, src == nil || !w.strikes(m, src.pos))
		w.contribute(ctx, src)
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
// several changes in one tick cost one message), or if its statuses did (status.go): the
// conditions first, in their order, then the statuses.
func (w *World) sendConditions(now game.Tick, p *Player) {
	st := w.statusOf(now, p)
	if !p.conditionsDirty && !st.stale(p.statusTold) {
		return
	}
	p.conditionsDirty = false
	p.statusTold = st
	msg := &pb.PlayerConditions{Conditions: make([]*pb.ActiveCondition, 0, len(p.conds)+st.count())}
	for _, c := range p.conds {
		msg.Conditions = append(msg.Conditions, &pb.ActiveCondition{
			ConditionId: c.def.ID, RemainingMs: uint32(max(w.leftMs(c), 0)), Ticks: uint32(max(c.ticks, 0)),
		})
	}
	msg.Conditions = appendStatuses(msg.Conditions, st, now)
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

// ---- food (content audit m2) -----------------------------------------------------

// foodCondition is the condition eating gives: consumable.food_ms of it, added up to its
// max_ms. A regen condition: the vocation regeneration grows by its regen_pct.
const foodCondition = "well_fed"

// fedCondition returns the food condition of balance.yaml, or nil if there is none (food
// then only heals what it heals).
func (w *World) fedCondition() *content.ConditionDef {
	if def := w.cfg.Balance.Conditions[foodCondition]; def != nil && def.Kind == content.ConditionRegen {
		return def
	}
	return nil
}

// feed gives p foodMs more of the food condition, up to its max_ms.
func (w *World) feed(ctx *game.TickContext, p *Player, foodMs int) {
	if def := w.fedCondition(); def != nil {
		w.addCondition(ctx, holder{p: p}, def, 0, 0, 0, ticksFor(foodMs))
	}
}

// stomachFull reports whether p cannot eat def: pure food (it neither heals nor restores
// mana) whose food_ms would take the food condition past its max_ms. Food that also heals
// is always eaten (its time is capped).
func (w *World) stomachFull(p *Player, def *content.Item) bool {
	c, fed := def.Consumable, w.fedCondition()
	if c == nil || c.FoodMs <= 0 || c.HealHP > 0 || c.HealMP > 0 || fed == nil {
		return false
	}
	left := 0
	if cond := findCond(p.conds, foodCondition); cond != nil {
		left = w.leftMs(cond)
	}
	return left+c.FoodMs > fed.MaxMs
}

// regenPct is the sum of the regen_pct of the regen conditions in list (food).
func regenPct(list []*condition) int {
	pct := 0
	for _, c := range list {
		if c.def.Kind == content.ConditionRegen {
			pct += c.def.RegenPct
		}
	}
	return pct
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
		speed = withPct(p.baseSpeed+p.gear.speed, speedPct(p.conds)) // with its speed attribute
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
	speed = withPct(m.kind.speed[m.phase], speedPct(m.conds)) // with its phases' speed_mult
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

// combatSkill is p's level in skill id plus its skill conditions (keen_eye) and the skill
// attributes of its worn items: what attacks and spells use. Training, the skills panel
// and saves use the plain level.
func (w *World) combatSkill(p *Player, id string) int {
	lvl := w.skillLevel(p, id) + p.gear.skill[id] // and its worn skill attributes (attributes.go)
	for _, c := range p.conds {
		if c.def.Kind == content.ConditionSkill && c.def.Skill == id {
			lvl += c.def.Amount
		}
	}
	return lvl
}

// hide makes p invisible: the clients that knew it get CreatureDisappear (as a teleport:
// nothing tells them it still stands there, attack.go) and from now on nobody else is
// sent it (AOI filters it, docs/01-architecture.md "Trampas y anti-bot"). Monsters
// without sees_invisible drop it as a target on their next think.
func (w *World) hide(_ *game.TickContext, p *Player) {
	if p == nil || p.invisible {
		return
	}
	p.invisible = true
	w.eachObserver(p, p.pos, func(o *Player) {
		if o.forget(p.id) {
			o.emit(disappearMsg(p.id, goneTeleport))
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

// conditionStates returns p's conditions that survive a logout (def.Persists), with the
// player that applied each one, what p remembers of that player's attack and when it was
// saved (T5.2).
func (w *World) conditionStates(p *Player) []ConditionState {
	var out []ConditionState
	for _, c := range p.conds {
		if !c.def.Persists {
			continue
		}
		left := max(int(c.at)-int(w.nowTick()), 1) * int(game.TickDuration.Milliseconds())
		s := ConditionState{ID: c.def.ID, LeftMs: left, Ticks: c.ticks, Damage: c.damage, Author: c.author}
		if c.author != 0 {
			s.SavedAt = w.nowTime() // the time of nowTick, which left counts from
			if hit := hitFrom(p, c.author); hit != nil && !hit.arena {
				s.AuthorHit, s.AuthorUnjust = hit.when, hit.unjust
			}
		}
		out = append(out, s)
	}
	return out
}

// loadConditions gives a joining p its saved conditions. Unknown ones, or ones that do
// not persist any more, are dropped; hits and times are clamped to today's balance
// (max_ticks, interval_ms, max_ms). The saved damage is kept: it came from a source, and
// so is its author, with p's memory of that author's attack (recallHit).
//
// A condition of nobody (a monster's, the world's) waits frozen while p is away: logging
// out does not cure it. One of another player (T5.2) is that player's attack, which p must
// not hold back to land later (each hit renews its author's skull and lock, and p could
// choose the moment it kills): its time runs on while p is away, as in a protection zone,
// and the hits that would have fallen pass without damage (awayTicks, elapse). p's memory
// of that player's attack, saved with it, comes back on its own terms (recallHit: the
// aggressor time on the clock) even when the condition ran out meanwhile: a relog does not
// cut self-defense either.
func (w *World) loadConditions(ctx *game.TickContext, p *Player, saved []ConditionState) {
	h := holder{p: p}
	for _, s := range saved {
		if s.Author > 0 && s.Author != p.charID && !s.AuthorHit.IsZero() {
			w.recallHit(ctx, p, s.Author, s.AuthorHit, s.AuthorUnjust)
		}
		def := w.cfg.Balance.Conditions[s.ID]
		if def == nil || !def.Persists || findCond(p.conds, s.ID) != nil {
			continue
		}
		left := ticksFor(max(s.LeftMs, 1))
		c := &condition{def: def, author: max(s.Author, 0)}
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
		if c.author != 0 {
			away, ok := awayTicks(ctx, s.SavedAt)
			if !ok {
				continue
			}
			if left, ok = c.elapse(left, away); !ok {
				continue // it ran out while p was away
			}
		}
		w.scheduleCondition(ctx, h, c, ctx.Tick+left)
		p.conds = append(p.conds, c)
		if def.Kind != content.ConditionDamage {
			w.conditionStarted(ctx, h, c)
		}
	}
	p.conditionsDirty = len(p.conds) > 0 // a new client starts with none
}

// awayTicks is how long ago, in ticks, a condition with an author was saved at (rounded
// up: its hits never fall later than they would have). It is false when that cannot be
// told, and the condition then ends: no time saved (a row from before SavedAt), a clock
// behind the save, or a save from before this server's first tick (a restart since, whose
// downtime the clock may not measure). Ending it is safe both ways: its holder takes no
// hit that may have fallen long ago, and its author is not marked, locked or credited by
// an attack whose time nobody knows (recallHit forgets that attack after a restart too).
// The server's age is its ticks, as for recallHit: after a stall or a suspended machine
// (the loop does not catch up) an early save of this run may count as older, which only
// errs toward ending the condition.
func awayTicks(ctx *game.TickContext, savedAt time.Time) (game.Tick, bool) {
	if savedAt.IsZero() {
		return 0, false
	}
	away := ctx.Now.Sub(savedAt)
	if away < 0 {
		return 0, false
	}
	n := game.TicksFor(away)
	if n > ctx.Tick {
		return 0, false
	}
	return n, true
}

// elapse runs c, due in left ticks (its next hit, or its end), for away ticks without
// effect: the hits that fall meanwhile pass. It returns the ticks to c's next due time
// after that, and false if c ran out.
func (c *condition) elapse(left, away game.Tick) (game.Tick, bool) {
	if away < left {
		return left - away, true
	}
	if c.def.Kind != content.ConditionDamage {
		return 0, false
	}
	passed := 1 + (away-left)/c.every // c.every >= 1 (ticksFor)
	if passed >= game.Tick(c.ticks) {
		return 0, false
	}
	c.ticks -= int(passed)
	return left + passed*c.every - away, true
}

// authorOf is the author of a condition that creature source gives h: the character of
// source if h is a player and source another player in the world, else 0 (a monster's
// condition, nobody's, h's own, or one on a monster: its share is source).
func (w *World) authorOf(h holder, source uint32) int64 {
	if h.p == nil || source == 0 || h.p.id == source {
		return 0
	}
	if a := w.playerByID(source); a != nil {
		return a.charID
	}
	return 0
}

// nowTick is the current tick outside a TickContext (snapshots, flush): the scheduler's
// position, which the loop sets before commands run. 0 before anyone joined.
func (w *World) nowTick() game.Tick {
	if w.sched == nil {
		return 0
	}
	return w.sched.Now()
}

// nowTime is the clock time of nowTick (its TickContext.Now). Zero before anyone joined.
func (w *World) nowTime() time.Time {
	if w.sched == nil {
		return time.Time{}
	}
	return w.sched.Time()
}
