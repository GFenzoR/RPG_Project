package session

import (
	"errors"
	"fmt"
	"maps"
	"slices"
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
	respawnRetry = game.Tick(5 * time.Second / game.TickDuration)
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
	// reach is the longest range of its attacks (1 = melee only).
	reach int
}

type lootItem struct {
	def    *content.Item
	chance float64
	lo, hi int
	// each: a quest drop for each player that damaged the monster and needs it.
	each bool
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
	// speed is the effective speed: the kind's with its speed conditions (T3.2).
	speed int
	conds []*condition
	// homeWay is the rest of the A* way home (last step first) that walkHome follows from
	// homeAt once a wall stopped the greedy step: taking the greedy step again from the
	// first tile of a detour would lead straight back to the wall (it went back and forth
	// forever). Its array is reused.
	homeWay []world.Direction
	homeAt  world.Pos
	// stuckOn is the target to which m, with a leash, has found no way within its leash
	// area around creatures since stuckSince (chase's check, every pathRetry from
	// checkAt), or 0. Any change of target clears it (setTarget).
	stuckOn    uint32
	stuckSince game.Tick
	checkAt    game.Tick
	// shunned are the players m gave up because no way led to them (chase), each on the
	// tile where it stood: until its tick, on that tile and out of m's reach, that player
	// is beyond its leash.
	shunned []shun
}

// shun is a player a monster gave up on a tile no way led to, until a tick.
type shun struct {
	player uint32
	pos    world.Pos
	until  game.Tick
}

// setTarget makes p (nil: nobody) m's target and starts its chase afresh: whatever m
// found about the way to its old target does not hold for the new one.
func (m *Monster) setTarget(p *Player) {
	m.target, m.stuckOn, m.checkAt = p, 0, 0
}

// Speed returns the monster's effective speed.
func (m *Monster) Speed() int { return m.speed }

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

// Corpse is what a dead monster or player leaves: a container item (CorpseItem) with
// its loot. A player's corpse (Owner != 0) lets only its owner take things out until
// OwnerUntil.
type Corpse struct {
	Monster    string
	Item       *Item
	Owner      int64 // character id of the dead player, 0 for a monster
	OwnerUntil game.Tick
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
		c.ShieldBlockDivisor <= 0 || c.MonsterCorpseMs <= 0 ||
		c.MonsterPathRetryMs <= 0 || c.MonsterStuckMs <= 0 || c.MonsterShunMs <= 0 {
		return fmt.Errorf("session: invalid combat balance %+v", c)
	}
	for _, s := range content.Stances {
		if _, ok := c.Modes[s]; !ok {
			return fmt.Errorf("session: combat.modes.%s missing", s)
		}
	}
	w.attackFor = ticksFor(c.AttackIntervalMs)
	w.corpseFor = ticksFor(c.MonsterCorpseMs)
	w.pathRetry = ticksFor(c.MonsterPathRetryMs)
	w.stuckFor = ticksFor(c.MonsterStuckMs)
	w.shunFor = ticksFor(c.MonsterShunMs)
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
		k.reach = 1
		for _, a := range def.Attacks {
			k.attackTicks = append(k.attackTicks, ticksFor(a.IntervalMs))
			if a.Type != "melee" {
				k.reach = max(k.reach, a.Range)
			}
		}
		for _, l := range def.Loot {
			it := w.cfg.Items[l.Item]
			if it == nil {
				return fmt.Errorf("session: monster %q drops unknown item %q", id, l.Item)
			}
			if l.EachPlayer {
				if err := checkQuestDrop(w.cfg.Quests, w.cfg.NPCs, it); err != nil {
					return fmt.Errorf("session: monster %q: each_player loot %q: %w", id, l.Item, err)
				}
			}
			lo, hi := l.CountRange()
			k.loot = append(k.loot, lootItem{def: it, chance: l.Chance, lo: lo, hi: hi, each: l.EachPlayer})
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
		Speed:         uint32(m.speed),
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

// monsterCanEnter reports whether a monster may stand on p: walkable, free, outside
// protection zones and not a tile that stairs, a hole or a teleport leaves from
// (monsters do not use portals, portal.go). A player chasing its target steps by it too.
// One read of the tile's flags: Walkable, the protection zone and MovesOnStep are bits of
// it (FlagPortalStep is only ever set on a map with portals).
func (w *World) monsterCanEnter(p world.Pos) bool {
	return w.m.Flags(p)&(world.FlagBlocksMovement|world.FlagProtection|world.FlagPortalStep) == 0 && !w.occupied(p)
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
		speed:      def.Speed,
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
	return t != nil && w.byClient[t.client] == t && t.pos.Z == m.pos.Z && Sees(m.pos, t.pos) && !w.inProtection(t.pos) &&
		seesPlayer(m, t)
}

// findTarget returns the closest player m can see and reach, or nil. With a leash, only
// players within m's leash area count, and not one it gave up as out of its way while it
// stands on that tile out of m's reach (beyondLeash).
func (w *World) findTarget(tick game.Tick, m *Monster) *Player {
	return w.pickTarget(tick, m, nil, false)
}

// pickTarget is findTarget but for skip and, with inReach, only among the players m's
// attacks reach from where it stands (hits).
func (w *World) pickTarget(tick game.Tick, m *Monster, skip *Player, inReach bool) *Player {
	var best *Player
	bestD := 0
	leash := w.leash(m)
	w.eachObserver(nil, m.pos, func(o *Player) {
		if o == skip || o.pos.Z != m.pos.Z || w.inProtection(o.pos) || !seesPlayer(m, o) ||
			leash >= 0 && (chebyshev(o.pos, m.slot.spawn.Center) > leash || w.beyondLeash(tick, m, o)) ||
			inReach && !w.hits(m, o) {
			return
		}
		d := chebyshev(m.pos, o.pos)
		if (best == nil || d < bestD) && w.m.LineOfSight(m.pos, o.pos) {
			best, bestD = o, d
		}
	})
	return best
}

// hits reports whether one of m's attacks reaches p from where m stands: next to it, or
// within its reach and line of sight (distance attacks and spells, monsterAttacks).
func (w *World) hits(m *Monster, p *Player) bool {
	d := chebyshev(m.pos, p.pos)
	return d <= 1 || d <= m.kind.reach && w.m.LineOfSight(m.pos, p.pos)
}

// think runs one tick of monster m's state machine.
func (w *World) think(ctx *game.TickContext, m *Monster) {
	b := m.kind.def.Behavior
	if m.target != nil && !w.validTarget(m, m.target) {
		m.setTarget(nil) // lost (gone, in a protection zone, out of sight): it walks home
	}
	if len(m.shunned) > 0 {
		m.shunned = slices.DeleteFunc(m.shunned, func(s shun) bool { return ctx.Tick >= s.until })
	}
	if m.target == nil {
		// Looking around is the expensive part of idling: once every targetScanTicks,
		// staggered by id so monsters spread the work over ticks.
		if b.Aggressive && (uint64(ctx.Tick)+uint64(m.id))%targetScanTicks == 0 {
			if t := w.findTarget(ctx.Tick, m); t != nil {
				m.setTarget(t)
				m.state = StateAlert
				w.face(m, t.pos)
				return
			}
		}
		m.state = StateIdle
		if !w.walkHome(ctx, m) {
			w.wander(ctx, m)
		}
		return
	}
	t := m.target
	ready := ctx.Tick >= m.readyAt
	d := chebyshev(m.pos, t.pos)
	if w.beyondLeash(ctx.Tick, m, t) {
		// Its target left the leash area and its reach (or stands on a tile where m gave it
		// up as out of its way): it turns to someone it may fight, or gives up and goes home.
		w.dropTarget(ctx, m)
		if m.target == nil {
			w.walkHome(ctx, m)
		}
		return
	}
	if d <= m.kind.reach {
		m.stuckOn = 0
	}
	leash := w.leash(m)
	roam := w.roam(m, leash)
	switch {
	case b.FleeAtHealthPct > 0 && m.health*100 <= b.FleeAtHealthPct*m.maxHealth:
		m.state = StateFlee
		if ready {
			if dir, ok := w.fleeStep(m, t.pos, roam); ok {
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
		switch w.chase(ctx, m, t, roam, leash >= 0 && d > m.kind.reach) {
		case chaseBlocked:
			// Only creatures stand in its way, and have for a while (an NPC, a monster or a
			// player in the mouth of a nook may never move): it turns to a player its attacks
			// reach, likely whoever blocks it...
			if w.retarget(ctx, m, t, true) {
				return
			}
			fallthrough // ...or else its target stands where it cannot get
		case chaseUnreachable:
			// No way to its target, out of its reach, within its leash area: it would stand
			// there being shot. It gives it up and, while it stands on that tile, keeps away
			// from it a while.
			m.shunned = append(m.shunned, shun{player: t.id, pos: t.pos, until: ctx.Tick + w.shunFor})
			if !w.retarget(ctx, m, t, false) {
				w.giveUp(ctx, m)
				w.walkHome(ctx, m)
			}
			return
		}
		if m.kind.reach <= 1 {
			return
		}
		// A monster with distance attacks shoots while it closes in.
		d = chebyshev(m.pos, t.pos)
	default:
		m.state = StateAttack
	}
	if d <= m.kind.reach {
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

// ---- leash ---------------------------------------------------------------------------
//
// With balance combat.monster_leash_tiles > 0, a monster's home area is its spawn's
// radius around the spawn's center (Chebyshev) and its leash area that radius plus the
// leash. It picks targets, chases and flees only within the leash area; a target beyond
// it and out of its reach, or one it cannot get to within it (chase, shunned), is
// dropped for another player fighting it from where it may go, or else given up
// (dropTarget, giveUp); an idle monster out of its home area walks back (walkHome)
// instead of wandering (docs/02-game-design.md, monsters section).

// tileSquare is the square of tiles at most r tiles (Chebyshev) from c; r < 0 is the
// whole map.
type tileSquare struct {
	c world.Pos
	r int
}

// anywhere is the tileSquare without bounds.
var anywhere = tileSquare{r: -1}

func (s tileSquare) has(p world.Pos) bool { return s.r < 0 || chebyshev(p, s.c) <= s.r }

// leash returns the radius of m's leash area around its spawn's center, or -1 without a
// leash.
func (w *World) leash(m *Monster) int {
	l := w.cfg.Balance.Combat.MonsterLeashTiles
	if l <= 0 || m.slot == nil {
		return -1
	}
	return int(m.slot.spawn.Radius) + l
}

// roam is where m may step while it fights: its leash area (if a walk home around a wall
// took it out of it, no farther from its spawn's center than it stands), or anywhere
// without a leash (leash < 0).
func (w *World) roam(m *Monster, leash int) tileSquare {
	if leash < 0 {
		return anywhere
	}
	c := m.slot.spawn.Center
	return tileSquare{c: c, r: max(leash, chebyshev(m.pos, c))}
}

// dropTarget is what m does when its target fights it from where it may not go
// (beyondLeash): it turns to another player (retarget), keeping its wounds and who hurt
// it, so a group does not lose its fight, its experience or a quest drop because whoever
// held the monster stepped away. With nobody left it gives up (giveUp).
func (w *World) dropTarget(ctx *game.TickContext, m *Monster) {
	if !w.retarget(ctx, m, m.target, false) {
		w.giveUp(ctx, m)
	}
}

// retarget drops m's target for the closest player who hurt it and whom it may fight (a
// valid target, not beyond its leash; the first who hurt it wins a tie), else, if
// aggressive, the player it would pick (pickTarget); never old, and with inReach only a
// player its attacks reach from where it stands. It keeps m's wounds and who hurt it. It
// reports whether it found one; if not, m has no target.
func (w *World) retarget(ctx *game.TickContext, m *Monster, old *Player, inReach bool) bool {
	m.setTarget(nil)
	var next *Player
	best := 0
	for _, s := range m.damage {
		p := w.playerByID(s.player)
		if p == nil || p == old || !w.validTarget(m, p) || w.beyondLeash(ctx.Tick, m, p) || inReach && !w.hits(m, p) {
			continue
		}
		if d := chebyshev(m.pos, p.pos); next == nil || d < best {
			next, best = p, d
		}
	}
	if next == nil && m.kind.def.Behavior.Aggressive {
		next = w.pickTarget(ctx.Tick, m, old, inReach)
	}
	if next == nil {
		return false
	}
	m.setTarget(next)
	m.state = StateAlert
	w.face(m, next.pos)
	return true
}

// giveUp makes m drop its target: it heals to full health (telling who sees it), its
// conditions end (a burn would otherwise go on hurting it for whoever cast it, and could
// kill it from outside the leash), it forgets who hurt it (nobody earns experience for
// that fight) and goes idle. It still keeps away from whom it shunned.
func (w *World) giveUp(ctx *game.TickContext, m *Monster) {
	m.setTarget(nil)
	m.state = StateIdle
	m.damage = m.damage[:0]
	w.clearConditions(ctx, holder{m: m}, false)
	if m.health >= m.maxHealth {
		return
	}
	m.health = m.maxHealth
	pct := healthPercent(m.health, m.maxHealth)
	w.eachObserver(nil, m.pos, func(o *Player) {
		if o.Knows(m.id) {
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureHealth{CreatureHealth: &pb.CreatureHealth{Id: m.id, HealthPercent: pct}}})
		}
	})
}

// beyondLeash reports whether player p fights m from where m may not go and cannot hit
// back: out of its attacks' reach, and out of its leash area or on a tile where m shunned
// it (no way within its leash area led there, chase). Hits from there train like hits on
// a target that does not fight back (skills.afk.factor): a monster held by its leash is
// no training dummy. On another tile a shunned player is a target like any other: an
// unreachable one costs stuckFor again.
func (w *World) beyondLeash(tick game.Tick, m *Monster, p *Player) bool {
	l := w.leash(m)
	if l < 0 || chebyshev(m.pos, p.pos) <= m.kind.reach {
		return false
	}
	if chebyshev(p.pos, m.slot.spawn.Center) > l {
		return true
	}
	for _, s := range m.shunned {
		if s.player == p.id && s.pos == p.pos && tick < s.until {
			return true
		}
	}
	return false
}

// walkHome takes an idle monster that stands out of its home area one step towards its
// spawn's center whenever it may step; it reports whether m is away from home (then it
// does not wander). Without a leash it does nothing: wander drifts it back. It takes the
// greedy step while there is one; at a wall it searches a way around (A*, within the
// tick's quota) and follows all of it (homeWay). With no way home it waits there
// (pathRetry after a failed search), it never teleports.
func (w *World) walkHome(ctx *game.TickContext, m *Monster) bool {
	if w.leash(m) < 0 {
		return false
	}
	sp := m.slot.spawn
	if chebyshev(m.pos, sp.Center) <= int(sp.Radius) {
		m.homeWay = m.homeWay[:0]
		return false
	}
	if ctx.Tick < m.readyAt {
		return true
	}
	if n := len(m.homeWay); n > 0 && m.pos == m.homeAt {
		d := m.homeWay[n-1]
		m.homeWay = m.homeWay[:n-1]
		if to, ok := m.pos.Step(d); ok && w.monsterCanEnter(to) {
			w.stepMonster(ctx, m, d)
			m.homeAt = m.pos
			return true
		}
	}
	m.homeWay = m.homeWay[:0] // none, stale (it fought meanwhile) or blocked: plan again
	if d, ok := w.stepToward(m.pos, sp.Center, true, anywhere); ok {
		w.stepMonster(ctx, m, d)
		return true
	}
	if w.pathBudget < w.searchCost() {
		return true // the tick's quota is spent: next tick
	}
	path, ok := w.monsterPath(m.pos, sp.Center, anywhere, true)
	first, free := world.Direction(0), false
	if ok && len(path) > 0 {
		first = path[0]
		to, stepOK := m.pos.Step(first)
		free = stepOK && w.monsterCanEnter(to)
	}
	if !free {
		m.readyAt = ctx.Tick + w.pathRetry
		return true
	}
	for i := len(path) - 1; i >= 1; i-- {
		m.homeWay = append(m.homeWay, path[i])
	}
	w.stepMonster(ctx, m, first)
	m.homeAt = m.pos
	return true
}

// chaseStep returns a step from `from` that gets closer to goal (never onto it): the free
// neighbour that most reduces the distance (a player chasing its target).
func (w *World) chaseStep(from, goal world.Pos) (world.Direction, bool) {
	return w.stepToward(from, goal, false, anywhere)
}

// stepToward is chaseStep that steps only onto tiles of in and, with onto, also onto goal
// itself (a monster walking to its spawn's center).
func (w *World) stepToward(from, goal world.Pos, onto bool, in tileSquare) (world.Direction, bool) {
	best, bestC, bestD := world.Direction(0), chebyshev(from, goal), dist2(from, goal)
	found := false
	for d := range world.Direction(8) {
		to, ok := from.Step(d)
		if !ok || to == goal && !onto || !in.has(to) || !w.monsterCanEnter(to) {
			continue
		}
		c, d2 := chebyshev(to, goal), dist2(to, goal)
		if c < bestC || (c == bestC && d2 < bestD) {
			best, bestC, bestD, found = d, c, d2, true
		}
	}
	return best, found
}

// monsterPath searches a monster's way (A*) from `from` to goal and charges it to the
// tick's pathfinding quota: onto tiles of in only and never onto a protection zone or the
// tile of stairs, a hole or a teleport (goal aside); with creatures, around creatures too.
func (w *World) monsterPath(from, goal world.Pos, in tileSquare, creatures bool) ([]world.Direction, bool) {
	path, ok := w.pf.FindAvoiding(from, goal, w.pathBuf, func(q world.Pos) bool {
		return q != goal && (creatures && w.occupied(q) || w.inProtection(q) || w.m.MovesOnStep(q) || !in.has(q))
	})
	w.pathBudget -= w.pf.Expanded()
	w.pathBuf = path[:0]
	return path, ok
}

// chaseVerdict is what chase found about the way to its target.
type chaseVerdict uint8

const (
	// chaseOn: it goes on chasing.
	chaseOn chaseVerdict = iota
	// chaseUnreachable: for stuckFor no way within its leash area has led to the target,
	// not even through creatures (water, or a wall whose way round leaves the area).
	chaseUnreachable
	// chaseBlocked: for stuckFor only creatures have stood in that way.
	chaseBlocked
)

// chase takes m one step towards its target t within roam when it may (readyAt): the step
// that most closes in (stepToward) or, with none, the first step of a way around
// creatures (A*, within the tick's quota); with no way it waits pathRetry before stepping
// or searching again, as walkHome does.
//
// With check (a leash, t out of its reach) it also checks, every pathRetry and whether it
// steps or not, that a way within roam leads to t around creatures. Only finding one (or
// t coming within its reach, think) clears stuckOn: a step that leads nowhere, along a
// shore after a target that walks along the far one, does not. After stuckFor without
// one it reports chaseUnreachable, or chaseBlocked if a way through creatures exists.
func (w *World) chase(ctx *game.TickContext, m *Monster, t *Player, roam tileSquare, check bool) chaseVerdict {
	var way []world.Direction
	searched := false
	if check && ctx.Tick >= m.checkAt && w.pathBudget >= w.searchCost() {
		m.checkAt = ctx.Tick + w.pathRetry
		searched = true
		// A one-step path is the step onto t, which the greedy pass does not take: A* does
		// not avoid the goal (and t, out of reach, is not next to m).
		if path, ok := w.monsterPath(m.pos, t.pos, roam, true); ok && len(path) >= 2 {
			way, m.stuckOn = path, 0
		} else if m.stuckOn != t.id {
			m.stuckOn, m.stuckSince = t.id, ctx.Tick
		} else if ctx.Tick-m.stuckSince >= w.stuckFor {
			if w.pathBudget < w.searchCost() {
				m.checkAt = ctx.Tick + 1 // the tick's quota is spent: next tick
				return chaseOn
			}
			if _, ok := w.monsterPath(m.pos, t.pos, roam, false); ok {
				return chaseBlocked
			}
			return chaseUnreachable
		}
	}
	if ctx.Tick < m.readyAt {
		return chaseOn
	}
	if d, ok := w.stepToward(m.pos, t.pos, false, roam); ok {
		w.stepMonster(ctx, m, d)
		return chaseOn
	}
	if !searched {
		if check && m.stuckOn == t.id {
			// Its last check found no way: the next one (checkAt) searches again.
			m.readyAt = max(m.readyAt, m.checkAt)
			return chaseOn
		}
		if w.pathBudget < w.searchCost() {
			return chaseOn // the tick's quota is spent: next tick
		}
		if path, ok := w.monsterPath(m.pos, t.pos, roam, true); ok && len(path) >= 2 {
			way = path
		}
	}
	if len(way) >= 2 {
		w.stepMonster(ctx, m, way[0])
		return chaseOn
	}
	m.readyAt = ctx.Tick + w.pathRetry
	return chaseOn
}

// fleeStep returns the free neighbour step within in that most increases the distance to
// threat.
func (w *World) fleeStep(m *Monster, threat world.Pos, in tileSquare) (world.Direction, bool) {
	best, bestC, bestD := world.Direction(0), chebyshev(m.pos, threat), dist2(m.pos, threat)
	found := false
	for d := range world.Direction(8) {
		to, ok := m.pos.Step(d)
		if !ok || !in.has(to) || !w.monsterCanEnter(to) {
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
	ticks := w.StepTicks(ground, m.speed, d.Diagonal())
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

// checkQuestDrop checks the item of a quest drop (loot each_player, content audit m9).
// quest.Engine.Needs gives it again to whoever no longer holds it while its has_item step
// or the step right after it is current, and cannot tell a lost one from one handed in. So:
//   - some quest step waits for it (has_item), or it would never drop;
//   - each such step is followed by the delivery: a dialog_action step whose node is not
//     where its NPC's dialog starts, and every option that leads there (goto, at least one)
//     takes the item (take_item). Once handed in, the quest moves past the delivery and
//     the item no longer drops; a step in between would leave a lost one without a source,
//     and a way into the delivery that does not take it would leave it with the player,
//     to show it again;
//   - it is worth nothing and cannot be traded (tradeable: false, value: 0): the copies a
//     player can pile up, dropping them on the floor, buy nothing and nobody else takes.
//
// make validate checks the same (packages/content-schema, checkQuestDrops).
func checkQuestDrop(quests content.Quests, npcs content.NPCs, item *content.Item) error {
	if item.Tradeable || item.Value != 0 {
		return fmt.Errorf("a quest drop needs tradeable: false and value: 0")
	}
	asked := false
	for _, id := range slices.Sorted(maps.Keys(quests)) { // a stable first error
		steps := quests[id].Steps
		for i, s := range steps {
			if c := s.CompleteWhen.HasItem; c == nil || c.Item != item.ID {
				continue
			}
			asked = true
			if i+1 >= len(steps) || steps[i+1].CompleteWhen.DialogAction == nil {
				return fmt.Errorf("quest %q step %q: the has_item of a quest drop must be followed by its delivery (a dialog_action step), or a lost one would never come back", id, s.ID)
			}
			if d := steps[i+1].CompleteWhen.DialogAction; !deliveryTakes(npcs[d.NPC], d.Node, item.ID) {
				return fmt.Errorf("quest %q step %q: its delivery must take the quest drop: every option of npc %q that leads to node %q (one at least) needs take_item of it, and the node cannot be where the dialog starts", id, steps[i+1].ID, d.NPC, d.Node)
			}
		}
	}
	if !asked {
		return fmt.Errorf("the has_item of no quest step: it would never drop")
	}
	return nil
}

// deliveryTakes reports whether node of npc's dialog is a delivery of item: not where the
// dialog starts, and every option that leads there (goto, one at least) takes the item
// (take_item).
func deliveryTakes(npc *content.NPC, node, item string) bool {
	if npc == nil || node == npc.Dialog.Start {
		return false
	}
	leads := false
	for _, n := range npc.Dialog.Nodes {
		for _, o := range n.Options {
			if o.Goto != node {
				continue
			}
			leads = true
			if !slices.ContainsFunc(o.Action, func(a content.Action) bool {
				return a.TakeItem != nil && a.TakeItem.Item == item
			}) {
				return false
			}
		}
	}
	return leads
}
