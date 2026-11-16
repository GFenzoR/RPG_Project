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

// Why the room behind a locked door cannot be worked out (doorRoom), or cannot be trusted
// (initDoors: a door nobody gets through, a room shared with a locked door of another key;
// checkEscapes: a side that leads nowhere, a room a player without its key gets into).
// The world does not start with such a door, and make validate refuses it first (same
// rules, same fixture: packages/map-format/src/testdata/door-rooms.json).
var (
	// errDoorBlocked: something on the door's tile besides the door blocks the way, so
	// nobody gets through it even open: its room could only be left by a way the escape
	// check does not see.
	errDoorBlocked = errors.New("it lets nobody through, even open: something on its tile besides the door blocks the way")
	// errDoorWalled: no tile around the door lets anyone through.
	errDoorWalled = errors.New("it leads nowhere: no tile around it lets anyone through")
	// errDoorInTheOpen: every tile around the door is one side, so it keeps nothing apart.
	errDoorInTheOpen = errors.New("it keeps nothing apart: every tile around it is one side")
	// errDoorTruncated: more than one side is bigger than doorRoomSearch, so the room
	// would be open ground too.
	errDoorTruncated = fmt.Errorf("more than one side is bigger than %d tiles: no room behind it", doorRoomSearch)
	// errDoorTie: every side is closed and the two biggest have the same size, so neither
	// is clearly the outside.
	errDoorTie = errors.New("its two biggest sides have the same size: which one is the outside is unclear")
	// errDoorOtherKey: it shares its room with a locked door of another key, whose key
	// would open both from the room.
	errDoorOtherKey = errors.New("it shares its room with a locked door of another key")
	// errDoorNoEscape: a side of it reaches no temple the ways a player without keys or
	// tools always has (checkEscapes: on foot, out of a room through its locked doors, by
	// stairs, ladders, holes and teleports), so whoever stands there could be locked in: a
	// vault no door guards (bigger than the room before it, so its door takes it for the
	// outside), or a side joined to the world only through a house, a boat, a rope spot or
	// across the tile of stairs or a teleport that leads elsewhere.
	errDoorNoEscape = errors.New("a side of it reaches no temple without keys (on foot, out of rooms, by stairs, ladders, holes and teleports): whoever is there could be locked in")
	// errDoorBypassed: a player without its key gets into its room (checkEscapes): a
	// locked door of another key opens from its own room, which such a player reaches,
	// onto it (a cycle of locked doors of different keys).
	errDoorBypassed = errors.New("a player without its key gets into its room: a locked door of another key opens onto it from a room such a player reaches")
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
// locked doors (doorRoom). Doors that share a room (a double door, a front and a back
// door) have the same key (initDoors).
type room struct {
	// door is the first locked door (map order) the room lies behind: for messages, and
	// every other door of the room is compared with it.
	door world.Pos
	// at is a tile of the room: its area (areaOf) is the room's.
	at world.Pos
	// sectors are the keys (sectorKey) of the sectors the room covers: shutsIn looks at
	// the players there only.
	sectors []uint64
}

// initDoors checks the doors and keys of the items (content.CheckDoors), finds the doors
// of the map, works out the room behind each locked one and numbers the areas of the map
// (initAreas). The walls of the map never change, and the walks count every locked door
// as a wall and every other door as open, so the rooms and areas hold for good. A locked
// door nobody gets through even open, whose room cannot be worked out, whose room it
// shares with a locked door of another key, whose room holds what belongs outside
// (checkRooms) or that fails the escape check (checkEscapes) stops the world from
// starting.
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
		d := w.doors[p]
		if !d.through {
			return fmt.Errorf("session: locked door on %v: %w", p, errDoorBlocked)
		}
		sides, err := w.doorRoom(p)
		if err != nil {
			return fmt.Errorf("session: locked door on %v: %w", p, err)
		}
		for _, side := range sides {
			// A finite side is a whole area of the map with every locked door as a wall,
			// so two doors that share one tile of it share all of it (a double door).
			id := w.roomOf[side[0]]
			if id == 0 {
				id = w.newRoom(p, side)
			} else if first := w.rooms[id-1].door; w.doors[first].lock != d.lock {
				return fmt.Errorf("session: locked door on %v: %w (the door on %v)", p, errDoorOtherKey, first)
			}
			d.room = append(d.room, id)
		}
	}
	if err := w.checkRooms(); err != nil {
		return err
	}
	w.initAreas()
	return w.checkEscapes(locked)
}

// roomPassable reports whether the walks of the rooms (doorRoom, initAreas) go through q:
// a locked door is a wall, any other door is open if its tile lets creatures through.
func (w *World) roomPassable(q world.Pos) bool {
	if d := w.doors[q]; d != nil {
		return d.lock == "" && d.through
	}
	return w.m.Walkable(q)
}

// doorSide is a side of a locked door for checkEscapes: an area next to it, and the first
// tile next to it (direction order) in that area, for messages.
type doorSide struct {
	area int32
	at   world.Pos
}

// checkEscapes checks the locked doors (in map order) on the graph of the areas of the
// map (docs/02 "Puertas con llave", "Chequeo de escape"). A player without keys goes from
// the room behind a locked door to every side of it (the door opens from inside) and, by
// a portal it needs nothing for (escapeWay: stairs, ladders, holes and teleports), from
// the areas it takes the portal from (portalSources) to the area of its destination. The
// world is the areas of the temples: a boat arrival is a way in, not out (leaving by boat
// takes a captain and whatever the route asks). It fails with errDoorNoEscape when a side
// of a door does not reach the world that way (whoever is there could be locked in: a
// vault no door guards), and with errDoorBypassed when a player with every key but one
// gets into a room of that key: a locked door of another key opens onto that room (it is
// that door's outside) from its own room, which the player reaches. Such a player starts
// anywhere outside the rooms, in an area or in a house (an owner or a guest), and crosses
// with its keys every locked door of another key from any side, or from a house next to
// it, into its room. Rooms in a cycle of doors of one key pass (a building with a back
// door to a yard with its own gate); a room inside another passes whatever its key, since
// its door opens only onto the room around it.
func (w *World) checkEscapes(locked []world.Pos) error {
	if len(locked) == 0 {
		return nil
	}
	roomArea := make([]int32, len(w.rooms)) // room id - 1 → its area
	areaRoom := map[int32]int32{}           // area → room id, for the areas that are rooms
	for i, r := range w.rooms {
		roomArea[i] = w.areaOf(r.at)
		areaRoom[roomArea[i]] = int32(i + 1)
	}
	sides := make([][]doorSide, len(locked)) // the sides of each locked door, direction order
	bySide := map[int32][]int{}              // area → the locked doors (indexes) it is a side of
	byHouse := make([]bool, len(locked))     // whether a house tile someone stands on is next to it
	for i, p := range locked {
		for e := world.North; e <= world.NorthWest; e++ {
			q, ok := p.Step(e)
			if !ok {
				continue
			}
			if w.m.Flags(q)&world.FlagHouse != 0 && w.roomPassable(q) {
				byHouse[i] = true
			}
			a := w.areaOf(q)
			if a == 0 || slices.ContainsFunc(sides[i], func(s doorSide) bool { return s.area == a }) {
				continue
			}
			sides[i] = append(sides[i], doorSide{area: a, at: q})
			bySide[a] = append(bySide[a], i)
		}
	}
	// back: area → the areas a player without keys goes to it from.
	back := map[int32][]int32{}
	for i, p := range locked {
		for _, r := range w.doors[p].room {
			from := roomArea[r-1]
			for _, s := range sides[i] {
				if s.area != from {
					back[s.area] = append(back[s.area], from)
				}
			}
		}
	}
	for _, pt := range w.m.Portals() {
		to := w.areaOf(pt.To)
		if !escapeWay(pt.Kind) || to == 0 {
			continue
		}
		for _, from := range w.portalSources(pt, roomArea) {
			if from != to {
				back[to] = append(back[to], from)
			}
		}
	}
	escapes := map[int32]bool{}
	var queue []int32
	reach := func(a int32) {
		if a != 0 && !escapes[a] {
			escapes[a] = true
			queue = append(queue, a)
		}
	}
	for _, is := range w.m.Islands() {
		reach(w.areaOf(is.Temple))
	}
	for i := 0; i < len(queue); i++ {
		for _, a := range back[queue[i]] {
			reach(a)
		}
	}
	for i, p := range locked {
		for _, s := range sides[i] {
			if !escapes[s.area] {
				return fmt.Errorf("session: locked door on %v: %w (its side on %v)", p, errDoorNoEscape, s.at)
			}
		}
	}

	// without returns the areas a player with every key but k reaches (cached by key).
	cache := map[string]map[int32]bool{}
	without := func(k string) map[int32]bool {
		if seen, ok := cache[k]; ok {
			return seen
		}
		seen := map[int32]bool{}
		var queue []int32
		push := func(a int32) {
			if !seen[a] {
				seen[a] = true
				queue = append(queue, a)
			}
		}
		for i := range locked {
			for _, s := range sides[i] {
				if areaRoom[s.area] == 0 {
					push(s.area) // anywhere outside the rooms
				}
			}
			if d := w.doors[locked[i]]; byHouse[i] && d.lock != k {
				for _, r := range d.room {
					push(roomArea[r-1]) // from a house into its room, with its key
				}
			}
		}
		for n := 0; n < len(queue); n++ {
			a := queue[n]
			for _, i := range bySide[a] {
				d := w.doors[locked[i]]
				if d.inRoom(areaRoom[a]) {
					for _, s := range sides[i] {
						push(s.area) // out of its room, without the key
					}
				} else if d.lock != k {
					for _, r := range d.room {
						push(roomArea[r-1]) // into its room, with its key
					}
				}
			}
		}
		cache[k] = seen
		return seen
	}
	for i, g := range locked {
		gd := w.doors[g]
		for _, s := range sides[i] {
			r := areaRoom[s.area]
			if r == 0 || gd.inRoom(r) {
				continue
			}
			first := w.rooms[r-1].door
			k := w.doors[first].lock
			if k == gd.lock {
				continue
			}
			seen := without(k)
			for _, own := range gd.room {
				if seen[roomArea[own-1]] {
					return fmt.Errorf("session: locked door on %v: %w (the door on %v opens onto it from its own room)", first, errDoorBypassed, g)
				}
			}
		}
	}
	return nil
}

// escapeWay reports whether a portal of kind k is a way out of an area for checkEscapes:
// one every player takes without keys, tools, money or a level (stairs, ladders, holes,
// teleports). A rope spot needs a rope; a boat portal moves nobody (the captain's routes
// need gold, a level, a quest or a ticket). A new kind is no way out until it is added here
// and in packages/map-format doors.ts.
func escapeWay(k world.PortalKind) bool {
	switch k {
	case world.PortalStairs, world.PortalLadder, world.PortalHole, world.PortalTeleport:
		return true
	}
	return false
}

// portalSources returns the areas a player takes the portal pt from (checkEscapes): for a
// ladder, the area of its tile (the player stands there to climb); for stairs, a hole or a
// teleport, whose tile lies in no area (stepping onto it moves the player), the areas of
// the tiles next to it and the rooms of a locked door next to it (a player in its room
// opens it without the key and steps on from the door's tile; initDoors refused every
// locked door nobody gets through). roomArea is checkEscapes' room id - 1 → area.
func (w *World) portalSources(pt *world.Portal, roomArea []int32) []int32 {
	if !pt.Kind.OnStep() {
		if a := w.areaOf(pt.From); a != 0 {
			return []int32{a}
		}
		return nil
	}
	var out []int32
	add := func(a int32) {
		if a != 0 && !slices.Contains(out, a) {
			out = append(out, a)
		}
	}
	for e := world.North; e <= world.NorthWest; e++ {
		q, ok := pt.From.Step(e)
		if !ok {
			continue
		}
		add(w.areaOf(q))
		if d := w.doors[q]; d != nil && d.lock != "" {
			for _, r := range d.room {
				add(roomArea[r-1])
			}
		}
	}
	return out
}

// newRoom indexes the tiles of a new room behind the locked door at p and returns its id.
func (w *World) newRoom(p world.Pos, tiles []world.Pos) int32 {
	w.rooms = append(w.rooms, room{door: p, at: tiles[0]})
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
// llave"): a temple (where players wake up), an NPC, a house tile or exit, a portal end
// (portal.go), a boat arrival or the destination of a dialog teleport. Either the outside
// was taken for the room, or a player would land behind a locked door (or leave it by a
// way the room walk does not know). Spawns may lie in a room: the forge keeps its warden
// behind the gate. make validate checks the same.
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
	for _, pt := range w.m.Portals() {
		for _, end := range [2]world.Pos{pt.From, pt.To} {
			if d, ok := behind(end); ok {
				return fmt.Errorf("session: portal %q has its end %v in the room behind the locked door on %v", pt.ID, end, d)
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
// one slice of tiles per side that is not the outside (in no order). It walks the map
// from each passable tile next to the door (8 directions, same floor, roomPassable: never
// through a locked door, every other door open when its tile lets creatures through) to
// find the sides the door keeps apart, up to doorRoomSearch tiles each. A side the walk
// cannot finish is open ground: the outside. When every side finishes, the biggest one
// is the outside. It fails with errDoorWalled (no side), errDoorInTheOpen (one side),
// errDoorTruncated (two sides or more too big to walk) or errDoorTie (the two biggest
// closed sides have the same size).
func (w *World) doorRoom(pos world.Pos) ([][]world.Pos, error) {
	passable := w.roomPassable
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
	switch len(sides) {
	case 0:
		return nil, errDoorWalled
	case 1:
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
