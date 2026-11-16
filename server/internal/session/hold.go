package session

import "github.com/GFenzoR/RPG_Project/server/internal/world"

// Transfer hold (T5.3 fail-safe, docs/01 "Transacciones"). A transfer leaves the loop
// before the database has it; if it is then dropped (World.Tainted), whatever its
// characters received or kept through it exists only in memory. The trade window, the
// market and the house floors are guarded on the persistence side (the Saver's taint, the
// guarded market rows), but the public ground and a corpse are not saved at all: an item
// left there is picked up by someone whose normal save does reach the database. So until
// the database confirms a transfer of a character (World.Saved acks its snapshot in it,
// or a later one), the character is held:
//   - nothing it carries, or left in its own corpse, goes to the public ground (a tile
//     outside a house, or a container lying there);
//   - nobody else takes anything out of its corpse;
//   - what the server makes fall at its feet (a craft or a reward that does not fit, the
//     coins of an NPC sale, the equipment a full corpse cannot hold) is reserved to it
//     outside a house (heldGround), and on a house floor it is written with its snapshot
//     (houseActor), even when no command of its put it there.
//
// What leaves a house floor for the public ground is reserved to whoever moved it the
// same way (leftHouse): the house write that took it out carries the mover's snapshot, so
// the mover is held until the database has that write, and the Saver writes it only if
// every earlier write of that house went in (a dropped one taints the house). Without
// that, an item a dropped transfer put on a house floor, or one the database still has
// there because the write that took it out was dropped, would reach someone else's save
// from the street.
//
// The hold normally lasts a tick or two; while the database is down it lasts until the
// transfer is written, and a dropped transfer turns it into the lock of Tainted (the
// reservations stay until a restart).

// transferSnapshot is p's snapshot for a transfer; p is held until the database confirms
// it.
func (w *World) transferSnapshot(p *Player) Snapshot {
	s := w.snapshot(p, false)
	w.inFlight[p.charID] = s.Seq
	return s
}

// onHold reports whether a transfer of character id is not confirmed yet or was not stored.
func (w *World) onHold(id int64) bool { return w.inFlight[id] != 0 || w.locked[id] }

// endHold ends the hold of character id (its transfers are in the database): what fell
// at its feet meanwhile, or what it took out of a house, is anybody's again.
func (w *World) endHold(id int64) {
	delete(w.inFlight, id)
	for it, owner := range w.heldGround {
		if owner == id {
			delete(w.heldGround, it)
		}
	}
}

// savedHouse reports whether pos is the floor of a house whose items are written with
// the moves (T5.4, flushHouses). With houses off, a house tile is public ground.
func (w *World) savedHouse(pos world.Pos) bool { return w.houseOn && w.houseAt(pos) != nil }

// publicGround reports whether a MoveItem destination is on the public ground: a tile
// outside a saved house, or a container lying on one.
func (w *World) publicGround(to place) bool {
	var pos world.Pos
	switch to.kind {
	case locGround:
		pos = to.pos
	case locContainer:
		r := to.cont.root()
		if !r.onGround {
			return false // into a player's containers
		}
		pos = r.pos
	default:
		return false
	}
	return !w.savedHouse(pos)
}

// holdGround is called after the server dropped it at p's feet (it did not fit). On a
// house floor it is written with p's snapshot, behind p's transfers (the Saver skips the
// write and taints the house if one of them was dropped), also when the drop comes from
// an event and not from p's command. Elsewhere it is reserved to p while p is held.
func (w *World) holdGround(p *Player, it *Item) {
	switch {
	case !it.onGround:
	case w.savedHouse(it.pos):
		w.houseActor(p)
	case w.inFlight[p.charID] != 0:
		w.heldGround[it] = p.charID
	}
}

// leftHouse reserves root to p: p just moved something from a house floor into it, on the
// public ground (the item itself, the stack it joined or the container it went into). The
// write of that house carries p's snapshot (flushHouses at the end of p's command), so p
// is held until the database has it.
func (w *World) leftHouse(p *Player, root *Item) {
	if root.onGround {
		w.heldGround[root] = p.charID
	}
}

// groundHeld reports whether it lies on the ground (loose or inside a container lying
// there) reserved to another character that is held, so p cannot take or use it.
func (w *World) groundHeld(p *Player, it *Item) bool {
	if len(w.heldGround) == 0 {
		return false
	}
	r := it.root()
	if !r.onGround {
		return false
	}
	owner, ok := w.heldGround[r]
	return ok && owner != p.charID && w.onHold(owner)
}

// heldDrop reports whether moving it to to would put something of p's (carried by p,
// lying in p's own corpse, or reserved to p on the ground) on the public ground while p
// is held. A house floor is written with the move itself, in a transfer behind p's (the
// Saver skips it and taints the house if p's was dropped).
func (w *World) heldDrop(p *Player, it *Item, to place) bool {
	return w.inFlight[p.charID] != 0 && w.heldBy(p, it) && w.publicGround(to)
}

// heldBy reports whether it is p's while p is held: carried by p, in a corpse p left, or
// reserved to p on the ground.
func (w *World) heldBy(p *Player, it *Item) bool {
	r := it.root()
	if r.owner == p {
		return true
	}
	if !r.onGround {
		return false
	}
	if owner, ok := w.heldGround[r]; ok && owner == p.charID {
		return true
	}
	for _, c := range w.corpses[r.pos] {
		if c.Item == r {
			return c.Owner == p.charID
		}
	}
	return false
}
