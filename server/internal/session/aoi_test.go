package session_test

import (
	"bytes"
	"testing"

	"google.golang.org/protobuf/proto"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// The window is 31x21 plus a margin of one tile: 16 tiles to each side, 11 up and down.
func TestSeesIsTheViewPlusMargin(t *testing.T) {
	c := world.Pos{X: 100, Y: 100, Z: 7}
	for _, q := range []world.Pos{{X: 84, Y: 89, Z: 7}, {X: 116, Y: 111, Z: 7}, {X: 115, Y: 100, Z: 7}, {X: 100, Y: 100, Z: 3}} {
		if !session.Sees(c, q) {
			t.Errorf("does not see %v", q)
		}
	}
	for _, q := range []world.Pos{{X: 83, Y: 100, Z: 7}, {X: 117, Y: 100, Z: 7}, {X: 100, Y: 88, Z: 7}, {X: 100, Y: 112, Z: 7}, {X: 100, Y: 100, Z: 8}} {
		if session.Sees(c, q) {
			t.Errorf("sees %v", q)
		}
	}
	under := world.Pos{X: 100, Y: 100, Z: 9}
	if session.Sees(under, world.Pos{X: 100, Y: 100, Z: 8}) || !session.Sees(under, world.Pos{X: 101, Y: 100, Z: 9}) {
		t.Error("underground sees only its floor")
	}
}

// A monster's sight is the classic 15x11 window plus its margin, on its own floor only.
func TestInSightIsTheClassicWindow(t *testing.T) {
	c := world.Pos{X: 100, Y: 100, Z: 7}
	for _, q := range []world.Pos{{X: 92, Y: 94, Z: 7}, {X: 108, Y: 106, Z: 7}} {
		if !session.InSight(c, q) || !session.InSight(q, c) {
			t.Errorf("not in sight: %v", q)
		}
	}
	for _, q := range []world.Pos{{X: 91, Y: 100, Z: 7}, {X: 109, Y: 100, Z: 7}, {X: 100, Y: 93, Z: 7}, {X: 100, Y: 107, Z: 7},
		{X: 100, Y: 100, Z: 6}, {X: 115, Y: 100, Z: 7}} {
		if session.InSight(c, q) {
			t.Errorf("in sight: %v", q)
		}
	}
}

func TestAOIEnterAndLeave(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 96, 48))
	a, pa := h.join("Ana", at(10, 20))
	b, pb2 := h.join("Bob", at(24, 20)) // 14 tiles east: in view
	a.take()
	b.take()

	// Bob walks east: at x=26 he is still in Ana's area (dx 16, the margin), at 27 he leaves.
	h.input(b, walkPath(E, E, E))
	h.sim.RunTicks(30)
	ae := a.take()
	if got := kinds(ae); len(got) != 3 || got[0] != "creature_move" || got[1] != "creature_move" || got[2] != "creature_disappear" {
		t.Fatalf("Ana got %v", got)
	}
	if ae[2].GetCreatureDisappear().GetId() != pb2.ID() || pa.Knows(pb2.ID()) {
		t.Fatal("Bob still known")
	}
	be := b.take()
	if d := find(be, (*pb.ServerMessage).GetCreatureDisappear); len(d) != 1 || d[0].GetId() != pa.ID() {
		t.Fatalf("Bob got %v", kinds(be))
	}
	// Every step east brings a new column of 23 tiles at x+16.
	slices := find(be, (*pb.ServerMessage).GetMapSlice)
	if len(slices) != 3 {
		t.Fatalf("%d slices", len(slices))
	}
	for i, s := range slices {
		a := s.GetArea()
		if a.GetX() != uint32(25+i+16) || a.GetY() != 9 || a.GetWidth() != 1 || a.GetHeight() != 23 {
			t.Fatalf("slice %d: %d,%d %dx%d", i, a.GetX(), a.GetY(), a.GetWidth(), a.GetHeight())
		}
	}
	h.checkInvariants()

	// Ana walks one step east: Bob enters her view through the new column.
	h.input(a, walk(E))
	h.sim.RunTicks(10)
	ae = a.take()
	sl := find(ae, (*pb.ServerMessage).GetMapSlice)
	if len(sl) != 1 || len(sl[0].GetArea().GetCreatures()) != 1 || sl[0].GetArea().GetCreatures()[0].GetId() != pb2.ID() {
		t.Fatalf("Ana's slice %v", sl)
	}
	be = b.take()
	if ap := find(be, (*pb.ServerMessage).GetCreatureAppear); len(ap) != 1 || ap[0].GetCreature().GetName() != "Ana" {
		t.Fatalf("Bob got %v", kinds(be))
	}
	h.checkInvariants()
}

func TestDiagonalSlices(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 64))
	a, _ := h.join("Ana", at(20, 20))
	a.take()
	h.input(a, walk(SE))
	h.sim.RunTicks(15)
	sl := find(a.take(), (*pb.ServerMessage).GetMapSlice)
	if len(sl) != 2 {
		t.Fatalf("%d slices", len(sl))
	}
	col, row := sl[0].GetArea(), sl[1].GetArea()
	// At 21,21: new column x=37 (y 10..32) and new row y=32 (x 5..36, corner excluded).
	if col.GetX() != 37 || col.GetY() != 10 || col.GetWidth() != 1 || col.GetHeight() != 23 {
		t.Fatalf("column %v", col)
	}
	if row.GetX() != 5 || row.GetY() != 32 || row.GetWidth() != 32 || row.GetHeight() != 1 {
		t.Fatalf("row %v", row)
	}
}

func TestAreaClippedAtWorldEdge(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	a, _ := h.join("Ana", at(2, 1))
	area := a.take()[1].GetFullMapView().GetArea()
	if area.GetX() != 0 || area.GetY() != 0 || area.GetWidth() != 19 || area.GetHeight() != 13 {
		t.Fatalf("area %d,%d %dx%d", area.GetX(), area.GetY(), area.GetWidth(), area.GetHeight())
	}
	if len(area.GetFloors()[0].GetTiles()) != 19*13 {
		t.Fatal("tiles do not match the clipped size")
	}
}

func TestTeleportSendsFullView(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 32))
	a, pa := h.join("Ana", at(5, 5))
	b, pbob := h.join("Bob", at(7, 5))
	c, _ := h.join("Cy", at(50, 20))
	a.take()
	b.take()
	c.take()
	h.sim.Command(gameFunc(func() { h.w.Teleport(pa, pos(52, 20)) }))
	h.sim.Step()
	ae := a.take()
	if got := kinds(ae); got[0] != "creature_disappear" || got[1] != "full_map_view" {
		t.Fatalf("Ana got %v", got)
	}
	if len(ae[1].GetFullMapView().GetArea().GetCreatures()) != 2 {
		t.Fatal("full view must hold Ana and Cy")
	}
	if d := find(b.take(), (*pb.ServerMessage).GetCreatureDisappear); len(d) != 1 {
		t.Fatal("Bob did not see Ana vanish")
	}
	if ap := find(c.take(), (*pb.ServerMessage).GetCreatureAppear); len(ap) != 1 {
		t.Fatal("Cy did not see Ana appear")
	}
	_ = pbob
	h.checkInvariants()
}

// TestRandomWalkInvariants drives many players with random inputs and checks after
// every tick that each client knows exactly what it sees and nobody shares a tile.
func TestRandomWalkInvariants(t *testing.T) {
	run := func() []byte {
		nextChar = 0
		h := newHarness(t, worldtest.Map(t, 0, 0, 7,
			"........................................",
			"....#####...........~~~~................",
			"....#...#...........~~~~.......mmmm.....",
			"........#......................mmmm.....",
			"....#####...............................",
			"........................................",
			"..............==============............",
			"........................................",
			"........................................",
			"........................................",
			"........................................",
			"........................................",
		))
		var cls []*fakeClient
		for i := range 12 {
			cl, _ := h.join("P", at(i*3, (i*5)%12))
			cls = append(cls, cl)
		}
		var trace bytes.Buffer
		r := h.sim.Rand()
		for range 1500 {
			for _, cl := range cls {
				switch r.IntN(12) {
				case 0, 1, 2:
					h.input(cl, walk(pb.Direction(1+r.IntN(8))))
				case 3:
					steps := make([]pb.Direction, 1+r.IntN(15))
					for i := range steps {
						steps[i] = pb.Direction(1 + r.IntN(8))
					}
					h.input(cl, walkPath(steps...))
				case 4:
					h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_StopWalk{StopWalk: &pb.StopWalk{}}})
				}
			}
			h.sim.Step()
			h.checkInvariants()
			for _, cl := range cls {
				for _, b := range cl.batches {
					raw, _ := proto.MarshalOptions{Deterministic: true}.Marshal(b)
					trace.Write(raw)
				}
				cl.batches = nil
			}
		}
		return trace.Bytes()
	}
	first, second := run(), run()
	if !bytes.Equal(first, second) {
		t.Fatal("same seed and inputs produced different events")
	}
	if len(first) == 0 {
		t.Fatal("no events")
	}
}
