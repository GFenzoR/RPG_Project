package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Monster abilities (docs/02-game-design.md and docs/06, the monsters sections), all data in
// data/monsters: area attacks (a circle around the monster or its target, or a beam),
// heal_self and summon attacks, and a boss's phases.

// ---- areas ---------------------------------------------------------------------------

// monsterArea casts m's area attack a: one attackEvent with the area, an Effect of its
// element on every tile it covers, then a hit on every player in it that m sees, out of
// protection zones, each with its own roll (monsterHit: the attack's element, armor for a
// physical one, its condition).
//   - circle: radius tiles (inArea) around m or around its target (center), every tile in
//     line of sight from the centre: a wall shields what is behind it;
//   - beam: length tiles in a straight line from m towards its target (beamDir), up to the
//     first tile that blocks sight.
//
// An area aimed at a hidden target (an invisible player m sees, at the centre of the
// circle or where the beam points) shows only to the clients that see that player, as a
// shot at it would (projectileAt): its tiles would give the target's away.
func (w *World) monsterArea(ctx *game.TickContext, m *Monster, a *content.MonsterAttack) {
	t, ar := m.target, a.Area
	centre, r := m.pos, ar.Radius
	tiles := w.areaTiles[:0]
	aimed := true
	switch {
	case ar.Shape == content.AreaBeam:
		r = ar.Length
		tiles = w.beamTiles(m.pos, beamDir(m, t.pos), ar.Length, tiles)
	case ar.Center == content.AreaTarget:
		centre = t.pos
		tiles = w.circleTiles(centre, r, tiles)
	default:
		aimed = false
		tiles = w.circleTiles(centre, r, tiles)
	}
	var hidden *Player
	if aimed && t.invisible {
		hidden = t
	}
	w.monsterAreaEvent(m, monsterAttackKind(a.Type), centre, r, hidden)
	if centre != m.pos && a.Type != attackMelee {
		w.projectileAt(m.pos, t, a.Element) // a shot that bursts around its target
	}
	effect := elementEffect(a.Element)
	for _, to := range tiles {
		msg := &pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: posMsg(to), EffectId: effect}}}
		if hidden == nil {
			w.eachObserver(nil, to, func(o *Player) { o.emit(msg) })
			continue
		}
		w.eachWatcher(hidden, func(o *Player) {
			if Sees(o.pos, to) {
				o.emit(msg)
			}
		})
	}
	// Collect first: a player that dies wakes up at a temple, maybe on a tile of the area.
	hit := w.areaHit[:0]
	for _, to := range tiles {
		if p := w.creatureAt(to); p != nil && !w.inProtection(to) && seesPlayer(m, p) {
			hit = append(hit, p)
		}
	}
	for _, p := range hit {
		if w.byClient[p.client] != p || !slices.Contains(tiles, p.pos) {
			continue // left, or died (and woke up at a temple) during this attack
		}
		if p != t {
			w.fought(ctx, m, p)
		}
		w.monsterHit(ctx, m, a, p)
	}
	clear(hit)
	w.areaHit, w.areaTiles = hit[:0], tiles[:0]
}

// circleTiles appends to dst the tiles of the round area of radius r around c (inArea)
// that c has line of sight to, row by row: what an area spell or a monster's circle
// covers (a wall tile itself is covered, what it hides is not).
func (w *World) circleTiles(c world.Pos, r int, dst []world.Pos) []world.Pos {
	for dy := -r; dy <= r; dy++ {
		for dx := -r; dx <= r; dx++ {
			x, y := int(c.X)+dx, int(c.Y)+dy
			if !inArea(dx, dy, r) || x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
				continue
			}
			to := world.Pos{X: uint16(x), Y: uint16(y), Z: c.Z}
			if (dx != 0 || dy != 0) && !w.m.LineOfSight(c, to) {
				continue
			}
			dst = append(dst, to)
		}
	}
	return dst
}

// beamTiles appends to dst the n tiles of a beam from `from` (not included) in direction
// d, up to the first tile that blocks sight (or the edge of the map), which it does not
// cover.
func (w *World) beamTiles(from world.Pos, d world.Direction, n int, dst []world.Pos) []world.Pos {
	at := from
	for range n {
		next, ok := at.Step(d)
		if !ok {
			break
		}
		if _, f, ok := w.m.Tile(next); !ok || f&world.FlagBlocksSight != 0 {
			break
		}
		dst = append(dst, next)
		at = next
	}
	return dst
}

// beamReaches reports whether a beam from `from` gets to `to`, on one of the 8 lines from
// it (the caller checked): no tile on the way, `to` included, blocks sight (beamTiles).
func (w *World) beamReaches(from, to world.Pos) bool {
	sx, sy := sign(int(to.X)-int(from.X)), sign(int(to.Y)-int(from.Y))
	at := from
	for at != to {
		at = world.Pos{X: uint16(int(at.X) + sx), Y: uint16(int(at.Y) + sy), Z: from.Z}
		if _, f, ok := w.m.Tile(at); !ok || f&world.FlagBlocksSight != 0 {
			return false
		}
	}
	return true
}

// beamDir is the direction of the 8 nearest to the line from m to p: straight when one
// difference is more than twice the other, diagonal otherwise (where m faces, if p is on
// its tile).
func beamDir(m *Monster, p world.Pos) world.Direction {
	dx, dy := int(p.X)-int(m.pos.X), int(p.Y)-int(m.pos.Y)
	switch {
	case abs(dx) > 2*abs(dy):
		dy = 0
	case abs(dy) > 2*abs(dx):
		dx = 0
	}
	for d := range world.Direction(8) {
		if ddx, ddy := d.Delta(); ddx == sign(dx) && ddy == sign(dy) {
			return d
		}
	}
	return m.dir
}

func sign(v int) int {
	switch {
	case v > 0:
		return 1
	case v < 0:
		return -1
	}
	return 0
}

// ---- heal_self, summon ---------------------------------------------------------------

// monsterSelf runs m's heal_self and summon attacks that are due and in use (their phase
// on, its health below their below_hp_pct). They need a fight (a target), not a target in
// reach. A heal at full health, or a summon with all its monsters alive, waits: its round
// is not spent.
func (w *World) monsterSelf(ctx *game.TickContext, m *Monster) {
	for i := range m.kind.attacks {
		ka := &m.kind.attacks[i]
		a := ka.def
		if ka.reach != 0 || ctx.Tick < m.nextAttack[i] || ka.phase > m.phase || !m.below(a.BelowHealthPct) {
			continue
		}
		switch a.Type {
		case attackHealSelf:
			if m.health >= m.maxHealth {
				continue
			}
		case attackSummon:
			if m.summoned(i) >= a.Summon.MaxAlive {
				continue
			}
		}
		m.nextAttack[i] = ctx.Tick + m.kind.ticks[m.phase][i]
		if a.Chance < 1 && ctx.Rand.Float64() >= a.Chance {
			continue
		}
		if a.Type == attackHealSelf {
			w.healMonster(m, combat.Roll(ctx.Rand, a.Min, a.Max))
		} else {
			w.summon(ctx, m, i)
		}
	}
}

// healMonster gives m up to amount health, with the heal's effect for who sees it and,
// if it healed any (a heal of min 0 may roll 0), its floating text and the new health bar
// (as a player's heal: no green 0).
func (w *World) healMonster(m *Monster, amount int) {
	hp := min(max(amount, 0), m.maxHealth-m.health)
	m.health += hp
	at := posMsg(m.pos)
	shown := &pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: at, EffectId: EffectHeal}}}
	var text, bar *pb.ServerMessage
	if hp > 0 {
		text = &pb.ServerMessage{Message: &pb.ServerMessage_FloatingText{FloatingText: &pb.FloatingText{
			Pos: at, Kind: pb.FloatingTextKind_FLOATING_TEXT_KIND_HEAL, Amount: uint64(hp),
		}}}
		bar = &pb.ServerMessage{Message: &pb.ServerMessage_CreatureHealth{CreatureHealth: &pb.CreatureHealth{
			Id: m.id, HealthPercent: healthPercent(m.health, m.maxHealth),
		}}}
	}
	w.eachObserver(nil, m.pos, func(o *Player) {
		if !o.Knows(m.id) {
			return
		}
		o.emit(shown)
		if hp > 0 {
			o.emit(text)
			o.emit(bar)
		}
	})
}

// summoned counts m's summons in the world that its attack i called.
func (m *Monster) summoned(i int) int {
	n := 0
	for _, s := range m.summons {
		if s.summonOf == i {
			n++
		}
	}
	return n
}

// summon calls what m's attack i summons: up to its count, never beyond max_alive, each on
// a tile next to m that a monster may enter (the first one tried is random), with the
// conjuring effect; with no such tile, fewer. A summon fights m's target from the start
// and shares m's spawn
// (its leash area and its home), but gives no experience nor loot and never respawns
// (killMonster); it goes when m dies or gives up (despawnSummons).
func (w *World) summon(ctx *game.TickContext, m *Monster, i int) {
	s := m.kind.attacks[i].def.Summon
	k := w.kinds[s.Monster]
	n := min(s.Count, s.MaxAlive-m.summoned(i))
	first := ctx.Rand.IntN(8)
	for j := 0; j < 8 && n > 0; j++ {
		d := world.Direction((first + j) % 8)
		to, ok := m.pos.Step(d)
		if !ok || !w.monsterCanEnter(to) {
			continue
		}
		n--
		c := w.placeMonster(k, m.slot, to)
		c.master, c.summonOf = m, i
		m.summons = append(m.summons, c)
		msg := &pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: posMsg(to), EffectId: EffectConjure}}}
		w.eachObserver(nil, to, func(o *Player) { o.emit(msg) })
		if t := m.target; t != nil && w.validTarget(c, t) {
			c.setTarget(t)
			c.state = StateAlert
			w.face(c, t.pos)
		}
	}
}

// despawnSummons takes m's summons out of the world (their master died or gave up).
func (w *World) despawnSummons(ctx *game.TickContext, m *Monster) {
	for len(m.summons) > 0 {
		s := m.summons[len(m.summons)-1]
		s.thought = ctx.Tick // gone: not thought again this tick (combatSystem)
		w.clearConditions(ctx, holder{m: s}, true)
		w.removeMonster(s, goneDespawn) // drops it from m.summons
	}
}

// ---- phases ----------------------------------------------------------------------------

// updatePhase puts m in the phases its health has reached (the first ones: they are
// sorted from the highest below_hp_pct), or takes it out of them once it healed: its
// speed follows (speed_mult), its attacks and their intervals are read by phase. Entering
// a phase shows the condition effect on it.
func (w *World) updatePhase(m *Monster) {
	ps := m.kind.def.Phases
	n := 0
	for n < len(ps) && m.below(ps[n].BelowHealthPct) {
		n++
	}
	if n == m.phase {
		return
	}
	entered := n > m.phase
	m.phase = n
	w.refreshSpeed(holder{m: m})
	if !entered {
		return
	}
	msg := &pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: posMsg(m.pos), EffectId: EffectBuff}}}
	w.eachObserver(nil, m.pos, func(o *Player) {
		if o.Knows(m.id) {
			o.emit(msg)
		}
	})
}
