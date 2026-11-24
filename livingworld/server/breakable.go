package livingworld

// Hit is one strike on an object, as the glue measured it: the ways it counts as
// (ByMelee, ByAxe...: a sword strike is melee and any_attack; an axe is tool:axe and,
// swung as a weapon, melee) and its damage.
type Hit struct {
	Methods []string
	Damage  int
	// Actor is who struck (a character id: the loot is logged for it).
	Actor int64
}

// HitResult is what a strike did.
type HitResult uint8

// Results of OnAttackObject.
const (
	// HitNoObject: nothing to strike on that tile (no object, or not a breakable one).
	HitNoObject HitResult = iota
	// HitWrongWay: the object does not break that way (a rock and a sword).
	HitWrongWay
	// HitAlreadyBroken: its debris lies there (or nothing yet: it respawns later).
	HitAlreadyBroken
	// HitDamaged: it took the damage and still stands.
	HitDamaged
	// HitBroken: this strike broke it.
	HitBroken
)

// Breaks reports whether an object of p breaks by any of methods (the glue asks before
// spending the player's swing: a wrong tool costs nothing).
func (w *World) Breaks(p Pos, methods []string) bool {
	o := w.objs[p]
	if o == nil || o.k.def.Breakable == nil {
		return false
	}
	for _, m := range methods {
		if o.k.methodsAllow[m] {
			return true
		}
	}
	return false
}

// Breakable reports whether an intact breakable object stands on p.
func (w *World) Breakable(p Pos) bool {
	o := w.objs[p]
	return o != nil && o.k.def.Breakable != nil && o.st == intact
}

// OnAttackObject strikes the object on p. The glue has already checked reach, line of
// sight and the striker's pace; the module checks the way and keeps the hit points. A
// break shows the debris (or nothing), rolls the loot once with rnd and hands it to the
// host, and starts the timers of the debris and of the respawn.
func (w *World) OnAttackObject(p Pos, h Hit, rnd Rand) HitResult {
	o := w.objs[p]
	if o == nil || o.k.def.Breakable == nil {
		return HitNoObject
	}
	b := o.k.def.Breakable
	if o.st != intact {
		return HitAlreadyBroken
	}
	if !w.Breaks(p, h.Methods) {
		return HitWrongWay
	}
	o.hp -= max(h.Damage, 1)
	if o.hp > 0 {
		w.host.Event(Event{
			Kind: EventHit, Pos: p, Item: o.k.num, Effect: b.Effect, Sound: b.HitSound,
			HPPermille: uint32(o.hp * 1000 / b.HP),
		})
		return HitDamaged
	}
	o.hp = 0
	w.host.Event(Event{Kind: EventBreak, Pos: p, Item: o.k.num, Effect: b.Effect, Sound: b.Sound})
	if o.k.alt != 0 {
		w.set(o, debris)
		w.schedule(o, w.tick+max(o.k.debris, 1))
	} else {
		w.set(o, gone)
		w.schedule(o, w.tick+max(o.k.respawn, 1))
	}
	if drops := rollLoot(b.Loot, rnd); len(drops) > 0 {
		w.host.DropLoot(p, h.Actor, o.k.def.Item, drops)
	}
	return HitBroken
}

// breakableTimer runs when o's timer is due: debris fades (the respawn timer goes on from
// the break), and a gone object stands again once its tile is free.
func (w *World) breakableTimer(o *object) {
	switch o.st {
	case debris:
		w.host.Event(Event{Kind: EventFade, Pos: o.pos, Item: o.k.alt, Effect: o.k.def.Breakable.Effect})
		w.set(o, gone)
		// The respawn counts from the break: debris_seconds <= respawn_seconds (checked).
		w.schedule(o, w.tick+max(o.k.respawn-o.k.debris, 1))
	case gone:
		// Never on a creature (try again in a second); loose items (its own loot nobody
		// took, a coin dropped on the debris) are moved aside first (room).
		if !w.room(o.pos) {
			w.schedule(o, w.tick+w.cat.retry)
			return
		}
		o.hp = o.k.def.Breakable.HP
		o.until = 0
		w.set(o, intact)
		w.host.Event(Event{Kind: EventRespawn, Pos: o.pos, Item: o.k.num, Effect: o.k.def.Breakable.Effect})
	}
}

// rollLoot rolls a loot table: each entry by its chance, then its count.
func rollLoot(loot []LootEntry, rnd Rand) []Drop {
	var out []Drop
	for _, l := range loot {
		if rnd.Float64() >= l.Chance {
			continue
		}
		lo, hi := l.CountRange()
		out = append(out, Drop{Item: l.Item, Count: lo + rnd.IntN(hi-lo+1)})
	}
	return out
}

// Broken reports whether p holds a breakable object that is broken now (its debris lies,
// or nothing shows until it respawns).
func (w *World) Broken(p Pos) bool {
	o := w.objs[p]
	return o != nil && o.k.def.Breakable != nil && o.st != intact
}
