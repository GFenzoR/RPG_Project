package session

import "github.com/GFenzoR/RPG_Project/server/internal/world"

// Transfer hold (T5.3 fail-safe, docs/01 "Transacciones"). A transfer leaves the loop
// before the database has it; if it is then dropped (World.Tainted), whatever its
// characters received or kept through it exists only in memory. The trade window, the
// market and the house floors are guarded on the persistence side (the Saver's taint, the
// guarded market rows), but the public ground and a corpse are not saved at all: an item
// left there is picked up by someone whose normal save does reach the database. So until
// the database confirms a transfer of a character (World.Saved acks its snapshot in it,
// or a later one), the character is held: nothing it carries, or left in its own corpse,
// goes to a tile outside a house; nobody else takes anything out of its corpse; and what
// the server makes fall at its feet outside a house (a craft or a reward that does not
// fit, the coins of an NPC sale, the equipment a full corpse cannot hold) is reserved to
// it (heldGround). The hold normally lasts a tick or two; while the database is down it
// lasts until the transfer is written, and a dropped transfer turns it into the lock of
// Tainted (the reservations stay until a restart).

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
// at its feet meanwhile is anybody's again.
func (w *World) endHold(id int64) {
	delete(w.inFlight, id)
	for it, owner := range w.heldGround {
		if owner == id {
			delete(w.heldGround, it)
		}
	}
}

// holdGround reserves it, just dropped on the ground for p by the server, to p while p is
// held. A house tile needs nothing: it is written with p's snapshot, behind p's transfer.
func (w *World) holdGround(p *Player, it *Item) {
	if w.inFlight[p.charID] != 0 && it.onGround && w.houseAt(it.pos) == nil {
		w.heldGround[it] = p.charID
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
// lying in p's own corpse, or reserved to p on the ground) on a tile outside a house
// while p is held. A house tile is written with the move itself, in a transfer behind
// p's (the Saver skips it and taints the house if p's was dropped).
func (w *World) heldDrop(p *Player, it *Item, to place) bool {
	if w.inFlight[p.charID] == 0 || !w.heldBy(p, it) {
		return false
	}
	var pos world.Pos
	switch to.kind {
	case locGround:
		pos = to.pos
	case locContainer:
		r := to.cont.root()
		if !r.onGround {
			return false // into p's own containers
		}
		pos = r.pos
	default:
		return false
	}
	return w.houseAt(pos) == nil
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
