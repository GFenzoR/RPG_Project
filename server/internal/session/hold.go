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
//   - the corpse it leaves while held is reserved to it (heldGround) until the database
//     has the transfers the corpse may come from;
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
// from the street. It only ever lands as a pile of its own, or in a pile or a container
// already reserved to the mover (moveItem): a reservation never takes over what belongs
// to someone else (a stranger's pile, bag or corpse on the street).
//
// Each reservation keeps the seq of the snapshot whose ack frees it (groundHold.seq): a
// player that keeps making transfers stays held (it drops nothing), but what was reserved
// for an earlier transfer is anybody's as soon as that one is confirmed. The hold normally
// lasts a tick or two; while the database is down it lasts until the transfer is written,
// and a dropped transfer turns it into the lock of Tainted (the reservations it covers
// are never acked: they stay until a restart, or until the corpse decays).

// groundHold is a reservation of World.heldGround: the character the ground item (or the
// pile, container or corpse it lies in) is reserved to, and the seq of that character's
// snapshot whose ack frees it. The database then has every transfer of the character the
// item may come from (the Saver writes in order and skips everything of a character after
// a transfer it dropped).
type groundHold struct {
	char int64
	seq  uint64
}

// transferSnapshot is p's snapshot for a transfer; p is held until the database confirms
// it.
func (w *World) transferSnapshot(p *Player) Snapshot {
	s := w.snapshot(p, false)
	w.inFlight[p.charID] = s.Seq
	return s
}

// confirmed is the ack of character id's snapshot seq (World.Saved): the database has it
// and, written in order, every transfer of id before it. The hold ends if seq covers the
// last transfer; every reservation seq covers is anybody's again, also while newer
// transfers keep id held (and after a taint: a late ack is still a write that went in).
func (w *World) confirmed(id int64, seq uint64) {
	if h, ok := w.inFlight[id]; ok && seq >= h {
		delete(w.inFlight, id)
	}
	for it, g := range w.heldGround {
		if g.char == id && g.seq <= seq {
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
// an event and not from p's command. Elsewhere it is reserved to p until the database
// has p's transfers so far.
//
// In read-only mode (Tainted) nothing about houses is written (flushHouses): what falls
// on a house floor then stays in memory only, neither reserved nor saved (docs/01).
func (w *World) holdGround(p *Player, it *Item) {
	h := w.inFlight[p.charID]
	switch {
	case !it.onGround:
	case w.savedHouse(it.pos):
		w.houseActor(p)
	case h != 0:
		w.heldGround[it] = groundHold{char: p.charID, seq: h}
	}
}

// holdCorpse reserves the corpse p just left to p while p is held: its items come from
// p's state, which may rest on a transfer the database does not have yet. A corpse left
// while p is not held is only the owner's for corpse_owner_only_ms, even if a later
// transfer of p is dropped (its items come from a state the database has).
func (w *World) holdCorpse(p *Player, corpse *Item) {
	if h := w.inFlight[p.charID]; h != 0 && corpse.onGround {
		w.heldGround[corpse] = groundHold{char: p.charID, seq: h}
	}
}

// leftHouse reserves root to p: p just moved something from a house floor onto the public
// ground, into root (the item itself as a new pile, or a pile or container already
// reserved to p: moveItem lets it join nothing else). The house write that took it out
// carries p's next snapshot: flushHouses writes it at the end of p's command, and before
// any other snapshot of p is taken (snapshot flushes the dirty houses first). So the
// reservation lasts until the database has that snapshot.
func (w *World) leftHouse(p *Player, root *Item) {
	if root.onGround {
		w.heldGround[root] = groundHold{char: p.charID, seq: w.saveSeq + 1}
	}
}

// groundHeld reports whether it lies on the ground (loose or inside a container lying
// there) reserved to another character, so p cannot take or use it, or put anything
// into it.
func (w *World) groundHeld(p *Player, it *Item) bool {
	if len(w.heldGround) == 0 {
		return false
	}
	r := it.root()
	if !r.onGround {
		return false
	}
	g, ok := w.heldGround[r]
	return ok && g.char != p.charID
}

// heldFor reports whether it lies on the ground in a pile, container or corpse reserved
// to p (heldGround).
func (w *World) heldFor(p *Player, it *Item) bool {
	if len(w.heldGround) == 0 {
		return false
	}
	r := it.root()
	if !r.onGround {
		return false
	}
	g, ok := w.heldGround[r]
	return ok && g.char == p.charID
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
	if w.heldFor(p, r) {
		return true
	}
	for _, c := range w.corpses[r.pos] {
		if c.Item == r {
			return c.Owner == p.charID
		}
	}
	return false
}
