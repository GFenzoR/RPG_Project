package session_test

import (
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Numeric ids of the keys: no other test item has them (testItemDefs grows in init of
// other files: magic_test.go has 71, ranged_test.go 72).
const (
	gateKeyID  = 160
	otherKeyID = 161
)

const sw = pb.Direction_DIRECTION_SOUTH_WEST

// doorTestItems are testItems plus a walkable grass, a gate (the D and d of the
// drawings, locked with gate_lock when locked) and its key.
func doorTestItems(locked bool) content.Items {
	lock := ""
	if locked {
		lock = ", key: gate_lock"
	}
	items := testItems()
	for n, src := range map[uint16]string{
		grassID:            "{id: grass, kind: ground, ground: {walkable: true}}",
		worldtest.Door:     "{id: test_gate, kind: decoration, pickupable: false, blocks_movement: true, blocks_sight: true, door: {open: test_gate_open" + lock + "}}",
		worldtest.OpenDoor: "{id: test_gate_open, kind: decoration, pickupable: false, door: {closed: test_gate}}",
		gateKeyID:          "{id: gate_key, kind: material, weight: 100, key: gate_lock}",
		otherKeyID:         "{id: other_key, kind: material, weight: 100, key: other_lock}",
	} {
		var it content.Item
		_ = yaml.Unmarshal([]byte(src), &it)
		it.Numeric = n
		items[it.ID] = &it
	}
	return items
}

// doorMap is a small room (west) behind a gate at (4, 2), and a bigger hall (east).
func doorMap(t *testing.T) *world.Map {
	return worldtest.Map(t, 0, 0, 7,
		"###########",
		"#...#.....#",
		"#...D.....#",
		"#...#.....#",
		"###########",
	)
}

var gate = pos(4, 2)

func useGate(id uint32) *pb.ClientMessage { return useItem(onTile(gate), id, 1) }

// tileOf returns the item ids of the last TileUpdate of pos in evs (nil if none).
func tileOf(evs []*pb.ServerMessage, p world.Pos) []uint32 {
	var out []uint32
	for _, u := range find(evs, (*pb.ServerMessage).GetTileUpdate) {
		if u.GetPos().GetX() == uint32(p.X) && u.GetPos().GetY() == uint32(p.Y) {
			out = out[:0]
			for _, it := range u.GetTile().GetItems() {
				out = append(out, it.GetItemId())
			}
		}
	}
	return out
}

// A locked gate (docs/02 "Puertas con llave"): it blocks walking and sight; without the
// key it stays shut; with the key anywhere on the player it opens for everyone, and only
// a key holder locks it again: never on a creature or an item, and never with a player
// without the key in the room behind it.
func TestLockedDoor(t *testing.T) {
	h := newHarness(t, doorMap(t), func(c *session.Config) { c.Items = doorTestItems(true) })
	clA, a := h.joinChar(withPack(9101, pos(6, 2)))
	tag := withPack(9102, pos(6, 1))
	tag.Name = "Tagalong"
	clB, b := h.joinChar(tag)
	h.sim.Step()
	clA.take()
	clB.take()

	// Walking into the shut gate is refused.
	h.input(clA, walk(W))
	h.sim.RunFor(2 * time.Second)
	h.input(clA, walk(W))
	h.sim.RunFor(2 * time.Second)
	if a.Pos() != pos(5, 2) || h.w.Walkable(gate) {
		t.Fatalf("keyholder at %v, gate walkable %v", a.Pos(), h.w.Walkable(gate))
	}
	clA.take()

	// From two tiles away it is too far; next to it, without the key, it is locked.
	if evs := h.send(clB, useGate(worldtest.Door)); !hasKey(evs, "inventory.too_far") {
		t.Fatalf("far use: %v", systemKeys(evs))
	}
	if evs := h.send(clA, useGate(worldtest.Door)); !hasKey(evs, "door.locked") || tileOf(evs, gate) != nil {
		t.Fatalf("use without key: %v", systemKeys(evs))
	}
	// Another key does not fit.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(a, "other_key", 1) }))
	h.sim.Step()
	if evs := h.send(clA, useGate(worldtest.Door)); !hasKey(evs, "door.locked") {
		t.Fatalf("use with the wrong key: %v", systemKeys(evs))
	}
	// A stale view (the open id on a shut gate) is no door use.
	if evs := h.send(clA, useGate(worldtest.OpenDoor)); hasKey(evs, "door.locked") || tileOf(evs, gate) != nil {
		t.Fatalf("stale use: %v", systemKeys(evs))
	}

	// With the key in the backpack the gate opens: every client that sees it hears.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(a, "gate_key", 1) }))
	h.sim.Step()
	clB.take()
	evs := h.send(clA, useGate(worldtest.Door))
	if !hasKey(evs, "door.unlocked") {
		t.Fatalf("use with key: %v", systemKeys(evs))
	}
	if got := tileOf(evs, gate); len(got) != 2 || got[1] != worldtest.OpenDoor {
		t.Fatalf("gate tile after opening: %v", got)
	}
	if got := tileOf(clB.take(), gate); len(got) != 2 || got[1] != worldtest.OpenDoor {
		t.Fatalf("the other player saw %v", got)
	}
	if h.w.CountItem(a, "gate_key") != 1 || !h.w.Walkable(gate) || !h.w.LineOfSight(pos(2, 2), pos(6, 2)) {
		t.Fatal("the key was spent or the gate still blocks")
	}

	// Anyone walks through an open gate.
	h.input(clB, walkPath(W, sw, W))
	h.sim.RunFor(4 * time.Second)
	if b.Pos() != pos(3, 2) {
		t.Fatalf("tagalong at %v, want through the gate", b.Pos())
	}
	clB.take()
	// Without the key it does not lock again.
	if evs := h.send(clB, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.no_key") || !h.w.Walkable(gate) {
		t.Fatalf("close without key: %v", systemKeys(evs))
	}
	// Not on a creature, nor on an item.
	h.input(clA, walk(W))
	h.sim.RunFor(2 * time.Second)
	if a.Pos() != gate {
		t.Fatalf("keyholder at %v, want in the gate", a.Pos())
	}
	if evs := h.send(clB, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.blocked") {
		t.Fatalf("close on a creature: %v", systemKeys(evs))
	}
	h.input(clA, walk(E))
	h.sim.RunFor(2 * time.Second)
	h.sim.Command(gameFunc(func() { h.w.DropForTest(h.w.ItemForTest("test_sword"), 1, gate) }))
	h.sim.Step()
	clA.take()
	if evs := h.send(clA, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.blocked") {
		t.Fatalf("close on an item: %v", systemKeys(evs))
	}
	h.input(clA, moveItem(onTile(gate), swordID, 2, onTile(pos(5, 1)), 1))
	h.sim.Step()
	clA.take()
	// The tagalong has no key and stands in the room behind the gate: locking it would
	// shut it in.
	if evs := h.send(clA, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.shut_in") || !h.w.Walkable(gate) {
		t.Fatalf("lock with the tagalong inside: %v", systemKeys(evs))
	}
	// Out in the hall it does not count: the gate locks with the key.
	h.input(clB, walkPath(E, NE))
	h.sim.RunFor(4 * time.Second)
	if b.Pos() != pos(5, 1) {
		t.Fatalf("tagalong at %v, want out in the hall", b.Pos())
	}
	clB.take()
	evs = h.send(clA, useGate(worldtest.OpenDoor))
	if !hasKey(evs, "door.relocked") || h.w.Walkable(gate) || h.w.LineOfSight(pos(2, 2), pos(6, 2)) {
		t.Fatalf("lock again: %v", systemKeys(evs))
	}
	if got := tileOf(evs, gate); len(got) != 2 || got[1] != worldtest.Door {
		t.Fatalf("gate tile after locking: %v", got)
	}
	// Locked, the gate does not open for the tagalong.
	if evs := h.send(clB, useGate(worldtest.Door)); !hasKey(evs, "door.locked") {
		t.Fatalf("tagalong opens: %v", systemKeys(evs))
	}

	// With a key of its own the tagalong goes in, may be locked in, and lets itself out.
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(b, "gate_key", 1) }))
	h.sim.Step()
	if evs := h.send(clB, useGate(worldtest.Door)); !hasKey(evs, "door.unlocked") {
		t.Fatalf("tagalong with a key: %v", systemKeys(evs))
	}
	h.input(clB, walkPath(sw, W))
	h.sim.RunFor(4 * time.Second)
	if b.Pos() != pos(3, 2) {
		t.Fatalf("tagalong at %v, want in the room", b.Pos())
	}
	clA.take()
	if evs := h.send(clA, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.relocked") {
		t.Fatalf("lock with a keyholder inside: %v", systemKeys(evs))
	}
	clB.take()
	if evs := h.send(clB, useGate(worldtest.Door)); !hasKey(evs, "door.unlocked") || !h.w.Walkable(gate) {
		t.Fatalf("open from inside: %v", systemKeys(evs))
	}
}

// field is a w x h grass field with a wall along row wy from x0 to x1 and the gate at
// (gx, wy) in it.
func field(t testing.TB, w, h, wy, x0, x1, gx int) *world.Map {
	rows := make([]string, h)
	for y := range rows {
		row := []byte(strings.Repeat(".", w))
		if y == wy {
			for x := x0; x <= x1; x++ {
				row[x] = '#'
			}
			row[gx] = 'D'
		}
		rows[y] = string(row)
	}
	return worldtest.Map(t, 0, 0, 7, rows...)
}

// Who would be shut in depends on what the gate keeps apart: a gate in the open, or
// between two sides too big to walk, shuts nobody in; behind a wall across a field, the
// smaller side is the room.
func TestLockShutsNobodyIn(t *testing.T) {
	for _, c := range []struct {
		name       string
		w, h, wy   int
		x0, x1, gx int
		keyless    world.Pos
		wantLock   bool
	}{
		{"in the open", 9, 9, 4, 3, 5, 4, pos(4, 7), true},
		{"short wall in a big field", 70, 70, 35, 33, 37, 35, pos(35, 40), true},
		{"two halves too big to walk", 70, 130, 65, 0, 69, 35, pos(35, 70), true},
		{"strip behind a wall", 70, 70, 66, 0, 69, 35, pos(35, 68), false},
		{"field before a wall", 70, 70, 66, 0, 69, 35, pos(35, 60), true},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := field(t, c.w, c.h, c.wy, c.x0, c.x1, c.gx)
			h := newHarness(t, m, func(cfg *session.Config) { cfg.Items = doorTestItems(true) })
			g := pos(c.gx, c.wy)
			holder := withPack(9201, pos(c.gx, c.wy-1))
			holder.Name = "Keyholder"
			clA, a := h.joinChar(holder)
			keyless := c.keyless
			h.join("Keyless", &keyless)
			h.sim.Command(gameFunc(func() { h.w.GiveForTest(a, "gate_key", 1) }))
			h.sim.Step()
			clA.take()
			if evs := h.send(clA, useItem(onTile(g), worldtest.Door, 1)); !hasKey(evs, "door.unlocked") {
				t.Fatalf("open: %v", systemKeys(evs))
			}
			h.sim.RunFor(time.Second)
			if h.w.InDoorRoom(g, keyless) == c.wantLock {
				t.Fatalf("%v in the room behind the gate: %v", keyless, !c.wantLock)
			}
			evs := h.send(clA, useItem(onTile(g), worldtest.OpenDoor, 1))
			if hasKey(evs, "door.relocked") != c.wantLock || hasKey(evs, "door.shut_in") == c.wantLock {
				t.Fatalf("lock: %v, want locked %v", systemKeys(evs), c.wantLock)
			}
		})
	}
}

// A door with no lock opens and closes for anyone, without messages, and has no room. A
// player opens or closes a door at most once every half second; others may meanwhile.
func TestPlainDoor(t *testing.T) {
	h := newHarness(t, doorMap(t), func(c *session.Config) { c.Items = doorTestItems(false) })
	cl, _ := h.join("Walker", at(3, 2))
	other, _ := h.join("Other", at(5, 2))
	h.sim.Step()
	cl.take()
	evs := h.send(cl, useGate(worldtest.Door))
	if len(systemKeys(evs)) != 0 || !h.w.Walkable(gate) {
		t.Fatalf("open: %v", systemKeys(evs))
	}
	if h.w.InDoorRoom(gate, pos(3, 2)) {
		t.Fatal("a plain door has a room")
	}
	evs = h.send(cl, useGate(worldtest.OpenDoor))
	if !hasKey(evs, "door.not_ready") || !h.w.Walkable(gate) {
		t.Fatalf("close right away: %v", systemKeys(evs))
	}
	other.take()
	if evs = h.send(other, useGate(worldtest.OpenDoor)); len(systemKeys(evs)) != 0 || h.w.Walkable(gate) {
		t.Fatalf("another player closes: %v", systemKeys(evs))
	}
	h.sim.RunFor(500 * time.Millisecond)
	cl.take()
	evs = h.send(cl, useGate(worldtest.Door))
	if len(systemKeys(evs)) != 0 || !h.w.Walkable(gate) {
		t.Fatalf("open again: %v", systemKeys(evs))
	}
}

// A content error in the doors stops the world from starting.
func TestDoorContentChecked(t *testing.T) {
	items := doorTestItems(true)
	delete(items, "gate_key")
	_, err := session.New(session.Config{Map: doorMap(t), Balance: testBalance(), Vocations: testVocations,
		Items: items, Save: func(session.Snapshot) bool { return true }})
	if err == nil {
		t.Fatal("a lock without a key was accepted")
	}
}

// Nobody is ever locked in (docs/02 "Puertas con llave"): from the room behind a locked
// gate a player without the key opens it, whatever brought it there with the gate locked.
// From the hall it stays locked.
func TestLockedDoorOpensFromInside(t *testing.T) {
	keyed := func(c *session.Config) { c.Items = doorTestItems(true) }
	if !doorRoomOf(t, keyed) {
		t.Fatal("the west room is not behind the gate")
	}

	t.Run("a restart", func(t *testing.T) {
		// A restart locks every door again: the character comes back where it logged out.
		h := newHarness(t, doorMap(t), keyed)
		cl, p := h.joinChar(withPack(9401, pos(2, 2)))
		h.input(cl, walk(E))
		h.sim.RunFor(2 * time.Second)
		cl.take()
		if p.Pos() != pos(3, 2) || h.w.Walkable(gate) {
			t.Fatalf("at %v next to a shut gate", p.Pos())
		}
		evs := h.send(cl, useGate(worldtest.Door))
		if !hasKey(evs, "door.unbarred") || !h.w.Walkable(gate) {
			t.Fatalf("open from inside without a key: %v", systemKeys(evs))
		}
		if got := tileOf(evs, gate); len(got) != 2 || got[1] != worldtest.OpenDoor {
			t.Fatalf("gate tile after opening: %v", got)
		}
		h.input(cl, walkPath(E, E))
		h.sim.RunFor(3 * time.Second)
		if p.Pos() != pos(5, 2) {
			t.Fatalf("at %v, want out in the hall", p.Pos())
		}
	})

	t.Run("a relog", func(t *testing.T) {
		// A player without the key logs out in the room: it no longer keeps the gate from
		// locking, and when it logs in again it lets itself out.
		h := newHarness(t, doorMap(t), keyed)
		clA, a := h.joinChar(withPack(9411, pos(5, 2)))
		stray := withPack(9412, pos(3, 1))
		stray.Name = "Stray"
		clB, _ := h.joinChar(stray)
		h.sim.Command(gameFunc(func() { h.w.GiveForTest(a, "gate_key", 1) }))
		h.sim.Step()
		clA.take()
		if evs := h.send(clA, useGate(worldtest.Door)); !hasKey(evs, "door.unlocked") {
			t.Fatalf("open: %v", systemKeys(evs))
		}
		h.sim.RunFor(time.Second)
		clA.take()
		if evs := h.send(clA, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.shut_in") {
			t.Fatalf("lock with the stray inside: %v", systemKeys(evs))
		}
		h.sim.Command(h.w.Leave(clB))
		h.sim.Step()
		clA.take()
		if evs := h.send(clA, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.relocked") || h.w.Walkable(gate) {
			t.Fatalf("lock with the stray logged out: %v", systemKeys(evs))
		}
		var last session.Snapshot
		for _, sn := range h.saves {
			if sn.CharacterID == stray.ID {
				last = sn
			}
		}
		if !last.Final || last.Pos != pos(3, 1) {
			t.Fatalf("the stray's last snapshot: %+v", last)
		}
		stray.Pos, stray.HasPos = last.Pos, true
		clB, b := h.joinChar(stray)
		clB.take()
		if b.Pos() != pos(3, 1) {
			t.Fatalf("the stray logs in at %v", b.Pos())
		}
		if evs := h.send(clB, useGate(worldtest.Door)); !hasKey(evs, "door.unbarred") || !h.w.Walkable(gate) {
			t.Fatalf("the stray opens from inside: %v", systemKeys(evs))
		}
	})

	t.Run("a key lost inside", func(t *testing.T) {
		// The keyholder locks itself in and loses the key: it still gets out.
		h := newHarness(t, doorMap(t), keyed)
		cl, p := h.joinChar(withPack(9421, pos(3, 2)))
		h.sim.Command(gameFunc(func() { h.w.GiveForTest(p, "gate_key", 1) }))
		h.sim.Step()
		cl.take()
		if evs := h.send(cl, useGate(worldtest.Door)); !hasKey(evs, "door.unlocked") {
			t.Fatalf("open: %v", systemKeys(evs))
		}
		h.sim.RunFor(time.Second)
		cl.take()
		if evs := h.send(cl, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.relocked") {
			t.Fatalf("lock from inside with the key: %v", systemKeys(evs))
		}
		h.sim.Command(gameFunc(func() { h.w.TakeForTest(p, "gate_key", 1) }))
		h.sim.RunFor(time.Second)
		cl.take()
		if evs := h.send(cl, useGate(worldtest.Door)); !hasKey(evs, "door.unbarred") || h.w.CountItem(p, "gate_key") != 0 {
			t.Fatalf("open from inside without the key: %v", systemKeys(evs))
		}
	})
}

// doorRoomOf reports whether the west room of doorMap is behind its gate and the hall
// is not.
func doorRoomOf(t *testing.T, opt option) bool {
	h := newHarness(t, doorMap(t), opt)
	for _, p := range []world.Pos{pos(1, 1), pos(3, 3), pos(3, 2)} {
		if !h.w.InDoorRoom(gate, p) {
			return false
		}
	}
	return !h.w.InDoorRoom(gate, pos(5, 2)) && !h.w.InDoorRoom(gate, pos(9, 3)) && !h.w.InDoorRoom(gate, gate)
}

// A UseItem on a door of another floor, or out of view, is no door use: it goes on to
// the other uses of map items and leaves the door as it was.
func TestDoorUseElsewhere(t *testing.T) {
	rows := []string{
		"###########",
		"#...#.....#",
		"#...D.....#",
		"#...#.....#",
		"###########",
	}
	m := worldtest.Floors(t, 0, 0, worldtest.Layer{Z: 6, Rows: rows}, worldtest.Layer{Z: 7, Rows: rows})
	h := newHarness(t, m, func(c *session.Config) { c.Items = doorTestItems(false) })
	cl, _ := h.join("Below", at(3, 2))
	h.sim.Step()
	cl.take()
	above := world.Pos{X: gate.X, Y: gate.Y, Z: 6}
	evs := h.send(cl, useItem(onTile(above), worldtest.Door, 1))
	if doorKeys(evs) || tileOf(evs, gate) != nil || h.w.Walkable(above) || h.w.Walkable(gate) {
		t.Fatalf("use of the door above: %v", systemKeys(evs))
	}

	far := field(t, 70, 70, 66, 0, 69, 35)
	h = newHarness(t, far, func(c *session.Config) { c.Items = doorTestItems(false) })
	cl, _ = h.join("Faraway", at(35, 50))
	h.sim.Step()
	cl.take()
	g := pos(35, 66)
	evs = h.send(cl, useItem(onTile(g), worldtest.Door, 1))
	if doorKeys(evs) || h.w.Walkable(g) {
		t.Fatalf("use of a door out of view: %v", systemKeys(evs))
	}
}

// doorKeys reports whether evs hold a door message.
func doorKeys(evs []*pb.ServerMessage) bool {
	for k := range systemKeys(evs) {
		if strings.HasPrefix(k, "door.") {
			return true
		}
	}
	return false
}

// An open door does not close on a monster, nor on the remains it leaves.
func TestDoorBlockedByMonster(t *testing.T) {
	m := worldtest.Map(t, 0, 0, 7,
		"###########",
		"#...#.....#",
		"#...d.....#",
		"#...#.....#",
		"###########",
	)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("dummy", 4, 2, 0, 600)}
	h := newHarness(t, m, func(c *session.Config) {
		c.Items = doorTestItems(false)
		c.Monsters = content.Monsters{"dummy": dummyDef()}
	})
	cl, _ := h.join("Closer", at(5, 2))
	h.sim.Step()
	dummy := h.dummy()
	if dummy.Pos() != gate {
		t.Fatalf("dummy at %v, want in the open gate", dummy.Pos())
	}
	cl.take()
	if evs := h.send(cl, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.blocked") || !h.w.Walkable(gate) {
		t.Fatalf("close on a monster: %v", systemKeys(evs))
	}
	h.sim.Command(gameFunc(func() { dummy.SetHealth(1) }))
	h.input(cl, setTarget(dummy.ID()))
	h.sim.RunUntil(func() bool { return len(h.w.Monsters()) == 0 }, sim.MaxSeconds(60))
	if len(h.w.GroundAt(gate)) == 0 {
		t.Fatal("the dummy left no remains in the gate")
	}
	cl.take()
	if evs := h.send(cl, useGate(worldtest.OpenDoor)); !hasKey(evs, "door.blocked") || !h.w.Walkable(gate) {
		t.Fatalf("close on remains: %v", systemKeys(evs))
	}
}

// A door item on a door tile of a house would take the use that opens the house window:
// the world refuses to start (map-format refuses it first, in make validate).
func TestDoorOnHouseDoorRefused(t *testing.T) {
	house := world.House{ID: "test_house", Name: "house.test_house.name", Rent: 100,
		Rects: []world.HouseRect{{X: 1, Y: 1, Z: 7, W: 4, H: 3}}, Doors: []world.Pos{gate}, Exit: pos(5, 2)}
	m := worldtest.WithHouses(t, doorMap(t), house)
	_, err := session.New(session.Config{Map: m, Balance: testBalance(), Vocations: testVocations,
		Items: doorTestItems(false), Save: func(session.Snapshot) bool { return true }})
	if err == nil || !strings.Contains(err.Error(), "test_house") {
		t.Fatalf("a door on a house door: %v", err)
	}
}
