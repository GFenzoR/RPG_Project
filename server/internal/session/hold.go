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
//
// The hold covers what happens while a transfer waits; a dropped transfer takes its
// characters back to their last written save, which may be older. What a character gave
// away to the public ground before the transfer (thrown on the street or into a container
// there, or made for it by the server and fallen at its feet: the coins of an NPC sale,
// a craft or a reward that did not fit) would then be in that save and in the save of
// whoever picked it up. So a give-away (gaveAway) keeps the character's snapshot of the
// end of that command, or of the tick for one the server made outside a command
// (settleGivers, Player.pre): its state is whole again there (a dialog's later actions,
// the quest step it completes, the other piles of the same gift). Its next transfer
// submits that snapshot first (transferSnapshot): the Saver writes it before the
// transfer, so a dropped or skipped transfer never takes the character back to a save
// older than the give-away. It costs a write only for a transfer that follows a
// give-away, and only once: any later snapshot of the character (an autosave, the final
// one, a transfer's) replaces it. Numbered when taken, its ack frees nothing reserved
// after it (leftHouse).
//
// It does not cover a crash: with the database down at shutdown, that snapshot fails
// with the transfer behind it (the shutdown abandons it), and a snapshot the database
// rejects for good (ErrPermanent) taints nobody. Then the character goes back to an older
// save, as anyone does in a crash (docs/01, docs/14).
//
// No transfer may leave anything on the public ground in its own command (it checks
// first that everything fits: canBuy, canReceive, moneyThatFits): the snapshot taken
// then (transferSnapshot settles a pending give-away at once) would hold half the
// transfer and be written outside its database transaction. Nor may one command give
// something away and change a house (none does): that snapshot would then be taken with
// the house write, and dropping the write would lose what went into the house (it never
// duplicates anything).

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
// it. If p gave something away since its last snapshot, p's snapshot from after the
// give-away is submitted first, before the transfer job (its caller submits it after
// every snapshot of it): a dropped transfer then takes p back to a save without what it
// gave away. A give-away of this same command or tick is settled now (see above).
func (w *World) transferSnapshot(p *Player) Snapshot {
	w.settleGave(p)
	if p.pre != nil {
		w.save(*p.pre)
	}
	s := w.snapshot(p, false)
	w.inFlight[p.charID] = s.Seq
	return s
}

// gaveAway is called right after something of p's (carried by p, or made for p by the
// server) landed on the public ground, where no save has it: whoever picks it up writes it
// in their own save. p's snapshot from the end of this command (or tick) waits in p.pre
// for p's next transfer (settleGivers, transferSnapshot); a later snapshot of p replaces
// it.
func (w *World) gaveAway(p *Player) {
	if !p.gave {
		p.gave = true
		w.givers = append(w.givers, p)
	}
}

// settleGivers takes, for every player that gave something away in this command or
// tick, the snapshot its next transfer writes first (Player.pre). It runs at the end of
// every command (Input, after its house changes are written) and of every tick
// (flushSystem). The snapshot is numbered then, before any reservation of a later
// command (leftHouse), so its ack frees none of those.
func (w *World) settleGivers() {
	if len(w.givers) == 0 {
		return
	}
	for _, p := range w.givers {
		if w.byChar[p.charID] == p { // one that left was saved (its final snapshot)
			w.settleGave(p)
		}
	}
	clear(w.givers)
	w.givers = w.givers[:0]
}

// settleGave takes p's snapshot for its next transfer if p gave something away since its
// last snapshot. A house p changed is written first, with p's snapshot (flushHouses),
// which already comes after the give-away: then there is nothing to keep.
func (w *World) settleGave(p *Player) {
	if !p.gave {
		return
	}
	w.flushHouses()
	if p.gave {
		s := w.snapshot(p, false)
		p.pre = &s
	}
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
// has p's transfers so far, and it is a give-away (gaveAway): p's next transfer writes
// first p's state from the end of this command or tick, without it.
//
// In read-only mode (Tainted) nothing about houses is written (flushHouses): what falls
// on a house floor then stays in memory only, neither reserved nor saved (docs/01).
func (w *World) holdGround(p *Player, it *Item) {
	switch {
	case !it.onGround:
	case w.savedHouse(it.pos):
		w.houseActor(p)
	default:
		if h := w.inFlight[p.charID]; h != 0 {
			w.heldGround[it] = groundHold{char: p.charID, seq: h}
		}
		w.gaveAway(p)
	}
}

// holdCorpse reserves the corpse p just left to p while p is held: its items come from
// p's state, which may rest on a transfer the database does not have yet. A corpse left
// while p is not held is only the owner's for corpse_owner_only_ms, even if a later
// transfer of p is dropped (its items come from a state the database has). The dirty
// houses are written first: a house change of p not written yet (it took something off a
// house floor this tick) holds p through that write too.
func (w *World) holdCorpse(p *Player, corpse *Item) {
	w.flushHouses()
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
