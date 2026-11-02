package session

import (
	"errors"
	"fmt"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// CorpseItem is the item (data/items) left where a monster dies, with its loot.
const CorpseItem = "creature_remains"

// AIState is the state of a monster's behaviour (docs/02-game-design.md, monsters section):
// idle → alert → chase → attack → flee (with little health).
type AIState uint8

const (
	// StateIdle means no target; the monster wanders around its spawn.
	StateIdle AIState = iota
	// StateAlert means it just noticed a player (or was hit) and turns to face it.
	StateAlert
	// StateChase means it walks towards its target.
	StateChase
	// StateAttack means it stands next to its target and attacks on its own timers.
	StateAttack
	// StateFlee means its health fell to behavior.flee_at_health_pct; it runs away.
	StateFlee
)

func (s AIState) String() string {
	return [...]string{"idle", "alert", "chase", "attack", "flee"}[s]
}

const (
	// activeSectorRadius: a sector is active when a player is less than this many
	// sectors away (docs/01-architecture.md). Monsters elsewhere neither think nor move.
	activeSectorRadius = 2
	// wanderOdds: an idle monster that can step takes a random step with chance 1/n per
	// tick (about once a second).
	wanderOdds = 20
	// respawnRetry is how long a respawn waits when a player is looking at the chosen
	// tile, or there is no free tile.
	respawnRetry = game.Tick(5 * 1000 / 50)
	// spawnTries is how many random tiles a respawn tries in the spawn's radius.
	spawnTries = 16
	// targetScanTicks: an idle aggressive monster looks for a target every 250 ms.
	targetScanTicks = 5
)

// monsterKind is a monster definition prepared for the loop.
type monsterKind struct {
	def         *content.Monster
	target      combat.MonsterTarget
	loot        []lootItem
	attackTicks []game.Tick
}

type lootItem struct {
	def    *content.Item
	chance float64
	lo, hi int
}

// spawnSlot is one monster a spawn keeps alive.
type spawnSlot struct {
	spawn *world.Spawn
	kind  *monsterKind
}

// Monster is a monster in the world. Loop goroutine only.
type Monster struct {
	id        uint32
	kind      *monsterKind
	slot      *spawnSlot
	pos       world.Pos
	dir       world.Direction
	health    int
	maxHealth int
	state     AIState
	target    *Player
	// readyAt is the first tick at which the next step may start.
	readyAt game.Tick
	// nextAttack is the first tick of each attack's next round (kind.def.Attacks order).
	nextAttack []game.Tick
	// damage is the damage each player dealt, to share the experience.
	damage []damageShare
	// thought is the last tick the monster thought (it may change sector mid-tick).
	thought game.Tick
}

type damageShare struct {
	player uint32
	amount int
}

// ID returns the monster's creature id.
func (m *Monster) ID() uint32 { return m.id }

// Kind returns the monster's data/monsters id.
func (m *Monster) Kind() string { return m.kind.def.ID }

// Pos returns where the monster stands.
func (m *Monster) Pos() world.Pos { return m.pos }

// Health returns the monster's current and maximum health.
func (m *Monster) Health() (cur, maxHealth int) { return m.health, m.maxHealth }

// State returns the monster's AI state.
func (m *Monster) State() AIState { return m.state }

// TargetID returns the creature id of the player the monster fights, or 0.
func (m *Monster) TargetID() uint32 {
	if m.target == nil {
		return 0
	}
	return m.target.id
}

// Corpse is what a dead monster leaves: a container item (CorpseItem) with its loot.
type Corpse struct {
	Monster string
	Item    *Item
}

// Loot returns what is left inside the remains.
func (c *Corpse) Loot() []*pb.ItemStack { return c.Item.stacks() }

// Monsters returns the monsters in the world ordered by creature id. Loop goroutine only.
func (w *World) Monsters() []*Monster { return w.monsters }

// CorpsesAt returns the remains lying on p, oldest first. Loop goroutine only.
func (w *World) CorpsesAt(p world.Pos) []*Corpse { return w.corpses[p] }

func ticksFor(ms int) game.Tick {
	return max(game.TicksFor(time.Duration(ms)*time.Millisecond), 1)
}

// initCombat checks the combat balance and prepares monster kinds and spawn slots.
func (w *World) initCombat() error {
	c := w.cfg.Balance.Combat
	if c.AttackIntervalMs <= 0 || c.FistAttack <= 0 || c.SkillAttackDivisor <= 0 || c.LevelDivisor <= 0 ||
		c.ShieldBlockDivisor <= 0 || c.MonsterCorpseMs <= 0 {
		return fmt.Errorf("session: invalid combat balance %+v", c)
	}
	for _, s := range content.Stances {
		if _, ok := c.Modes[s]; !ok {
			return fmt.Errorf("session: combat.modes.%s missing", s)
		}
	}
	w.attackFor = ticksFor(c.AttackIntervalMs)
	w.corpseFor = ticksFor(c.MonsterCorpseMs)
	w.monByID = map[uint32]*Monster{}
	w.msectors = map[uint64][]*Monster{}
	w.kinds = map[string]*monsterKind{}
	w.active = map[uint64]struct{}{}
	w.ground = map[world.Pos][]*Item{}
	w.corpses = map[world.Pos][]*Corpse{}
	if w.cfg.Monsters == nil {
		return nil
	}
	corpse := w.cfg.Items[CorpseItem]
	if corpse == nil || corpse.Container == nil {
		return errors.New("session: container item " + CorpseItem + " is required with monsters")
	}
	w.corpseItem = corpse
	for _, id := range w.cfg.Monsters.IDs() {
		def := w.cfg.Monsters[id]
		k := &monsterKind{def: def, target: combat.MonsterTarget{
			Armor: def.Armor, Defense: def.Defense, PhysicalResistance: def.Resistances["physical"],
		}}
		for _, a := range def.Attacks {
			k.attackTicks = append(k.attackTicks, ticksFor(a.IntervalMs))
		}
		for _, l := range def.Loot {
			it := w.cfg.Items[l.Item]
			if it == nil {
				return fmt.Errorf("session: monster %q drops unknown item %q", id, l.Item)
			}
			lo, hi := l.CountRange()
			k.loot = append(k.loot, lootItem{def: it, chance: l.Chance, lo: lo, hi: hi})
		}
		w.kinds[id] = k
	}
	for _, is := range w.m.Islands() {
		for i := range is.Spawns {
			sp := &is.Spawns[i]
			for _, sm := range sp.Monsters {
				k := w.kinds[sm.Monster]
				if k == nil {
					return fmt.Errorf("session: spawn %q: unknown monster %q", sp.ID, sm.Monster)
				}
				for range sm.Count {
					w.slots = append(w.slots, &spawnSlot{spawn: sp, kind: k})
				}
			}
		}
	}
	return nil
}

// ---- spatial index ---------------------------------------------------------------

func (w *World) mindex(m *Monster) {
	k := sectorKey(int(m.pos.X), int(m.pos.Y), m.pos.Z)
	w.msectors[k] = append(w.msectors[k], m)
}

func (w *World) munindex(m *Monster) {
	k := sectorKey(int(m.pos.X), int(m.pos.Y), m.pos.Z)
	list := w.msectors[k]
	for i, q := range list {
		if q == m {
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(w.msectors, k)
	} else {
		w.msectors[k] = list
	}
}

func (w *World) monsterAt(p world.Pos) *Monster {
	for _, m := range w.msectors[sectorKey(int(p.X), int(p.Y), p.Z)] {
		if m.pos == p {
			return m
		}
	}
	return nil
}

// eachMonsterInRect is eachInRect for monsters.
func (w *World) eachMonsterInRect(x0, y0, x1, y1 int, z uint8, fn func(*Monster)) {
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, 0xFFFF), min(y1, 0xFFFF)
	if x0 > x1 || y0 > y1 || len(w.msectors) == 0 {
		return
	}
	var floors [SeaLevel + 1]uint8
	for _, f := range viewFloors(z, floors[:0]) {
		for sy := y0 / world.SectorSize; sy <= y1/world.SectorSize; sy++ {
			for sx := x0 / world.SectorSize; sx <= x1/world.SectorSize; sx++ {
				for _, m := range w.msectors[uint64(f)<<32|uint64(sx)<<16|uint64(sy)] {
					x, y := int(m.pos.X), int(m.pos.Y)
					if x >= x0 && x <= x1 && y >= y0 && y <= y1 {
						fn(m)
					}
				}
			}
		}
	}
}

func (w *World) monsterMsg(m *Monster) *pb.Creature {
	return &pb.Creature{
		Id:            m.id,
		Kind:          pb.CreatureKind_CREATURE_KIND_MONSTER,
		ContentId:     m.kind.def.ID,
		Pos:           posMsg(m.pos),
		Dir:           dirMsg(m.dir),
		HealthPercent: healthPercent(m.health, m.maxHealth),
		Speed:         uint32(m.kind.def.Speed),
	}
}

func healthPercent(cur, maxHealth int) uint32 {
	if cur <= 0 {
		return 0
	}
	return uint32(max(cur*100/max(maxHealth, 1), 1)) // alive never shows 0 %
}

// ---- spawns ----------------------------------------------------------------------

// watched reports whether any player sees tile p.
func (w *World) watched(p world.Pos) bool {
	seen := false
	w.eachObserver(nil, p, func(*Player) { seen = true })
	return seen
}

// monsterCanEnter reports whether a monster may stand on p: walkable, free and outside
// protection zones.
func (w *World) monsterCanEnter(p world.Pos) bool {
	return w.m.Walkable(p) && w.m.Flags(p)&world.FlagProtection == 0 && !w.occupied(p)
}

// spawnTile picks a random tile a monster can enter within the spawn's radius.
func (w *World) spawnTile(ctx *game.TickContext, sp *world.Spawn) (world.Pos, bool) {
	r := int(sp.Radius)
	for range spawnTries {
		x := int(sp.Center.X) + ctx.Rand.IntN(2*r+1) - r
		y := int(sp.Center.Y) + ctx.Rand.IntN(2*r+1) - r
		if x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
			continue
		}
		p := world.Pos{X: uint16(x), Y: uint16(y), Z: sp.Center.Z}
		if w.monsterCanEnter(p) {
			return p, true
		}
	}
	return world.Pos{}, false
}

// spawnMonster puts slot's monster in the world. Unless initial, it refuses when a
// player is looking at the chosen tile (no monster appears in a player's face).
func (w *World) spawnMonster(ctx *game.TickContext, slot *spawnSlot, initial bool) bool {
	pos, ok := w.spawnTile(ctx, slot.spawn)
	if !ok || (!initial && w.watched(pos)) {
		return false
	}
	def := slot.kind.def
	w.nextID++
	m := &Monster{
		id:         w.nextID,
		kind:       slot.kind,
		slot:       slot,
		pos:        pos,
		dir:        world.South,
		health:     def.Health,
		maxHealth:  def.Health,
		nextAttack: make([]game.Tick, len(def.Attacks)),
	}
	w.monsters = append(w.monsters, m) // ids grow: the slice stays ordered
	w.monByID[m.id] = m
	w.mindex(m)
	w.eachObserver(nil, pos, func(o *Player) {
		if !o.Knows(m.id) {
			o.remember(m.id)
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureAppear{CreatureAppear: &pb.CreatureAppear{Creature: w.monsterMsg(m)}}})
		}
	})
	return true
}

func (w *World) scheduleRespawn(ctx *game.TickContext, slot *spawnSlot, delay game.Tick) {
	ctx.Sched.After(delay, func(ctx *game.TickContext) {
		if !w.spawnMonster(ctx, slot, false) {
			w.scheduleRespawn(ctx, slot, respawnRetry)
		}
	})
}

func (w *World) spawnAll(ctx *game.TickContext) {
	w.spawned = true
	for _, slot := range w.slots {
		if !w.spawnMonster(ctx, slot, true) {
			w.scheduleRespawn(ctx, slot, respawnRetry)
		}
	}
}

// ---- AI ----------------------------------------------------------------------------

// markActive collects the sectors with a player at most activeSectorRadius sectors away,
// as a set and as a sorted list (deterministic iteration).
func (w *World) markActive() {
	clear(w.active)
	w.activeKeys = w.activeKeys[:0]
	for _, p := range w.players {
		sx, sy := int(p.pos.X)/world.SectorSize, int(p.pos.Y)/world.SectorSize
		for dy := -activeSectorRadius; dy <= activeSectorRadius; dy++ {
			for dx := -activeSectorRadius; dx <= activeSectorRadius; dx++ {
				x, y := sx+dx, sy+dy
				if x < 0 || y < 0 || x > 0xFFFF/world.SectorSize || y > 0xFFFF/world.SectorSize {
					continue
				}
				k := uint64(p.pos.Z)<<32 | uint64(x)<<16 | uint64(y)
				if _, ok := w.active[k]; !ok {
					w.active[k] = struct{}{}
					w.activeKeys = append(w.activeKeys, k)
				}
			}
		}
	}
}

func chebyshev(a, b world.Pos) int {
	return max(abs(int(a.X)-int(b.X)), abs(int(a.Y)-int(b.Y)))
}

func dist2(a, b world.Pos) int {
	dx, dy := int(a.X)-int(b.X), int(a.Y)-int(b.Y)
	return dx*dx + dy*dy
}

func (w *World) inProtection(p world.Pos) bool { return w.m.Flags(p)&world.FlagProtection != 0 }

// validTarget reports whether monster m may keep fighting player t.
func (w *World) validTarget(m *Monster, t *Player) bool {
	return t != nil && w.byClient[t.client] == t && t.pos.Z == m.pos.Z && Sees(m.pos, t.pos) && !w.inProtection(t.pos)
}

// findTarget returns the closest player m can see and reach, or nil.
func (w *World) findTarget(m *Monster) *Player {
	var best *Player
	bestD := 0
	w.eachObserver(nil, m.pos, func(o *Player) {
		if o.pos.Z != m.pos.Z || w.inProtection(o.pos) {
			return
		}
		d := chebyshev(m.pos, o.pos)
		if (best == nil || d < bestD) && w.m.LineOfSight(m.pos, o.pos) {
			best, bestD = o, d
		}
	})
	return best
}

// think runs one tick of monster m's state machine.
func (w *World) think(ctx *game.TickContext, m *Monster) {
	b := m.kind.def.Behavior
	if m.target != nil && !w.validTarget(m, m.target) {
		m.target = nil
	}
	if m.target == nil {
		// Looking around is the expensive part of idling: once every targetScanTicks,
		// staggered by id so monsters spread the work over ticks.
		if b.Aggressive && (uint64(ctx.Tick)+uint64(m.id))%targetScanTicks == 0 {
			if t := w.findTarget(m); t != nil {
				m.target, m.state = t, StateAlert
				w.face(m, t.pos)
				return
			}
		}
		m.state = StateIdle
		w.wander(ctx, m)
		return
	}
	t := m.target
	ready := ctx.Tick >= m.readyAt
	d := chebyshev(m.pos, t.pos)
	switch {
	case b.FleeAtHealthPct > 0 && m.health*100 <= b.FleeAtHealthPct*m.maxHealth:
		m.state = StateFlee
		if ready {
			if dir, ok := w.fleeStep(m, t.pos); ok {
				w.stepMonster(ctx, m, dir)
				return
			}
		}
		if d > 1 {
			return
		}
		// Cornered next to its target: it fights back.
	case d > b.TargetDistance:
		m.state = StateChase
		if ready {
			if dir, ok := w.chaseStep(m.pos, t.pos, true); ok {
				w.stepMonster(ctx, m, dir)
			}
		}
		return
	default:
		m.state = StateAttack
	}
	if d <= 1 {
		w.face(m, t.pos)
		w.monsterAttacks(ctx, m)
	}
}

// face turns m towards p, telling the clients that see it.
func (w *World) face(m *Monster, p world.Pos) {
	dx, dy := int(p.X)-int(m.pos.X), int(p.Y)-int(m.pos.Y)
	if dx == 0 && dy == 0 {
		return
	}
	// Prefer the axis with the larger difference: a monster faces N/E/S/W like a player.
	var d world.Direction
	switch {
	case abs(dx) > abs(dy) && dx > 0:
		d = world.East
	case abs(dx) > abs(dy):
		d = world.West
	case dy > 0:
		d = world.South
	default:
		d = world.North
	}
	if d == m.dir {
		return
	}
	m.dir = d
	w.eachObserver(nil, m.pos, func(o *Player) {
		if o.Knows(m.id) {
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureTurn{CreatureTurn: &pb.CreatureTurn{Id: m.id, Dir: dirMsg(d)}}})
		}
	})
}

// wander sometimes takes an idle monster one step, staying within its spawn's radius.
func (w *World) wander(ctx *game.TickContext, m *Monster) {
	if ctx.Tick < m.readyAt || ctx.Rand.IntN(wanderOdds) != 0 {
		return
	}
	d := world.Direction(ctx.Rand.IntN(8))
	to, ok := m.pos.Step(d)
	if !ok || !w.monsterCanEnter(to) {
		return
	}
	if sp := m.slot.spawn; chebyshev(to, sp.Center) > int(sp.Radius) && chebyshev(to, sp.Center) >= chebyshev(m.pos, sp.Center) {
		return
	}
	w.stepMonster(ctx, m, d)
}

// chaseStep returns a step from `from` that gets closer to goal: the free neighbour
// that most reduces the distance, else (monsters only, within the tick's pathfinding
// quota) the first step of an A* path around creatures.
func (w *World) chaseStep(from, goal world.Pos, astar bool) (world.Direction, bool) {
	best, bestC, bestD := world.Direction(0), chebyshev(from, goal), dist2(from, goal)
	found := false
	for d := range world.Direction(8) {
		to, ok := from.Step(d)
		if !ok || to == goal || !w.monsterCanEnter(to) {
			continue
		}
		c, d2 := chebyshev(to, goal), dist2(to, goal)
		if c < bestC || (c == bestC && d2 < bestD) {
			best, bestC, bestD, found = d, c, d2, true
		}
	}
	if found || !astar || w.pathBudget < w.searchCost() {
		return best, found
	}
	path, ok := w.pf.FindAvoiding(from, goal, w.pathBuf, func(q world.Pos) bool {
		return q != goal && (w.occupied(q) || w.inProtection(q))
	})
	w.pathBudget -= w.pf.Expanded()
	w.pathBuf = path[:0]
	if !ok || len(path) < 2 {
		return 0, false
	}
	return path[0], true
}

// fleeStep returns the free neighbour step that most increases the distance to threat.
func (w *World) fleeStep(m *Monster, threat world.Pos) (world.Direction, bool) {
	best, bestC, bestD := world.Direction(0), chebyshev(m.pos, threat), dist2(m.pos, threat)
	found := false
	for d := range world.Direction(8) {
		to, ok := m.pos.Step(d)
		if !ok || !w.monsterCanEnter(to) {
			continue
		}
		c, d2 := chebyshev(to, threat), dist2(to, threat)
		if c > bestC || (c == bestC && d2 > bestD) {
			best, bestC, bestD, found = d, c, d2, true
		}
	}
	return best, found
}

// stepMonster moves m one step in d (the caller checked the tile).
func (w *World) stepMonster(ctx *game.TickContext, m *Monster, d world.Direction) {
	to, _ := m.pos.Step(d)
	ground, _, _ := w.m.Tile(to)
	ticks := w.StepTicks(ground, m.kind.def.Speed, d.Diagonal())
	m.readyAt = ctx.Tick + ticks
	from := m.pos
	w.munindex(m)
	m.pos, m.dir = to, d
	w.mindex(m)
	w.observeMove(nil, m, from, to, posMsg(from), posMsg(to), uint32(ticks.Duration().Milliseconds()))
}

// removeMonster takes m out of the world (it died).
func (w *World) removeMonster(m *Monster) {
	w.eachObserver(nil, m.pos, func(o *Player) {
		if o.forget(m.id) {
			o.emit(disappearMsg(m.id))
		}
	})
	w.munindex(m)
	delete(w.monByID, m.id)
	for i, q := range w.monsters {
		if q == m {
			w.monsters = append(w.monsters[:i], w.monsters[i+1:]...)
			break
		}
	}
	for _, p := range w.players {
		if p.target == m {
			p.target = nil
		}
	}
}
