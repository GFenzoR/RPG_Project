package session

import (
	"fmt"
	"math"
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// ---- pursuit and regeneration --------------------------------------------------------
//
// Owner's request of 2026-11-23 (docs/02-game-design.md, monsters section): a monster's leash
// area (its spawn's radius + combat.monster_leash_tiles) is its comfort zone. Inside it, it
// always chases. A target beyond it and out of its reach it follows only while a roll of
// its persistence says so (every roll_ms, falling with the target's distance from home,
// its own and its target's health; one decision for its whole spawn, its pack), never
// farther than its chase cap (max_chase_tiles from its spawn's center). It gives up for
// sure when its target stays out of its sight lose_sight_ms, steps into a protection zone
// or changes floor. Giving up it keeps its wounds (but those it never got to answer, which
// close) and walks home; it remembers who hurt it and their damage (memory_ms) and turns on
// them first when they come back into its comfort zone. Out of
// combat it regenerates slowly (combat.monster_regen). An idle monster out of its home
// area thinks even where no player is, so it walks home; one stuck away monster_stray_ms
// goes back to its spawn when nobody sees it.

// pursuitKind is a monster kind's pursuit and regeneration, resolved from balance
// combat.monster_pursuit / monster_regen and its own pursuit / regen blocks.
type pursuitKind struct {
	persistence float64
	// maxChase is the chase cap (Chebyshev from its spawn's center).
	maxChase int
	// loseFor: a target out of its sight this long is lost (0: at once).
	loseFor game.Tick
	rollFor game.Tick
	// giveUpPct: below this % of its health it does not chase beyond its leash area;
	// insistPct: a target below this % of its health halves its chance of giving up.
	giveUpPct, insistPct int
	// regenDelay without a fight, then regenPct % of its maximum health every regenEvery
	// (regenPct 0: none).
	regenDelay, regenEvery game.Tick
	regenPct               float64
}

// packRoll is the last pursuit decision of the monsters of one spawn: whether they keep
// chasing target, until when.
type packRoll struct {
	target uint32
	until  game.Tick
	keep   bool
}

// initPursuit reads the balance's pursuit numbers that are not per monster.
func (w *World) initPursuit() {
	c := w.cfg.Balance.Combat
	w.memoryFor, w.strayFor = 0, 0
	if c.MonsterPursuit.MemoryMs > 0 {
		w.memoryFor = ticksFor(c.MonsterPursuit.MemoryMs)
	}
	if c.MonsterStrayMs > 0 {
		w.strayFor = ticksFor(c.MonsterStrayMs)
	}
	w.packs = map[*world.Spawn]packRoll{}
}

// pursuitOf resolves def's pursuit and regeneration against the balance's defaults, and
// checks the result: a monster's own persistence or regeneration needs the balance's
// roll_ms or an interval_ms (ParseMonster cannot tell: it does not know the balance), or
// it would roll, or heal, every tick.
func (w *World) pursuitOf(def *content.Monster) (pursuitKind, error) {
	c := w.cfg.Balance.Combat
	p := def.Pursuit.Resolve(c.MonsterPursuit)
	r := def.Regen.Resolve(c.MonsterRegen)
	if err := p.Check(); err != nil {
		return pursuitKind{}, fmt.Errorf("pursuit (with balance combat.monster_pursuit): %w", err)
	}
	if err := r.Check(); err != nil {
		return pursuitKind{}, fmt.Errorf("regen (with balance combat.monster_regen): %w", err)
	}
	k := pursuitKind{persistence: p.Persistence, maxChase: p.MaxChaseTiles,
		giveUpPct: p.GiveUpBelowHpPct, insistPct: p.InsistTargetHpPct, regenPct: r.Pct}
	if p.LoseSightMs > 0 {
		k.loseFor = ticksFor(p.LoseSightMs)
	}
	k.rollFor = ticksFor(c.MonsterPursuit.RollMs)
	if r.DelayMs > 0 {
		k.regenDelay = ticksFor(r.DelayMs)
	}
	if r.Pct > 0 {
		k.regenEvery = ticksFor(r.IntervalMs)
	}
	return k, nil
}

// chaser is the pursuit m follows: its master's for a summon (a boss's summons stay in
// its arena with it), else its own kind's.
func (m *Monster) chaser() *pursuitKind {
	if m.master != nil {
		return &m.master.kind.pursuit
	}
	return &m.kind.pursuit
}

// chaseCap returns how far (Chebyshev from its spawn's center) m may ever chase: its
// chase cap, never less than its leash area (leash >= 0).
func (w *World) chaseCap(m *Monster, leash int) int {
	return max(leash, m.chaser().maxChase)
}

// bound returns the radius of the square around its spawn's center m may fight in now:
// its chase cap while it pursues a target beyond its leash area, else its leash area; -1
// without a leash.
func (w *World) bound(m *Monster) int {
	l := w.leash(m)
	if l < 0 || !m.pursuing {
		return l
	}
	return w.chaseCap(m, l)
}

// judgePursuit decides, each think, whether m chases its target t beyond its leash area
// (m.pursuing): never with t inside it (no need) or beyond its chase cap (never); with t
// within its reach it keeps what it was doing (it fights from where it stands); else it
// asks keepChasing.
func (w *World) judgePursuit(ctx *game.TickContext, m *Monster, t *Player) {
	l := w.leash(m)
	if l < 0 {
		return
	}
	d := chebyshev(t.pos, m.slot.spawn.Center)
	switch {
	case d <= l || d > w.chaseCap(m, l):
		m.pursuing = false
	case w.strikes(m, t.pos):
	default:
		m.pursuing = w.keepChasing(ctx, m, t, d, l)
	}
}

// keepChasing returns m's decision on chasing t, d tiles from its spawn's center, beyond
// its leash area l: never with its health below give_up_below_hp_pct (cowed: it turns back
// alone, the rest of its pack goes on); else the one it rolled on t less than roll_ms ago, else the one its pack (its
// spawn) took on t then, else a new roll of pursuitChance with the loop's seeded random
// source (none for a chance of 0 or 1: a monster that never chases costs no draw).
func (w *World) keepChasing(ctx *game.TickContext, m *Monster, t *Player, d, l int) bool {
	if m.cowed() {
		return false // whatever it or its pack rolled: its own decision, not its pack's
	}
	if m.rolledOn == t.id && ctx.Tick < m.rollAt {
		return m.keep
	}
	pk := m.chaser()
	sp := m.slot.spawn
	if pr, ok := w.packs[sp]; ok && pr.target == t.id && ctx.Tick < pr.until {
		m.rolledOn, m.rollAt, m.keep = t.id, pr.until, pr.keep
		return pr.keep
	}
	keep := false
	switch c := w.pursuitChance(m, t, d, l); {
	case c >= 1:
		keep = true
	case c > 0:
		keep = ctx.Rand.Float64() < c
	}
	m.rolledOn, m.rollAt, m.keep = t.id, ctx.Tick+pk.rollFor, keep
	w.packs[sp] = packRoll{target: t.id, until: m.rollAt, keep: keep}
	return keep
}

// pursuitChance is the chance that m keeps chasing t, d tiles from its spawn's center
// beyond its leash area l: persistence^(1 + 2·(d-l)/(cap-l)), which falls with the distance
// from home, from about the persistence just out of the leash area to its cube at the chase
// cap (0.85: 0.61; 0.5: 0.125; 0.15: 0.003), and stays 1 for a persistence of 1; 0 with
// its own health below give_up_below_hp_pct; with t's health below insist_target_hp_pct,
// halfway to 1.
func (w *World) pursuitChance(m *Monster, t *Player, d, l int) float64 {
	pk := m.chaser()
	c := pk.persistence
	span := w.chaseCap(m, l) - l
	if c <= 0 || span <= 0 || m.cowed() {
		return 0
	}
	c = math.Pow(c, 1+2*float64(d-l)/float64(span))
	if pk.insistPct > 0 && t.health*100 < pk.insistPct*max(t.maxHealth, 1) {
		c += (1 - c) / 2
	}
	return c
}

// keepsTrack reports whether m keeps target t: still in the world, on its floor (monsters
// do not take stairs), out of protection zones, not invisible to it and, out of its sight
// (InSight), for less than lose_sight_ms (0: lost at once). Every think measures it.
func (w *World) keepsTrack(tick game.Tick, m *Monster, t *Player) bool {
	if w.byClient[t.client] != t || t.pos.Z != m.pos.Z || w.inProtection(t.pos) || !seesPlayer(m, t) {
		return false
	}
	if InSight(m.pos, t.pos) {
		m.lostAt = 0
		return true
	}
	lose := m.chaser().loseFor
	if lose == 0 {
		return false
	}
	if m.lostAt == 0 {
		m.lostAt = max(tick, 1)
	}
	return tick-m.lostAt < lose
}

// remember has m remember player id, who hurt it in a fight it gave up, for memory_ms (none
// without a memory).
func (w *World) remember(tick game.Tick, m *Monster, id uint32) {
	if w.memoryFor == 0 {
		return
	}
	until := tick + w.memoryFor
	for i := range m.foes {
		if m.foes[i].player == id {
			m.foes[i].until = until
			return
		}
	}
	m.foes = append(m.foes, grudge{player: id, until: until})
}

// remembered returns the closest player who hurt m (in this fight, its damage shares, or
// in one it gave up, its foes) that it may fight again: a valid target, in line of sight,
// within its leash area (or its reach) and not beyond its leash; or nil. An idle monster
// turns on them before anyone else.
func (w *World) remembered(tick game.Tick, m *Monster) *Player {
	var best *Player
	bestD := 0
	l := w.leash(m)
	try := func(id uint32) {
		p := w.playerByID(id)
		if p == nil || !w.validTarget(m, p) || w.beyondLeash(tick, m, p) ||
			l >= 0 && chebyshev(p.pos, m.slot.spawn.Center) > l && !w.strikes(m, p.pos) {
			return
		}
		if d := chebyshev(m.pos, p.pos); (best == nil || d < bestD) && w.m.LineOfSight(m.pos, p.pos) {
			best, bestD = p, d
		}
	}
	for _, s := range m.damage {
		try(s.player)
	}
	for _, f := range m.foes {
		try(f.player)
	}
	return best
}

// forget drops the foes m remembers whose memory_ms ran out since their last hit, and
// with each the damage it dealt (the share giveUp kept).
func (w *World) forget(tick game.Tick, m *Monster) {
	if len(m.foes) == 0 {
		return
	}
	m.foes = slices.DeleteFunc(m.foes, func(f grudge) bool {
		if tick < f.until {
			return false
		}
		m.damage = slices.DeleteFunc(m.damage, func(s damageShare) bool { return s.player == f.player })
		return true
	})
}

// regen heals an idle, wounded m regen pct % of its maximum health (at least 1) for every
// interval due since regen delay went by without a fight (calmAt: the last tick it had a
// target, dealt or took damage): counted from the ticks, so time it spent where nobody
// was (no think) counts too. What it heals comes first out of the wounds it never
// answered (damageShare.unanswered), so a later giveUp does not close them again. Who
// sees it gets the new health bar, without the effect and the number of a heal. Healed to
// full it forgets the damage of a fight it lost track of (its target hid in a protection
// zone, left): nobody earns experience from a fight it recovered from.
func (w *World) regen(ctx *game.TickContext, m *Monster) {
	pk := &m.kind.pursuit
	if pk.regenEvery == 0 || m.health >= m.maxHealth {
		return
	}
	due := max(m.regenAt, m.calmAt+pk.regenDelay+pk.regenEvery)
	if ctx.Tick < due {
		return
	}
	n := 1 + int((ctx.Tick-due)/pk.regenEvery)
	m.regenAt = due + game.Tick(n)*pk.regenEvery
	per := max(int(float64(m.maxHealth)*pk.regenPct/100+0.5), 1)
	heal := min(n*per, m.maxHealth-m.health)
	m.health += heal
	if m.health >= m.maxHealth {
		m.damage = m.damage[:0]
	}
	for i := range m.damage {
		s := &m.damage[i]
		c := min(s.unanswered, heal)
		s.unanswered -= c
		heal -= c
	}
	w.healthChanged(m)
}

// trackStray keeps a monster with a leash that stands out of its home area in
// World.strays, so it thinks (and walks home) even when its sector has no player near: the
// player it chased logged out or went far. Home, it leaves the list. awaySince is the last
// tick it was home or had a target.
func (w *World) trackStray(tick game.Tick, m *Monster) {
	if w.leash(m) < 0 {
		return
	}
	sp := m.slot.spawn
	away := chebyshev(m.pos, sp.Center) > int(sp.Radius)
	if !away || m.target != nil {
		m.awaySince = tick
	}
	switch {
	case !away:
		m.stray = false
	case !m.stray:
		m.stray = true
		if !slices.Contains(w.strays, m) {
			w.strays = append(w.strays, m)
		}
	}
}

// straying is an idle m out of its home area (walkHome): once it has been so
// monster_stray_ms without getting home and no player has it on screen (onScreen), it goes
// back to its spawn (retire).
func (w *World) straying(ctx *game.TickContext, m *Monster) {
	if w.strayFor > 0 && ctx.Tick-m.awaySince >= w.strayFor && m.master == nil && !w.onScreen(m.pos) {
		w.retire(ctx, m)
	}
}

// onScreen reports whether any player has p in its view (the wide one, eachObserver; not
// the classic window a monster notices players in, watched): who would see a monster
// there vanish.
func (w *World) onScreen(p world.Pos) bool {
	seen := false
	w.eachObserver(nil, p, func(*Player) { seen = true })
	return seen
}

// retire takes a stray m out of the world (DESPAWN, nobody sees it) and has its spawn bring
// it back: no monster stays lost where it can never get home, the spawn does not count it
// alive forever. It keeps nothing: no experience, no loot.
func (w *World) retire(ctx *game.TickContext, m *Monster) {
	w.clearConditions(ctx, holder{m: m}, true)
	w.removeMonster(m, goneDespawn)
	w.despawnSummons(ctx, m)
	w.scheduleRespawn(ctx, m.slot, respawnRetry)
}

// thinkStrays has the strays that did not think this tick (their sector has no player
// near) think: they walk home. Those home or gone leave the list.
func (w *World) thinkStrays(ctx *game.TickContext) {
	if len(w.strays) == 0 {
		return
	}
	w.strays = slices.DeleteFunc(w.strays, func(m *Monster) bool { return !m.stray })
	w.thinkBuf = append(w.thinkBuf[:0], w.strays...)
	for _, m := range w.thinkBuf {
		if m.stray && m.thought != ctx.Tick {
			m.thought = ctx.Tick
			w.think(ctx, m)
		}
	}
	clear(w.thinkBuf)
}
