package session

import (
	"fmt"
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Doors (docs/02-game-design.md, "Puertas con llave"): a door is an item of world.bin with
// a door block. Using it (UseItem, next to it) swaps it for its pair: a closed door opens
// and an open one closes. A locked door (door.key) opens and closes for a player that
// carries a key with that key id, anywhere in its equipment or containers; the key is not
// spent. From the room behind it (door.room) a locked door always opens, key or not: nobody
// is ever locked in, whatever brought them there (a relog or a restart with the door
// locked, a key lost inside). A door does not close on a creature or an item, and a locked
// door does not lock while a player without its key is in the room behind it. What a door
// blocks comes from its item, so walking, pathfinding, line of sight and every client see
// the change at once (Map.ReplaceItem + tileChanged). The state lives in the map only: a
// restart closes and locks every door again.

// i18n keys of the door messages (i18n/*/client.yaml).
const (
	msgDoorLocked   = "door.locked"
	msgDoorUnlocked = "door.unlocked"
	msgDoorUnbarred = "door.unbarred"
	msgDoorRelocked = "door.relocked"
	msgDoorNoKey    = "door.no_key"
	msgDoorBlocked  = "door.blocked"
	msgDoorShutIn   = "door.shut_in"
	msgDoorNotReady = "door.not_ready"
)

// doorRoomSearch bounds the walk doorRoom makes from a door, in tiles per side: a side
// bigger than this is open ground that leads elsewhere, not a room behind the door.
const doorRoomSearch = 4096

// doorEvery is how long a player waits between two doors it opens or closes: a player
// toggling a door as fast as the gateway lets it would send the tile to everyone around
// 30 times a second.
const doorEvery = 500 // ms

// door is a tile of the map with a door item (initDoors).
type door struct {
	// lock is the key id of its closed item, "" for a door anyone opens.
	lock string
	// room holds the tiles behind a locked door (doorRoom): from them a player opens it
	// without the key, and a player without the key on them keeps it from locking.
	room map[world.Pos]struct{}
}

// initDoors checks the doors and keys of the items (content.CheckDoors), finds the doors
// of the map and works out the room behind each locked one. The walls of the map never
// change, and a walk through a room counts every door as open, so the rooms hold for good.
func (w *World) initDoors() error {
	if err := content.CheckDoors(w.cfg.Items); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	w.doors = map[world.Pos]*door{}
	for _, is := range w.m.Islands() {
		for _, s := range is.Sectors() {
			for _, st := range s.Stacks {
				p := world.Pos{
					X: s.CX*world.SectorSize + st.Index%world.SectorSize,
					Y: s.CY*world.SectorSize + st.Index/world.SectorSize,
					Z: s.Z,
				}
				for _, n := range st.Items {
					def := w.byNum[n]
					if def == nil || def.Door == nil {
						continue
					}
					if h := w.m.HouseAt(p); h != nil && slices.Contains(h.Doors, p) {
						// Using it would open the door, never the house window (useItem).
						return fmt.Errorf("session: door %q on %v, a door of house %q", def.ID, p, h.ID)
					}
					lock := def.Door.Key
					if def.Door.Closed != "" {
						lock = w.cfg.Items[def.Door.Closed].Door.Key // CheckDoors: the pair exists
					}
					w.doors[p] = &door{lock: lock}
				}
			}
		}
	}
	for p, d := range w.doors { // any order: a room depends on the map alone
		if d.lock != "" {
			d.room = w.doorRoom(p)
		}
	}
	return nil
}

// useDoor answers a UseItem on a door of the map. It reports whether the UseItem was
// about a door p sees; anything else goes on to the other uses of map items.
func (w *World) useDoor(ctx *game.TickContext, p *Player, m *pb.UseItem) bool {
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	d := w.doors[pos]
	i := int(m.GetStackIndex())
	if !ok || d == nil || i < 1 || i >= w.staticCount(pos) || pos.Z != p.pos.Z || !Sees(p.pos, pos) {
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
		w.openDoor(ctx, p, pos, i-1, def, d)
	} else {
		w.closeDoor(ctx, p, pos, i-1, def, d)
	}
	return true
}

// openDoor opens the closed door def at stack index i of pos: a locked one with a key,
// or from the room behind it.
func (w *World) openDoor(ctx *game.TickContext, p *Player, pos world.Pos, i int, def *content.Item, d *door) {
	var key *Item
	inside := false
	if d.lock != "" {
		if key = w.keyFor(p, d.lock); key == nil {
			if _, inside = d.room[p.pos]; !inside {
				p.emit(systemMsg(msgDoorLocked))
				return
			}
		}
	}
	if !w.doorReady(ctx, p) {
		return
	}
	w.swapDoor(pos, i, w.cfg.Items[def.Door.Open])
	switch {
	case key != nil:
		p.emit(systemMsg(msgDoorUnlocked, itemParam(key.def, 1)))
	case inside:
		p.emit(systemMsg(msgDoorUnbarred))
	}
}

// closeDoor closes the open door def at stack index i of pos: the tile must be free, and
// a locked door locks again only with its key and with no player without it in its room.
func (w *World) closeDoor(ctx *game.TickContext, p *Player, pos world.Pos, i int, def *content.Item, d *door) {
	if w.occupied(pos) || len(w.ground[pos]) > 0 {
		p.emit(systemMsg(msgDoorBlocked))
		return
	}
	var key *Item
	if d.lock != "" {
		if key = w.keyFor(p, d.lock); key == nil {
			p.emit(systemMsg(msgDoorNoKey))
			return
		}
		if w.shutsIn(d) {
			p.emit(systemMsg(msgDoorShutIn))
			return
		}
	}
	if !w.doorReady(ctx, p) {
		return
	}
	w.swapDoor(pos, i, w.cfg.Items[def.Door.Closed])
	if key != nil {
		p.emit(systemMsg(msgDoorRelocked, itemParam(key.def, 1)))
	}
}

// doorReady reports whether p may open or close a door now (doorEvery), telling it when
// not, and starts its wait when it may.
func (w *World) doorReady(ctx *game.TickContext, p *Player) bool {
	if ctx.Tick < p.nextDoor {
		p.tooEarly(ctx.Tick, antibot.KindOther)
		p.emit(systemMsg(msgDoorNotReady))
		return false
	}
	p.activePaced(ctx.Tick, antibot.KindOther, p.nextDoor)
	p.nextDoor = ctx.Tick + ticksFor(doorEvery)
	return true
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

// shutsIn reports whether a player without the key of the locked door d stands in its
// room: locking d would shut it in (it could still open d from inside, but locking a
// player in is no move a key holder gets to make). One map lookup per player.
func (w *World) shutsIn(d *door) bool {
	for _, o := range w.players {
		if _, in := d.room[o.pos]; in && w.keyFor(o, d.lock) == nil {
			return true
		}
	}
	return false
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

// doorRoom returns the room behind the locked door at pos (docs/02 "Puertas con llave"):
// it walks the map from each passable tile next to the door (8 directions, same floor,
// never through the door, every other door open) to find the sides the door keeps apart,
// up to doorRoomSearch tiles each. A side the walk cannot finish is open ground; when
// every side finishes, the biggest one is the outside. The other sides are the room. A
// door with one side (it stands in the open) or with every side open has no room.
func (w *World) doorRoom(pos world.Pos) map[world.Pos]struct{} {
	passable := func(q world.Pos) bool { return w.m.Walkable(q) || w.doors[q] != nil }
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
		if _, seen := side[start]; !ok || seen || !passable(start) {
			continue
		}
		id := len(size)
		parent = append(parent, id)
		side[start] = id
		n, queue := 0, []world.Pos{start}
		for len(queue) > 0 && n < doorRoomSearch {
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
				if passable(q) {
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
		return nil // nothing behind the door: it stands in the open
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
	room := map[world.Pos]struct{}{}
	for t, s := range side {
		if !outside[root(s)] {
			room[t] = struct{}{}
		}
	}
	return room
}
