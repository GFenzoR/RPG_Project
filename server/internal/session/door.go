package session

import (
	"errors"
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
// bigger than this is open ground that leads elsewhere, not a room behind the door. The
// map validator (packages/map-format doors.ts) uses the same number.
const doorRoomSearch = 4096

// Why the room behind a locked door cannot be worked out (doorRoom). The world does not
// start with such a door, and make validate refuses it first (same rules, same fixture:
// packages/map-format/src/testdata/door-rooms.json).
var (
	// errDoorInTheOpen: every tile around the door is one side, so it keeps nothing apart.
	errDoorInTheOpen = errors.New("it keeps nothing apart: every tile around it is one side")
	// errDoorTruncated: more than one side is bigger than doorRoomSearch, so the room
	// would be open ground too.
	errDoorTruncated = fmt.Errorf("more than one side is bigger than %d tiles: no room behind it", doorRoomSearch)
	// errDoorTie: every side is closed and the two biggest have the same size, so neither
	// is clearly the outside.
	errDoorTie = errors.New("its two biggest sides have the same size: which one is the outside is unclear")
)

// door is a tile of the map with a door item (initDoors).
type door struct {
	// lock is the key id of its closed item, "" for a door anyone opens.
	lock string
	// through reports whether a creature gets through the tile once the door is open: its
	// ground is walkable and every other item that blocks movement is a door (the rule of
	// map-format isPassable).
	through bool
	// room lists the rooms (ids of World.rooms, 1-based) behind a locked door: from them a
	// player opens it without the key, and a player without the key in them keeps it
	// from locking. Usually one; nil for a door without a lock.
	room []int32
}

// inRoom reports whether the room id r (World.roomOf of a tile, 0 for none) lies behind d.
func (d *door) inRoom(r int32) bool { return r != 0 && slices.Contains(d.room, r) }

// room is one room behind locked doors: a side of a locked door closed off by walls and
// locked doors (doorRoom). A double door shares its room.
type room struct {
	// door is the first locked door (map order) the room lies behind, for messages.
	door world.Pos
	// sectors are the keys (sectorKey) of the sectors the room covers: shutsIn looks at
	// the players there only.
	sectors []uint64
}

// initDoors checks the doors and keys of the items (content.CheckDoors), finds the doors
// of the map and works out the room behind each locked one. The walls of the map never
// change, and the walks count every locked door as a wall and every other door as open,
// so the rooms hold for good. A locked door whose room cannot be worked out, or whose room
// holds what belongs outside (checkRooms), stops the world from starting.
func (w *World) initDoors() error {
	if err := content.CheckDoors(w.cfg.Items); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	w.doorFor = ticksFor(max(w.cfg.Balance.Inventory.DoorCooldownMs, 1))
	w.doors = map[world.Pos]*door{}
	w.roomOf = map[world.Pos]int32{}
	w.rooms = nil
	var locked []world.Pos // map order: islands, then z, cy, cx, tile index
	for _, is := range w.m.Islands() {
		for _, s := range is.Sectors() {
			for _, st := range s.Stacks {
				p := world.Pos{
					X: s.CX*world.SectorSize + st.Index%world.SectorSize,
					Y: s.CY*world.SectorSize + st.Index/world.SectorSize,
					Z: s.Z,
				}
				var def *content.Item
				for _, n := range st.Items {
					it := w.byNum[n]
					if it == nil || it.Door == nil {
						continue
					}
					if def != nil {
						// One door per tile: a use swaps one item, and the lock of the tile is one.
						return fmt.Errorf("session: doors %q and %q on the same tile %v", def.ID, it.ID, p)
					}
					def = it
				}
				if def == nil {
					continue
				}
				if h := w.m.HouseAt(p); h != nil && slices.Contains(h.Doors, p) {
					// Using it would open the door, never the house window (useItem).
					return fmt.Errorf("session: door %q on %v, a door of house %q", def.ID, p, h.ID)
				}
				lock := def.Door.Key
				if def.Door.Closed != "" {
					lock = w.cfg.Items[def.Door.Closed].Door.Key // CheckDoors: the pair exists
					// make validate warns too: it opens closed after every restart.
					w.log.Warn("door placed open on the map", "item", def.ID, "pos", p.String())
				}
				w.doors[p] = &door{lock: lock, through: w.doorThrough(p)}
				if lock != "" {
					locked = append(locked, p)
				}
			}
		}
	}
	for _, p := range locked {
		sides, err := w.doorRoom(p)
		if err != nil {
			return fmt.Errorf("session: locked door on %v: %w", p, err)
		}
		d := w.doors[p]
		for _, side := range sides {
			// A finite side is a whole area of the map with every locked door as a wall,
			// so two doors that share one tile of it share all of it (a double door).
			id := w.roomOf[side[0]]
			if id == 0 {
				id = w.newRoom(p, side)
			}
			d.room = append(d.room, id)
		}
	}
	return w.checkRooms()
}

// roomAllows reports whether a search for a free tile that started in room from (a
// roomOf id, 0 for none) may put a creature on q: q lies in no room, or in that same one.
// The searches by rings (freeNear, houseExit) do not follow walls: without this, a crowd
// next to a locked door would put someone in the room behind it, where it opens the door
// without the key.
func (w *World) roomAllows(from int32, q world.Pos) bool {
	r := w.roomOf[q]
	return r == 0 || r == from
}

// newRoom indexes the tiles of a new room behind the locked door at p and returns its id.
func (w *World) newRoom(p world.Pos, tiles []world.Pos) int32 {
	w.rooms = append(w.rooms, room{door: p})
	id := int32(len(w.rooms))
	r := &w.rooms[id-1]
	for _, t := range tiles {
		w.roomOf[t] = id
		if k := sectorKey(int(t.X), int(t.Y), t.Z); !slices.Contains(r.sectors, k) {
			r.sectors = append(r.sectors, k)
		}
	}
	slices.Sort(r.sectors)
	return id
}

// doorThrough reports whether a creature gets through the door tile p once its door is
// open: walkable ground and nothing else on it that blocks movement but a door.
func (w *World) doorThrough(p world.Pos) bool {
	g, _, _ := w.m.Tile(p)
	if def := w.byNum[g]; def == nil || !def.Walkable() {
		return false
	}
	for _, n := range w.m.Stack(p) {
		if def := w.byNum[n]; def != nil && def.Door == nil && def.BlocksMovement() {
			return false
		}
	}
	return true
}

// checkRooms refuses a room that holds what belongs outside (docs/02 "Puertas con
// llave"): a temple (where players wake up), an NPC, a house tile or exit, a boat arrival
// or the destination of a dialog teleport. Either the outside was taken for the room, or
// a player would land behind a locked door. Spawns may lie in a room: the forge keeps its
// warden behind the gate. make validate checks the same (and portals, which the server
// does not load).
func (w *World) checkRooms() error {
	if len(w.rooms) == 0 {
		return nil
	}
	behind := func(p world.Pos) (world.Pos, bool) {
		if id := w.roomOf[p]; id != 0 {
			return w.rooms[id-1].door, true
		}
		return world.Pos{}, false
	}
	for _, is := range w.m.Islands() {
		if d, ok := behind(is.Temple); ok {
			return fmt.Errorf("session: the temple of island %q on %v lies in the room behind the locked door on %v", is.ID, is.Temple, d)
		}
		for _, n := range is.NPCs {
			if d, ok := behind(n.Pos); ok {
				return fmt.Errorf("session: npc %q on %v stands in the room behind the locked door on %v", n.NPC, n.Pos, d)
			}
		}
		for _, h := range is.Houses {
			if d, ok := behind(h.Exit); ok {
				return fmt.Errorf("session: the exit of house %q on %v lies in the room behind the locked door on %v", h.ID, h.Exit, d)
			}
			for _, r := range h.Rects {
				for y := int(r.Y); y < int(r.Y)+int(r.H); y++ {
					for x := int(r.X); x < int(r.X)+int(r.W); x++ {
						t := world.Pos{X: uint16(x), Y: uint16(y), Z: r.Z}
						if d, ok := behind(t); ok {
							return fmt.Errorf("session: house %q on %v lies in the room behind the locked door on %v", h.ID, t, d)
						}
					}
				}
			}
		}
	}
	for _, r := range w.cfg.BoatRoutes {
		if to, ok := worldPos(r.To); ok {
			if d, in := behind(to); in {
				return fmt.Errorf("session: boat route %q arrives on %v, in the room behind the locked door on %v", r.ID, to, d)
			}
		}
	}
	for _, id := range sortedKeys(w.cfg.NPCs) {
		nodes := w.cfg.NPCs[id].Dialog.Nodes
		for _, node := range sortedKeys(nodes) {
			for _, o := range nodes[node].Options {
				for _, a := range o.Action {
					if a.Teleport == nil {
						continue
					}
					if to, ok := worldPos(*a.Teleport); ok {
						if d, in := behind(to); in {
							return fmt.Errorf("session: npc %q node %q teleports to %v, in the room behind the locked door on %v", id, node, to, d)
						}
					}
				}
			}
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
	// Every use next to a door counts, refused or not: a refusal is answered at the same
	// pace as an opening, and its checks (keys, the room) run at most that often.
	if !w.doorReady(ctx, p) {
		return true
	}
	if def.Door.Open != "" {
		w.openDoor(p, pos, i-1, def, d)
	} else {
		w.closeDoor(p, pos, i-1, def, d)
	}
	return true
}

// openDoor opens the closed door def at stack index i of pos: a locked one with a key,
// or from the room behind it.
func (w *World) openDoor(p *Player, pos world.Pos, i int, def *content.Item, d *door) {
	var key *Item
	inside := false
	if d.lock != "" {
		if key = w.keyFor(p, d.lock); key == nil {
			if inside = d.inRoom(w.roomOf[p.pos]); !inside {
				p.emit(systemMsg(msgDoorLocked))
				return
			}
		}
	}
	if !w.swapDoor(p, pos, i, w.cfg.Items[def.Door.Open]) {
		return
	}
	switch {
	case key != nil:
		p.emit(systemMsg(msgDoorUnlocked, itemParam(key.def, 1)))
	case inside:
		p.emit(systemMsg(msgDoorUnbarred))
	}
}

// closeDoor closes the open door def at stack index i of pos: the tile must be free, and
// a locked door locks again only with its key and with no player without it in its room.
func (w *World) closeDoor(p *Player, pos world.Pos, i int, def *content.Item, d *door) {
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
	if !w.swapDoor(p, pos, i, w.cfg.Items[def.Door.Closed]) {
		return
	}
	if key != nil {
		p.emit(systemMsg(msgDoorRelocked, itemParam(key.def, 1)))
	}
}

// doorReady reports whether p may use a door now (inventory.door_cooldown_ms), telling it
// when not, and starts its wait when it may.
func (w *World) doorReady(ctx *game.TickContext, p *Player) bool {
	if ctx.Tick < p.nextDoor {
		p.tooEarly(ctx.Tick, antibot.KindOther)
		p.emit(systemMsg(msgDoorNotReady))
		return false
	}
	p.activePaced(ctx.Tick, antibot.KindOther, p.nextDoor)
	p.nextDoor = ctx.Tick + w.doorFor
	return true
}

// keyFor returns the first item p carries (equipped, then inside each equipped container
// in depth-first order, like eachCarried) that opens lock, or nil. It stops at the key.
func (w *World) keyFor(p *Player, lock string) *Item {
	for _, it := range p.equip {
		if it == nil {
			continue
		}
		if it.def.Key == lock {
			return it
		}
		if k := keyIn(it.items, lock); k != nil {
			return k
		}
	}
	return nil
}

// keyIn returns the first item of items, or inside them, that opens lock, or nil.
func keyIn(items []*Item, lock string) *Item {
	for _, it := range items {
		if it.def.Key == lock {
			return it
		}
		if k := keyIn(it.items, lock); k != nil {
			return k
		}
	}
	return nil
}

// shutsIn reports whether a player without the key of the locked door d stands in its
// room: locking d would shut it in (it could still open d from inside, but locking a
// player in is no move a key holder gets to make). It looks at the players of the
// sectors the room covers only, one map lookup each, and at the bags of those inside.
func (w *World) shutsIn(d *door) bool {
	for _, id := range d.room {
		for _, k := range w.rooms[id-1].sectors {
			for _, o := range w.sectors[k] {
				if d.inRoom(w.roomOf[o.pos]) && w.keyFor(o, d.lock) == nil {
					return true
				}
			}
		}
	}
	return false
}

// swapDoor puts to at stack index i of pos, recomputes what the tile blocks with the
// rule of world/compile (ground.walkable, blocks_movement, blocks_sight) and sends the
// tile to everyone who sees it. It reports whether the map took the change; when not
// (a map that does not hold the door any more), p hears it is not possible and nothing
// is sent.
func (w *World) swapDoor(p *Player, pos world.Pos, i int, to *content.Item) bool {
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
	if !w.m.ReplaceItem(pos, i, to.Numeric, block) {
		w.log.Error("door: the map refused the swap", "pos", pos.String(), "index", i, "item", to.ID)
		p.emit(systemMsg(msgNotPossible))
		return false
	}
	w.tileChanged(pos)
	return true
}

// doorRoom returns the room behind the locked door at pos (docs/02 "Puertas con llave"),
// one slice of tiles per side that is not the outside. It walks the map from each
// passable tile next to the door (8 directions, same floor, never through a locked door,
// every other door open when its tile lets creatures through) to find the sides the door
// keeps apart, up to doorRoomSearch tiles each. A side the walk cannot finish is open
// ground: the outside. When every side finishes, the biggest one is the outside. It fails
// with errDoorInTheOpen (one side), errDoorTruncated (two sides or more too big to walk)
// or errDoorTie (the two biggest closed sides have the same size).
func (w *World) doorRoom(pos world.Pos) ([][]world.Pos, error) {
	passable := func(q world.Pos) bool {
		if d := w.doors[q]; d != nil {
			return d.lock == "" && d.through
		}
		return w.m.Walkable(q)
	}
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
	var sides []int // roots, in the order of the first walk of each side
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
		return nil, errDoorInTheOpen
	}
	outside, open := -1, 0
	for _, r := range sides {
		if total[r] < 0 {
			outside = r
			open++
		}
	}
	switch {
	case open > 1:
		return nil, errDoorTruncated
	case open == 0:
		outside = sides[0]
		for _, r := range sides[1:] {
			if total[r] > total[outside] {
				outside = r
			}
		}
		for _, r := range sides {
			if r != outside && total[r] == total[outside] {
				return nil, errDoorTie
			}
		}
	}
	index := map[int]int{} // side root → its slice in rooms
	var rooms [][]world.Pos
	for _, r := range sides {
		if r != outside {
			index[r] = len(rooms)
			rooms = append(rooms, make([]world.Pos, 0, total[r]))
		}
	}
	for t, s := range side {
		if k, ok := index[root(s)]; ok {
			rooms[k] = append(rooms[k], t)
		}
	}
	return rooms, nil
}
