package session

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Doors (docs/02-game-design.md, "Puertas con llave"): a door is an item of world.bin with
// a door block. Using it (UseItem, next to it) swaps it for its pair: a closed door opens
// and an open one closes. A locked door (door.key) opens and closes only for a player
// that carries a key with that key id, anywhere in its equipment or containers; the key
// is not spent. A door does not close on a creature or an item, and a locked door does
// not lock while that would shut in a player without its key (shutsIn). What a door blocks comes
// from its item, so walking, pathfinding, line of sight and every client see the change
// at once (Map.ReplaceItem + tileChanged). The state lives in the map only: a restart
// closes and locks every door again.

// i18n keys of the door messages (i18n/*/client.yaml).
const (
	msgDoorLocked   = "door.locked"
	msgDoorUnlocked = "door.unlocked"
	msgDoorRelocked = "door.relocked"
	msgDoorNoKey    = "door.no_key"
	msgDoorBlocked  = "door.blocked"
	msgDoorShutIn   = "door.shut_in"
)

// shutInSearch bounds the walk shutsIn makes from a door, in tiles per side: a side
// bigger than this is open ground that leads elsewhere, not a room behind the door.
const shutInSearch = 4096

// initDoors checks the doors and keys of the items (content.CheckDoors).
func (w *World) initDoors() error {
	if err := content.CheckDoors(w.cfg.Items); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	return nil
}

// useDoor answers a UseItem on a door of the map. It reports whether the UseItem was
// about a door p sees; anything else goes on to the other uses of map items.
func (w *World) useDoor(ctx *game.TickContext, p *Player, m *pb.UseItem) bool {
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	i := int(m.GetStackIndex())
	if !ok || i < 1 || i >= w.staticCount(pos) || pos.Z != p.pos.Z || !Sees(p.pos, pos) {
		return false
	}
	id := w.staticAt(pos, i)
	def := w.byNum[id]
	if uint32(id) != m.GetItemId() || def == nil || def.Door == nil {
		return false
	}
	if !w.near(p, pos) {
		p.emit(systemMsg(msgTooFar))
		return true
	}
	if def.Door.Open != "" {
		w.openDoor(ctx, p, pos, i-1, def)
	} else {
		w.closeDoor(ctx, p, pos, i-1, def)
	}
	return true
}

// openDoor opens the closed door def at stack index i of pos, with a key if it is locked.
func (w *World) openDoor(ctx *game.TickContext, p *Player, pos world.Pos, i int, def *content.Item) {
	var key *Item
	if lock := def.Door.Key; lock != "" {
		if key = w.keyFor(p, lock); key == nil {
			p.emit(systemMsg(msgDoorLocked))
			return
		}
	}
	p.active(ctx.Tick, antibot.KindOther)
	w.swapDoor(pos, i, w.cfg.Items[def.Door.Open])
	if key != nil {
		p.emit(systemMsg(msgDoorUnlocked, itemParam(key.def, 1)))
	}
}

// closeDoor closes the open door def at stack index i of pos: the tile must be free, and
// a locked door locks again only with its key.
func (w *World) closeDoor(ctx *game.TickContext, p *Player, pos world.Pos, i int, def *content.Item) {
	closed := w.cfg.Items[def.Door.Closed]
	if w.occupied(pos) || len(w.ground[pos]) > 0 {
		p.emit(systemMsg(msgDoorBlocked))
		return
	}
	var key *Item
	if lock := closed.Door.Key; lock != "" {
		if key = w.keyFor(p, lock); key == nil {
			p.emit(systemMsg(msgDoorNoKey))
			return
		}
		if w.shutsIn(pos, lock) {
			p.emit(systemMsg(msgDoorShutIn))
			return
		}
	}
	p.active(ctx.Tick, antibot.KindOther)
	w.swapDoor(pos, i, closed)
	if key != nil {
		p.emit(systemMsg(msgDoorRelocked, itemParam(key.def, 1)))
	}
}

// keyFor returns an item p carries (equipped or in a container) that opens lock, or nil.
func (w *World) keyFor(p *Player, lock string) *Item {
	var key *Item
	p.eachCarried(true, func(it *Item) {
		if key == nil && it.def.Key == lock {
			key = it
		}
	})
	return key
}

// swapDoor puts to at stack index i of pos, recomputes what the tile blocks with the
// rule of world/compile (ground.walkable, blocks_movement, blocks_sight) and sends the
// tile to everyone who sees it.
func (w *World) swapDoor(pos world.Pos, i int, to *content.Item) {
	ground, _, _ := w.m.Tile(pos)
	var block world.Flags
	if g := w.byNum[ground]; g == nil || !g.Walkable() {
		block |= world.FlagBlocksMovement
	}
	for j, n := range w.m.Stack(pos) {
		def := w.byNum[n]
		if j == i {
			def = to
		}
		if def == nil {
			continue
		}
		if def.BlocksMovement() {
			block |= world.FlagBlocksMovement
		}
		if def.BlocksSight() {
			block |= world.FlagBlocksSight
		}
	}
	w.m.ReplaceItem(pos, i, to.Numeric, block)
	w.tileChanged(pos)
}

// shutsIn reports whether locking the door at pos would shut in a player who has no key
// for lock (docs/02 "Puertas con llave": nobody is ever locked in). It walks the map from
// each walkable tile next to the door (8 directions, same floor, never through the door)
// to find the sides the door keeps apart, up to shutInSearch tiles each. A side the walk
// cannot finish is open ground; when every side finishes, the biggest one is the outside.
// The other sides are rooms behind the door, and a player without the key in one of them
// would have no way out.
func (w *World) shutsIn(pos world.Pos, lock string) bool {
	side := map[world.Pos]int{} // walked tile → the walk that reached it first
	var size []int              // tiles of each walk; -1 when it could not finish
	var parent []int            // union-find over walks that met (the same side)
	root := func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for d := world.North; d <= world.NorthWest; d++ {
		start, ok := pos.Step(d)
		if _, seen := side[start]; !ok || seen || !w.m.Walkable(start) {
			continue
		}
		id := len(size)
		parent = append(parent, id)
		side[start] = id
		n, queue := 0, []world.Pos{start}
		for len(queue) > 0 && n < shutInSearch {
			t := queue[len(queue)-1]
			queue = queue[:len(queue)-1]
			n++
			for e := world.North; e <= world.NorthWest; e++ {
				q, ok := t.Step(e)
				if !ok || q == pos {
					continue
				}
				if other, seen := side[q]; seen {
					if a, b := root(id), root(other); a != b {
						parent[b] = a // an earlier walk of this same side
					}
					continue
				}
				if w.m.Walkable(q) {
					side[q] = id
					queue = append(queue, q)
				}
			}
		}
		if len(queue) > 0 {
			n = -1
		}
		size = append(size, n)
	}
	// Merge the walks into sides: open if any walk of it could not finish.
	total := map[int]int{}
	var sides []int
	for i, n := range size {
		r := root(i)
		if _, ok := total[r]; !ok {
			sides = append(sides, r)
		}
		switch {
		case n < 0 || total[r] < 0:
			total[r] = -1
		default:
			total[r] += n
		}
	}
	if len(sides) < 2 {
		return false // nothing to be shut in: the door stands in the open
	}
	outside := map[int]bool{}
	biggest := sides[0]
	for _, r := range sides {
		if total[r] < 0 {
			outside[r] = true
		} else if total[biggest] >= 0 && total[r] > total[biggest] {
			biggest = r
		}
	}
	if len(outside) == 0 {
		outside[biggest] = true
	}
	for _, o := range w.players {
		if o.pos.Z != pos.Z {
			continue
		}
		if s, ok := side[o.pos]; ok && !outside[root(s)] && w.keyFor(o, lock) == nil {
			return true
		}
	}
	return false
}
