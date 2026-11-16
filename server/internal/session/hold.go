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
// goes to a tile outside a house, and nobody else takes anything out of its corpse. The
// hold normally lasts a tick or two; while the database is down it lasts until the
// transfer is written, and a dropped transfer turns it into the lock of Tainted.

// transferSnapshot is p's snapshot for a transfer; p is held until the database confirms
// it.
func (w *World) transferSnapshot(p *Player) Snapshot {
	s := w.snapshot(p, false)
	w.inFlight[p.charID] = s.Seq
	return s
}

// onHold reports whether a transfer of character id is not confirmed yet or was not stored.
func (w *World) onHold(id int64) bool { return w.inFlight[id] != 0 || w.locked[id] }

// heldDrop reports whether moving it to to would put something p carries, or something
// lying in p's own corpse, on a tile outside a house while p is held. A house tile is
// written with the move itself, in a transfer behind p's (the Saver skips it and taints
// the house if p's was dropped).
func (w *World) heldDrop(p *Player, it *Item, to place) bool {
	if w.inFlight[p.charID] == 0 || it.carriedBy() != p && !w.inOwnCorpse(p, it) {
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

// inOwnCorpse reports whether it lies in a corpse p left.
func (w *World) inOwnCorpse(p *Player, it *Item) bool {
	r := it.root()
	if !r.onGround {
		return false
	}
	for _, c := range w.corpses[r.pos] {
		if c.Item == r {
			return c.Owner == p.charID
		}
	}
	return false
}
