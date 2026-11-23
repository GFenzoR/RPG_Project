package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

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
//     coins of an NPC sale; never what a death drops: the corpse holds all of it) is
//     reserved to it outside a house (heldGround), and on a house floor it is written
//     with its snapshot (houseActor), even when no command of its put it there.
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
// away to the public ground (thrown on the street or into a container there, or made for
// it by the server and fallen at its feet: the coins of an NPC sale, a craft or a reward
// that did not fit) would then be in that save and in the save of whoever picked it up.
// The same happens without any transfer when the server stops uncleanly (lote 16): A
// throws an item on the street, B picks it up and logs out (B's final save is written at
// once), the server dies before A's next autosave: the item is in both rows.
//
// So a give-away (gaveAway) is settled with the character's snapshot of the end of that
// command, or of the tick for one the server made outside a command (settleGivers): its
// state is whole again there (a dialog's later actions, the quest step it completes, the
// other piles of the same gift). That snapshot is submitted at once, and what the
// give-away landed in (the pile, or the container lying on the street) is reserved to
// the character until the database acks it (reserveGave, heldGround): nobody else can
// take it before the database has the giver without it, whatever happens to the queue
// after that. The saves are coalesced per character: the first give-away is saved at
// once, the ones in the next giveSaveEvery ticks are reserved right away and saved
// together at its end (flushGiveDue), or with any earlier snapshot of the character (an
// autosave, the final one, a transfer's: every snapshot reserves them with its own seq).
// One still waiting when a player command starts (made in a command that is not an
// Input, as a Join's tutorial reward) is settled then, before that command changes a
// house or lets anybody else touch it (playerCommand). A transfer submits a waiting
// give-away save first (transferSnapshot): the Saver writes it before the transfer, so a
// dropped or skipped transfer never takes the character back to a save older than the
// give-away. Its ack frees nothing that left a house after the give-away: those
// reservations take the seq of the house write's own snapshot (numberLeft), not of
// whatever snapshot comes next.
//
// A give-away save the database never acks (it is down, or rejects the row for good)
// keeps the reservation: the giver may take its item back, nobody else, until a restart
// or the item decays. A crash loses at most what lay on the ground, never makes two.
//
// No transfer may leave anything on the public ground in its own command (it checks
// first that everything fits: canBuy, canReceive, moneyThatFits): the snapshot taken
// then (transferSnapshot settles a pending give-away at once) would hold half the
// transfer and be written outside its database transaction. transferSnapshot logs one
// that does (a give-away still unsettled outside a house write: every player command
// settles every giver first, and only player commands make transfers of players).
//
// One command may give something away and change a house: an owner standing on the street
// uses a rune lying on its house floor (mayUseInHouse), the monster dies and the reward of
// the quest kill does not fit, so it falls at the owner's feet; then the rune's charge is
// taken from the house floor. Its snapshot after the give-away would be taken with the
// house write (flushHouses, the end of the command) and written apart before it: if that
// write were dropped, the owner would go back to that snapshot (the kill done) and the
// house to its last write (the rune with the charge), a charge for free; with something
// taken out of the house into the owner's backpack, it would be in two rows (the house's
// and the character's). So no snapshot is kept for such a give-away: what it put on the
// public ground is reserved to the player the way what leaves a house is (reserveGiven:
// the seq of its snapshot in that house write, numberLeft), and a dropped write takes the
// player back to its save before the command, with the reservation never acked. A
// give-away into something that cannot be reserved (a pile or a bag on the street that is
// not reserved to the player, even its own) would keep the snapshot, and settleGave logs
// it as an error. Only a MoveItem gives away that way, and no MoveItem changes a house
// besides (a give-away is a move to the public ground, which no tutorial event follows):
// it is a guard, no flow reaches it today.
//
// Another player in that house write (not the one whose command it is) still keeps the
// snapshot of its give-away apart: only the server's drops at its feet put anything of it
// in the house (holdGround), nothing of the house goes into its state, so a dropped write
// loses at most that drop and duplicates nothing.
//
// The settlement points: the start of a player command settles every giver (not only the
// commanding player) before that command can make a transfer or change a house, and
// transferSnapshot settles its own players; those two are what a transfer relies on. The
// end of the command and the end of the tick take the snapshot sooner, so it is the state
// right after the give-away (TestSaveBeforeTransferIsFromTheGiftsCommandOrTick) and the
// list of givers stays short.

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
	if p.gave && !w.houseFlushing {
		// A give-away no command start settled: this command made it before its transfer.
		w.log.Error("session: a transfer follows a give-away of its own command", "character", p.charID)
	}
	w.settleGave(p, 0, true)
	if len(p.giveWait) > 0 {
		w.saveGave(p, 0) // its coalesced save goes first, as if its window had ended
	}
	s := w.snapshot(p, false)
	w.inFlight[p.charID] = s.Seq
	w.numberLeft(p, s.Seq)
	return s
}

// numberLeft gives what p took out of a house to the public ground since its last
// transfer snapshot (leftHouse) the seq of this one, p's snapshot in the house write
// that took it out: that write is p's first transfer after the move (every snapshot and
// transfer writes the dirty houses before numbering), and a snapshot of a give-away
// numbered right before it (settleGave) frees none of it.
func (w *World) numberLeft(p *Player, seq uint64) {
	if len(p.left) == 0 {
		return
	}
	for _, r := range p.left {
		if g, ok := w.heldGround[r]; ok && g.char == p.charID && g.seq < seq {
			g.seq = seq
			w.heldGround[r] = g
		}
	}
	clear(p.left)
	p.left = p.left[:0]
}

// giveSaveEvery is the coalescing window of the give-away saves of one character (2 s):
// a burst of drops costs one write, and what it dropped stays reserved to it that long
// at most (plus the write).
const giveSaveEvery = game.Tick(40)

// gaveAway is called right after something of p's (carried by p, or made for p by the
// server) landed on the public ground, where no save has it: whoever picks it up writes it
// in their own save. p's snapshot from the end of this command (or tick) is submitted
// (settleGivers) and reserves at to p until its ack (reserveGave). at is the pile or the
// container lying on the street it landed in; root is the same when it may be reserved to
// p inside a house write (a pile of its own, or a pile or container already reserved to
// p), nil otherwise (Player.given, reserveGiven). moveItem lets a give-away land nowhere
// else (ownOnly: a stranger's pile or bag would be locked to p), so the two are the same.
func (w *World) gaveAway(p *Player, root, at *Item) {
	p.given = append(p.given, root)
	if at != nil {
		p.gaveRoots = append(p.gaveRoots, at)
	}
	if !p.gave {
		p.gave = true
		w.givers = append(w.givers, p)
	}
}

// settleGivers settles every player that gave something away since the last call
// (settleGave) at tick now. It runs at the start and at the end of every player command
// (playerCommand: Input; at the end after the command's house changes are written) and at
// the end of every tick (flushSystem). Other commands (Join, the acks, the test commands)
// settle at the next of those: the start of a player command settles what they gave away
// before that command changes a house, or lets anybody else touch it.
func (w *World) settleGivers(now game.Tick) {
	if len(w.givers) == 0 {
		return
	}
	for _, p := range w.givers {
		if w.byChar[p.charID] == p { // one that left was saved (its final snapshot)
			w.settleGave(p, now, false)
		}
	}
	clear(w.givers)
	w.givers = w.givers[:0]
}

// settleGave settles p's give-away since its last snapshot: p's snapshot is submitted now
// (saveGave) or, inside the coalescing window of an earlier one (unless force), what it
// landed in is reserved to p right away and saved at the window's end (flushGiveDue). A
// house p changed is written first, with p's snapshot (flushHouses), which already comes
// after the give-away and reserves it: then there is nothing left to do. Inside that
// house write, when p's own command gave something away and changed the house, what it
// gave away is reserved to p for the write instead (reserveGiven, see the rule above).
func (w *World) settleGave(p *Player, now game.Tick, force bool) {
	if !p.gave {
		return
	}
	w.flushHouses()
	if !p.gave {
		return
	}
	if w.houseFlushing && w.cmdPlayer == p {
		if w.reserveGiven(p) {
			return
		}
		w.log.Error("session: a command gave something away and changed a house", "character", p.charID)
	}
	if force || now >= p.giveNext {
		w.saveGave(p, now)
		return
	}
	// Coalesced: reserved now with no seq yet (no ack frees it), numbered by the next
	// snapshot of p, which is submitted (flushGiveDue at the latest).
	w.reserveGave(p, noSeq)
	p.gave = false
	clear(p.given)
	p.given = p.given[:0]
	if !p.giveDue {
		p.giveDue = true
		w.giveDue = append(w.giveDue, p)
	}
}

// noSeq is the seq of a reservation no snapshot numbered yet: no ack reaches it.
const noSeq = ^uint64(0)

// saveGave submits p's snapshot after its give-aways (it reserves them, reserveGave) and
// starts a coalescing window at now.
func (w *World) saveGave(p *Player, now game.Tick) {
	w.save(w.snapshot(p, false))
	p.giveNext = now + giveSaveEvery
}

// reserveGave reserves to p, with seq, every pile or container its give-aways landed in
// since its last snapshot (gaveRoots) or that waits for its coalesced save (giveWait),
// while they still lie on the ground. A reservation of p's with a higher seq keeps it,
// and one of another character is never taken over (no move gives anything into one:
// groundHeld). With seq noSeq they wait in giveWait for the snapshot that numbers them.
func (w *World) reserveGave(p *Player, seq uint64) {
	if len(p.gaveRoots) == 0 && len(p.giveWait) == 0 {
		return
	}
	var wait []*Item
	if seq == noSeq {
		wait = p.giveWait
	}
	for _, rs := range [2][]*Item{p.gaveRoots, p.giveWait} {
		for _, r := range rs {
			if !r.onGround {
				continue
			}
			g, ok := w.heldGround[r]
			if ok && g.char != p.charID {
				continue
			}
			if !ok || g.seq < seq || g.seq == noSeq {
				w.heldGround[r] = groundHold{char: p.charID, seq: seq}
			}
			if seq == noSeq && !slices.Contains(wait, r) {
				wait = append(wait, r)
			}
		}
	}
	clear(p.gaveRoots)
	p.gaveRoots = p.gaveRoots[:0]
	if seq != noSeq {
		clear(p.giveWait)
		wait = p.giveWait[:0]
	}
	p.giveWait = wait
}

// flushGiveDue submits the coalesced give-away saves whose window ended by now (end of
// tick, flushSystem). One that another snapshot already numbered, or whose player left
// (its final snapshot did), needs none.
func (w *World) flushGiveDue(now game.Tick) {
	if len(w.giveDue) == 0 {
		return
	}
	kept := w.giveDue[:0]
	for _, p := range w.giveDue {
		switch {
		case w.byChar[p.charID] != p || len(p.giveWait) == 0:
			p.giveDue = false
		case now >= p.giveNext:
			p.giveDue = false
			w.saveGave(p, now)
		default:
			kept = append(kept, p)
		}
	}
	clear(w.giveDue[len(kept):])
	w.giveDue = kept
}

// reserveGiven reserves to p what its command gave away to the public ground, with the
// seq of p's snapshot in the house write being taken (transferSnapshot gives it with
// numberLeft, like what left the house), and reports whether it could: every give-away
// landed where it may be reserved to p (Player.given). Then p's give-away is settled: the
// house write carries the state after it, and a dropped write never frees what it put on
// the street.
func (w *World) reserveGiven(p *Player) bool {
	for _, r := range p.given {
		if r == nil {
			return false
		}
		if g, ok := w.heldGround[r]; ok && g.char != p.charID {
			return false // never take over another character's reservation
		}
	}
	for _, r := range p.given {
		if r.onGround {
			w.heldGround[r] = groundHold{char: p.charID, seq: w.saveSeq + 1}
			p.left = append(p.left, r)
		}
	}
	clear(p.given)
	p.given = p.given[:0]
	clear(p.gaveRoots)
	p.gaveRoots = p.gaveRoots[:0]
	p.gave = false
	return true
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
		w.gaveAway(p, it, it) // a pile of its own (drop)
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
// carries p's snapshot: flushHouses writes it at the end of p's command, and before any
// other snapshot of p is taken (snapshot flushes the dirty houses first). So the
// reservation lasts until the database has that snapshot: numberLeft gives it its seq
// when the write takes it (no ack runs in between: it is the end of this command). Until
// then it holds the seq of the next snapshot, which stays only if p is not in that write.
func (w *World) leftHouse(p *Player, root *Item) {
	if root.onGround {
		w.heldGround[root] = groundHold{char: p.charID, seq: w.saveSeq + 1}
		p.left = append(p.left, root)
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
