package livingworld

// PushResult is what a push did.
type PushResult uint8

// Results of Push.
const (
	// PushNoObject: no pushable object on that tile (it may have just moved away).
	PushNoObject PushResult = iota
	// PushBlocked: the tile behind it is not free.
	PushBlocked
	// PushMoved: it moved one tile.
	PushMoved
)

// Pushable reports whether a pushable object stands on p.
func (w *World) Pushable(p Pos) bool {
	o := w.objs[p]
	return o != nil && o.k.def.Pushable != nil
}

// Push moves the pushable object on from one tile by (dx, dy) (each -1, 0 or 1, not
// both 0; the glue allows only straight pushes from the tile behind it). The tile it
// goes to must be free (Host.Free) and hold no other object, even a broken one that will
// stand again there. Two pushes of the same boulder in one tick run one after the other
// on the loop: the second finds it gone and answers PushNoObject.
func (w *World) Push(from Pos, dx, dy int) PushResult {
	o := w.objs[from]
	if o == nil || o.k.def.Pushable == nil {
		return PushNoObject
	}
	to, ok := offset(from, dx, dy)
	if !ok || (dx == 0 && dy == 0) || w.objs[to] != nil || !w.host.Free(to) {
		return PushBlocked
	}
	w.move(o, to)
	if o.k.reset > 0 {
		w.schedule(o, w.tick+o.k.reset)
	}
	w.host.Event(Event{Kind: EventPush, Pos: from, To: to, Item: o.k.num, Effect: o.k.def.Pushable.Effect, Sound: o.k.def.Pushable.Sound})
	w.updatePlates()
	return PushMoved
}

// move takes o from its tile to to.
func (w *World) move(o *object, to Pos) {
	from := o.pos
	delete(w.objs, from)
	w.host.SetBlock(from, false, false)
	w.host.TileChanged(from)
	o.pos = to
	w.objs[to] = o
	w.host.SetBlock(to, o.k.move, o.k.sight)
	w.host.TileChanged(to)
}

// resetPushable puts o back home once no creature stands there (the puzzle starts over)
// and no player sees it leave or arrive: a boulder never jumps in sight, so whoever is
// still at the puzzle keeps it as it is. Loose items on its home are moved aside (room).
func (w *World) resetPushable(o *object) {
	if o.pos == o.home {
		o.until = 0
		return
	}
	if w.objs[o.home] != nil || w.host.Watched(o.pos) || w.host.Watched(o.home) || !w.room(o.home) {
		w.schedule(o, w.tick+w.cat.retry)
		return
	}
	from := o.pos
	o.until = 0
	w.move(o, o.home)
	w.host.Event(Event{Kind: EventReset, Pos: from, To: o.home, Item: o.k.num, Effect: o.k.def.Pushable.Effect})
	w.updatePlates()
}

func offset(p Pos, dx, dy int) (Pos, bool) {
	x, y := int(p.X)+dx, int(p.Y)+dy
	if x < 0 || y < 0 || x > 0xffff || y > 0xffff || dx < -1 || dx > 1 || dy < -1 || dy > 1 {
		return Pos{}, false
	}
	return Pos{X: uint16(x), Y: uint16(y), Z: p.Z}, true
}

// plate is a pressure plate of the map.
type plate struct {
	radius  int
	pressed bool
}

// Pressed reports whether the plate on p is pressed (tests, look).
func (w *World) Pressed(p Pos) bool {
	pl := w.plates[p]
	return pl != nil && pl.pressed
}

// updatePlates presses the plates a creature or a pushable object stands on, and opens
// every gate whose linked plates are all pressed (closes it when one is not, unless
// someone stands in it: it closes as soon as that one leaves; loose items in the gateway
// are moved aside, room).
func (w *World) updatePlates() {
	for p, pl := range w.plates {
		o := w.objs[p]
		pl.pressed = w.host.Occupied(p) || o != nil && o.k.def.Pushable != nil
	}
	for _, g := range w.gates {
		want := len(g.plates) > 0
		for _, p := range g.plates {
			if !w.plates[p].pressed {
				want = false
				break
			}
		}
		switch {
		case want && g.st == intact:
			w.set(g, open)
			w.host.Event(Event{Kind: EventGateOpen, Pos: g.pos, Item: g.k.alt, Sound: g.k.def.Gate.Sound})
		case !want && g.st == open && w.room(g.pos):
			w.set(g, intact)
			w.host.Event(Event{Kind: EventGateClose, Pos: g.pos, Item: g.k.num, Sound: g.k.def.Gate.Sound})
		}
	}
}
