package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

const (
	msgCorpseDrag     = "inventory.corpse_drag"
	msgCorpseNotReady = "inventory.corpse_not_ready"
	msgCorpseNoPlace  = "inventory.corpse_no_place"
)

// corpseOf returns the remains it is, or nil: only a container lying on the ground that
// addCorpse put there.
func (w *World) corpseOf(it *Item) *Corpse {
	if !it.onGround {
		return nil
	}
	for _, c := range w.corpses[it.pos] {
		if c.Item == it {
			return c
		}
	}
	return nil
}

// dragCorpse is a MoveItem of the remains of a creature (docs/02 "Arrastrar un cuerpo"):
// the one thing nobody can pick up that a player may still move, because two creatures
// may fall on one tile. moveItem already checked that p sees it, is within reach of it
// and that it is not reserved to another player by a hold (groundHeld).
//
// It goes one tile at a time: p stands next to the body (or on it) and the body lands on
// a tile next to where it lies, on the same floor, on top of what is there. Never into a
// container or a slot (nobody carries or hides one), never onto a house tile, the tile of
// a door (it would keep the door from closing, and a reserved body could not be taken
// away by anyone else), the entrance of stairs, a hole or a teleport (an item dropped
// there falls to the other floor: a body stays on its floor) or the tile of an object of
// the living world (broken, or an open gate: corpseRefuses). A body still reserved to
// the player who died (reserved) is moved only by that player. The body stays the same
// container with the same loot, owner, reservation and decay timer: only its tile changes.
func (w *World) dragCorpse(ctx *game.TickContext, p *Player, c *Corpse, m *pb.MoveItem) {
	it := c.Item
	from := it.pos
	to, ok := w.destination(p, m.GetTo())
	if !ok {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	if to.kind == locGround && to.pos == from {
		return // dropped where it already lies
	}
	if to.kind != locGround || to.pos.Z != from.Z || chebyshev(from, to.pos) != 1 || chebyshev(p.pos, from) > 1 {
		p.emit(systemMsg(msgCorpseDrag))
		return
	}
	if w.reserved(ctx.Tick, p, it) {
		p.emit(systemMsg(msgNotOwner))
		return
	}
	if _, _, exists := w.m.Tile(to.pos); !exists || !w.m.Walkable(to.pos) {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	if w.corpseRefuses(to.pos) { // off such a tile it always goes: a creature may die on one
		p.emit(systemMsg(msgCorpseNoPlace))
		return
	}
	if len(w.ground[to.pos]) >= maxGroundItems {
		p.emit(systemMsg(msgTileFull))
		return
	}
	// Each move sends two tiles to everyone around, like a door: the same kind of wait.
	if ctx.Tick < p.nextCorpseMove {
		p.tooEarly(ctx.Tick, antibot.KindOther)
		p.emit(systemMsg(msgCorpseNotReady))
		return
	}
	p.activePaced(ctx.Tick, antibot.KindOther, p.nextCorpseMove)
	p.nextCorpseMove = ctx.Tick + w.corpseMoveFor

	w.moveCorpse(c, to.pos)
	w.tileChanged(from)
	w.tileChanged(to.pos)
}

// moveCorpse lays the remains c on the tile to, on top of what is there: the same
// container, listed in w.corpses under its new tile (reserved, heldBy, isCorpse and the
// decay find it by the tile of its item). The caller checked to and sends both tiles.
func (w *World) moveCorpse(c *Corpse, to world.Pos) {
	it := c.Item
	// detach ends a reservation of the ground (hold.go): a body left by a held player
	// keeps its own across the move.
	hold, held := w.heldGround[it]
	w.unlistCorpse(it.pos, c)
	w.detach(it)
	w.drop(it, to)
	if held {
		w.heldGround[it] = hold
	}
	w.corpses[to] = append(w.corpses[to], c)
	w.closeUnreachable(it)
}

// corpseRefuses reports whether no body is dragged onto pos: a house tile (its floor is
// saved, and remains never are), a door's tile, the entrance of a portal that is stepped
// on, or the tile of an object of the living world (one broken that stands again there,
// an open gate: a body is not the way to hold it back, though ClearItems would move it).
func (w *World) corpseRefuses(pos world.Pos) bool {
	if _, flags, ok := w.m.Tile(pos); !ok || flags&world.FlagHouse != 0 {
		return true
	}
	if w.living != nil && w.living.Has(toLW(pos)) {
		return true
	}
	return w.doors[pos] != nil || w.stepPortal(pos) != nil
}

// unlistCorpse takes c out of the remains of pos (the item stays where it is).
func (w *World) unlistCorpse(pos world.Pos, c *Corpse) {
	list := w.corpses[pos]
	for i, q := range list {
		if q == c {
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(w.corpses, pos)
	} else {
		w.corpses[pos] = list
	}
}
