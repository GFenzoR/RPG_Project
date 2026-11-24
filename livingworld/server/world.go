// Package livingworld is the living world of Neque's Realm: map objects that react to
// players (crates that break, boulders that move, gates that pressure plates open). It
// owns their state and their rules; the game server (server/internal/session, the glue)
// owns everything else and calls it from the game loop goroutine only, through the small
// API of World. The module never imports server/: what it needs of the map, the loot and
// the network it asks of a Host the glue implements (livingworld/README.md).
//
// Every method runs on the game loop: no locks, no wall clock (time is the tick number the
// loop passes), no I/O. The state is transient: a restart puts every object back where the
// map has it.
package livingworld

import (
	"container/heap"
	"slices"
)

// Pos is a tile position (the server's world.Pos, copied by the glue).
type Pos struct {
	X, Y uint16
	Z    uint8
}

// Chebyshev returns the king-move distance between a and b on any floor.
func Chebyshev(a, b Pos) int {
	return max(abs(int(a.X)-int(b.X)), abs(int(a.Y)-int(b.Y)))
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// Host is what the game server gives the module. Every call happens on the loop.
type Host interface {
	// Free reports whether an object may stand on p: walkable ground and nothing else
	// that blocks (the map's own items, other objects), no creature, no loose item, not
	// a protection zone, a house or a stairs/teleport entrance.
	Free(p Pos) bool
	// Occupied reports whether a creature stands on p (a pressure plate's weight, a gate
	// that cannot close on someone).
	Occupied(p Pos) bool
	// SetBlock sets what the object layer of p blocks; the host combines it with what
	// the map's own items block. Called whenever an object appears, changes or leaves p.
	SetBlock(p Pos, move, sight bool)
	// TileChanged tells the host that the item shown on p changed (it sends the tile).
	TileChanged(p Pos)
	// Event shows a hit, a break, a push... to the players who see e.Pos.
	Event(e Event)
	// DropLoot puts the loot of an object broken by actor on p (the host creates the
	// items with its own rules and logs them for actor).
	DropLoot(p Pos, actor int64, object string, drops []Drop)
}

// Rand is the loop's seeded random source (math/rand/v2 *rand.Rand satisfies it).
type Rand interface {
	IntN(n int) int
	Float64() float64
}

// Drop is a rolled loot entry.
type Drop struct {
	Item  string
	Count int
}

// EventKind says what happened to an object.
type EventKind uint8

// Event kinds (proto LivingObjectEvent.Kind, in the same order).
const (
	EventHit EventKind = iota + 1
	EventBreak
	EventRespawn
	EventPush
	EventGateOpen
	EventGateClose
	EventFade
	EventReset
)

// Event is something players near Pos see and hear.
type Event struct {
	Kind EventKind
	Pos  Pos
	// To is where a pushed or reset object went.
	To Pos
	// Item is the numeric item of the object involved (intact, pushed, debris that fades).
	Item uint16
	// Effect is the material key of the particles, Sound the sounds.yaml id (may be empty).
	Effect, Sound string
	// HPPermille is what is left of a hit object, in thousandths (0 on a break).
	HPPermille uint32
}

// state is where an object is in its life.
type state uint8

const (
	intact state = iota // standing (a closed gate)
	debris              // broken: its debris lies (breakable with becomes)
	gone                // broken and faded: nothing shows (until it respawns)
	open                // an open gate
)

// object is one living object of the map.
type object struct {
	k     *kind
	home  Pos // where the map put it (a pushable goes back there)
	pos   Pos
	st    state
	hp    int
	until uint64 // tick of the next change (debris fades, respawn, reset); 0 none
	seq   int    // its index in World.order (ties of the timers go in placement order)
	// plates linked to a gate.
	plates []Pos
}

// shown is the item p's tile shows for o (0: nothing) and what it blocks.
func (o *object) shown() (num uint16, move, sight bool) {
	switch o.st {
	case intact:
		return o.k.num, o.k.move, o.k.sight
	case debris, open:
		return o.k.alt, o.k.altMove, o.k.altSight
	}
	return 0, false, false
}

// World is the state of every living object.
type World struct {
	cat  *Catalog
	host Host
	objs map[Pos]*object
	// order keeps every object in placement order: deterministic ticks.
	order  []*object
	plates map[Pos]*plate // pressure plates of the map
	gates  []*object
	// timers holds the objects with a timer, soonest first (an entry whose tick is no
	// longer its object's until is stale and skipped): a tick costs the timers due, not a
	// walk over every object of the map.
	timers timerQueue
	tick   uint64
}

// timer is an entry of World.timers.
type timer struct {
	at uint64
	o  *object
}

// timerQueue is a min-heap of timers by tick, then placement order (deterministic).
type timerQueue []timer

func (q timerQueue) Len() int { return len(q) }
func (q timerQueue) Less(i, j int) bool {
	return q[i].at < q[j].at || q[i].at == q[j].at && q[i].o.seq < q[j].o.seq
}
func (q timerQueue) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *timerQueue) Push(x any)   { *q = append(*q, x.(timer)) }
func (q *timerQueue) Pop() any {
	old := *q
	t := old[len(old)-1]
	*q = old[:len(old)-1]
	return t
}

// schedule sets o's next change at tick at (> the current tick).
func (w *World) schedule(o *object, at uint64) {
	o.until = at
	heap.Push(&w.timers, timer{at: at, o: o})
}

// New builds an empty World over a resolved catalog.
func New(cat *Catalog, host Host) *World {
	return &World{cat: cat, host: host, objs: map[Pos]*object{}, plates: map[Pos]*plate{}}
}

// Place registers the map item num on p. It reports whether num is a living object: the
// host then takes it out of the map's own stack and shows ItemAt(p) instead. A plate is
// only watched (the host keeps it). Called while the world loads, before Link.
func (w *World) Place(p Pos, num uint16) bool {
	if d := w.cat.plates[num]; d != nil {
		w.plates[p] = &plate{radius: d.Plate.Radius}
		return false
	}
	k := w.cat.byNum[num]
	if k == nil {
		return false
	}
	if w.objs[p] != nil {
		return false // one object per tile: a second one stays a plain map item
	}
	o := &object{k: k, home: p, pos: p, seq: len(w.order)}
	if k.def.Breakable != nil {
		o.hp = k.def.Breakable.HP
	}
	w.objs[p] = o
	w.order = append(w.order, o)
	if k.def.Gate != nil {
		w.gates = append(w.gates, o)
	}
	w.host.SetBlock(p, k.move, k.sight)
	return true
}

// Link ties every gate to the plates within their radius (after every Place).
func (w *World) Link() {
	for _, g := range w.gates {
		g.plates = g.plates[:0]
		for p, pl := range w.plates {
			if p.Z == g.pos.Z && Chebyshev(p, g.pos) <= pl.radius {
				g.plates = append(g.plates, p)
			}
		}
		slices.SortFunc(g.plates, cmpPos)
	}
}

func cmpPos(a, b Pos) int {
	switch {
	case a.Z != b.Z:
		return int(a.Z) - int(b.Z)
	case a.Y != b.Y:
		return int(a.Y) - int(b.Y)
	}
	return int(a.X) - int(b.X)
}

// ItemAt returns the item p shows from the object layer (0: none).
func (w *World) ItemAt(p Pos) uint16 {
	if o := w.objs[p]; o != nil {
		n, _, _ := o.shown()
		return n
	}
	return 0
}

// Gates returns the tiles of the gates, in placement order (the host checks that a
// closed gate locks nobody in: every side of it reaches a temple another way).
func (w *World) Gates() []Pos {
	out := make([]Pos, 0, len(w.gates))
	for _, g := range w.gates {
		out = append(out, g.pos)
	}
	return out
}

// Has reports whether an object (in any state) belongs to p.
func (w *World) Has(p Pos) bool { return w.objs[p] != nil }

// ObjectState is a copy of one object's state (Snapshot).
type ObjectState struct {
	Item  string
	Home  Pos
	Pos   Pos
	Shown uint16
	HP    int
	// State is "intact", "debris", "gone" or "open".
	State string
}

var stateNames = [...]string{intact: "intact", debris: "debris", gone: "gone", open: "open"}

// Snapshot returns the state of every object, in placement order (tests, staff tools).
func (w *World) Snapshot() []ObjectState {
	out := make([]ObjectState, 0, len(w.order))
	for _, o := range w.order {
		n, _, _ := o.shown()
		out = append(out, ObjectState{Item: o.k.def.Item, Home: o.home, Pos: o.pos, Shown: n, HP: o.hp, State: stateNames[o.st]})
	}
	return out
}

// set changes o's state and tells the host what its tile now shows and blocks.
func (w *World) set(o *object, st state) {
	o.st = st
	_, move, sight := o.shown()
	w.host.SetBlock(o.pos, move, sight)
	w.host.TileChanged(o.pos)
}

// OnStep tells the module a creature stepped from one tile to another: a pressure plate
// under either changes at once (OnTick checks them all anyway, for teleports and deaths).
func (w *World) OnStep(from, to Pos) {
	_, a := w.plates[from]
	_, b := w.plates[to]
	if a || b {
		w.updatePlates()
	}
}

// OnTick runs the timers due at tick (debris that fades, objects that respawn, boulders
// that go home), then the plates and gates. The plates are checked every tick, not only on
// OnStep: a creature also leaves or reaches a plate by a teleport, a death, a login or a
// logout, which the module does not hear of. That costs one Occupied per plate (a puzzle
// has a few), never a walk over the objects.
func (w *World) OnTick(tick uint64) {
	w.tick = tick
	for len(w.timers) > 0 && w.timers[0].at <= tick {
		t := heap.Pop(&w.timers).(timer)
		o := t.o
		if o.until != t.at {
			continue // stale: its timer changed since
		}
		switch {
		case o.k.def.Breakable != nil:
			w.breakableTimer(o)
		case o.k.def.Pushable != nil:
			w.resetPushable(o)
		}
	}
	if len(w.plates) > 0 {
		w.updatePlates()
	}
}

// Timers returns how many timer entries are queued (tests: stale entries do not pile up).
func (w *World) Timers() int { return len(w.timers) }
