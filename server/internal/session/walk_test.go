package session_test

import (
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

func moves(evs []*pb.ServerMessage) []*pb.CreatureMove {
	return find(evs, (*pb.ServerMessage).GetCreatureMove)
}

func TestJoinSendsWelcomeAndFullView(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 100, 100, 7,
		"......",
		"..T#..",
		"......",
	))
	_, other := h.join("Ana", at(104, 100))
	cl, p := h.join("Mira", nil)
	if p.Pos() != pos(102, 101) {
		t.Fatalf("placed at %v, want the temple", p.Pos())
	}
	evs := cl.take()
	want := []string{"welcome", "full_map_view", "player_stats", "inventory", "player_skills"}
	if got := kinds(evs); len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[4] != want[4] {
		t.Fatalf("join events %v, want %v", got, want)
	}
	if evs[0].GetWelcome().GetCreatureId() != p.ID() || evs[0].GetWelcome().GetTickMs() != 50 {
		t.Fatalf("welcome %v", evs[0])
	}
	area := evs[1].GetFullMapView().GetArea()
	if area.GetX() != 102-8 || area.GetY() != 101-6 || area.GetWidth() != 17 || area.GetHeight() != 13 {
		t.Fatalf("area %d,%d %dx%d", area.GetX(), area.GetY(), area.GetWidth(), area.GetHeight())
	}
	if len(area.GetFloors()) != 1 || area.GetFloors()[0].GetZ() != 7 || len(area.GetFloors()[0].GetTiles()) != 17*13 {
		t.Fatalf("floors %v", area.GetFloors())
	}
	// The wall east of the temple: grass with the wall item on top.
	tiles := area.GetFloors()[0].GetTiles()
	wall := area.GetPalette()[tiles[6*17+9]]
	if len(wall.GetItems()) != 2 || wall.GetItems()[0].GetItemId() != worldtest.Grass || wall.GetItems()[1].GetItemId() != worldtest.Wall {
		t.Fatalf("wall tile %v", wall)
	}
	if tiles[0] != -1 {
		t.Fatal("tiles outside the drawing must be -1")
	}
	if len(area.GetCreatures()) != 2 {
		t.Fatalf("creatures %v, want self and Ana", area.GetCreatures())
	}
	st := evs[2].GetPlayerStats()
	if st.GetHealth() != 145 || st.GetMaxHealth() != 145 || st.GetSpeed() != 200 || st.GetLevel() != 1 {
		t.Fatalf("stats %v", st)
	}
	if sk := evs[4].GetPlayerSkills().GetSkills(); len(sk) != 3 || sk[0].GetSkillId() != "fist" || sk[0].GetLevel() != 10 {
		t.Fatalf("skills %v", sk)
	}
	if !other.Knows(p.ID()) {
		t.Fatal("Ana does not know Mira")
	}
	h.checkInvariants()
}

func TestWalkSpeedIsServerPaced(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 16))
	cl, p := h.join("Mira", at(1, 8))
	cl.take()
	// 10 s of a client asking for a step every tick (a speed hack): speed 200 on 100 %
	// terrain is 1000*100/200 = 500 ms = 10 ticks per step, so 20 steps.
	for range 200 {
		h.input(cl, walk(E))
		h.sim.Step()
	}
	ms := moves(cl.take())
	if len(ms) != 20 || p.Pos() != pos(21, 8) {
		t.Fatalf("%d steps, at %v; want 20 steps to 21,8", len(ms), p.Pos())
	}
	for _, m := range ms {
		if m.GetDurationMs() != 500 || m.GetId() != p.ID() {
			t.Fatalf("move %v", m)
		}
	}
	if p.Dir() != world.East {
		t.Fatalf("dir %v", p.Dir())
	}
}

func TestStepDuration(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, "...m="))
	cases := []struct {
		ground uint16
		diag   bool
		speed  int
		ticks  int
	}{
		{worldtest.Grass, false, 200, 10}, // 500 ms
		{worldtest.Grass, true, 200, 15},  // 750 ms
		{worldtest.Mud, false, 200, 20},   // 1000 ms
		{worldtest.Road, false, 200, 5},   // 250 ms
		{worldtest.Grass, false, 205, 10}, // 487.8 ms, rounded up to 500
		{worldtest.Grass, true, 205, 15},  // 731.7 ms → 750
		{worldtest.Grass, false, 30000, 1},
	}
	for _, c := range cases {
		if got := h.w.StepTicks(c.ground, c.speed, c.diag); int(got) != c.ticks {
			t.Errorf("StepTicks(%d, %d, %v) = %d, want %d", c.ground, c.speed, c.diag, got, c.ticks)
		}
	}
}

func TestDiagonalAndTerrain(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7,
		".....",
		".mmm.",
		".....",
	))
	cl, p := h.join("Mira", at(0, 0))
	cl.take()
	h.input(cl, walkPath(SE, E, E))
	h.sim.RunTicks(80)
	ms := moves(cl.take())
	if len(ms) != 3 || p.Pos() != pos(3, 1) {
		t.Fatalf("moves %v, at %v", ms, p.Pos())
	}
	// Diagonal onto mud: 1000*200/200*1.5 = 1500 ms; then two straight steps on mud.
	if ms[0].GetDurationMs() != 1500 || ms[1].GetDurationMs() != 1000 || ms[2].GetDurationMs() != 1000 {
		t.Fatalf("durations %d %d %d", ms[0].GetDurationMs(), ms[1].GetDurationMs(), ms[2].GetDurationMs())
	}
}

func TestWalkRejected(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7,
		"..#",
		"..~",
		"...",
	))
	cl, p := h.join("Mira", at(1, 0))
	cl.take()
	h.input(cl, walk(E)) // wall
	h.sim.Step()
	evs := cl.take()
	rej := find(evs, (*pb.ServerMessage).GetWalkRejected)
	if len(rej) != 1 || rej[0].GetPos().GetX() != 1 || rej[0].GetDir() != E || p.Pos() != pos(1, 0) {
		t.Fatalf("events %v, at %v", kinds(evs), p.Pos())
	}
	h.input(cl, walk(N)) // no tile (outside the drawing)
	h.sim.Step()
	if len(find(cl.take(), (*pb.ServerMessage).GetWalkRejected)) != 1 {
		t.Fatal("walking off the map was not rejected")
	}
	// A path into water stops at the water: the first step happens, then a rejection.
	h.input(cl, walkPath(S, E))
	h.sim.RunTicks(30)
	evs = cl.take()
	if len(moves(evs)) != 1 || len(find(evs, (*pb.ServerMessage).GetWalkRejected)) != 1 || p.Pos() != pos(1, 1) || p.Walking() {
		t.Fatalf("events %v, at %v", kinds(evs), p.Pos())
	}
	// Malformed input is ignored: unspecified direction, invalid enum value.
	h.input(cl, walk(pb.Direction_DIRECTION_UNSPECIFIED))
	h.input(cl, walk(pb.Direction(42)))
	h.sim.RunTicks(20)
	if evs := cl.take(); len(evs) != 0 || p.Pos() != pos(1, 1) {
		t.Fatalf("malformed walk produced %v", kinds(evs))
	}
}

func TestWalkPathLimitsAndStop(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 128, 8))
	cl, p := h.join("Mira", at(0, 4))
	cl.take()

	long := make([]pb.Direction, 101)
	for i := range long {
		long[i] = E
	}
	h.input(cl, walkPath(long...))
	h.sim.RunTicks(20)
	evs := cl.take()
	if rej := find(evs, (*pb.ServerMessage).GetWalkRejected); len(moves(evs)) != 0 || len(rej) != 1 || rej[0].GetDir() != pb.Direction_DIRECTION_UNSPECIFIED {
		t.Fatalf("101-step path: %v", kinds(evs))
	}
	h.input(cl, walkPath(E, E, pb.Direction(99)))
	h.sim.RunTicks(20)
	if evs := cl.take(); len(moves(evs)) != 0 {
		t.Fatalf("path with an invalid step moved: %v", kinds(evs))
	}

	h.input(cl, walkPath(long[:100]...))
	h.sim.RunTicks(25) // steps start at ticks 1, 11, 21
	h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_StopWalk{StopWalk: &pb.StopWalk{}}})
	h.sim.RunTicks(40)
	if p.Pos() != pos(3, 4) || p.Walking() {
		t.Fatalf("after StopWalk at %v walking=%v", p.Pos(), p.Walking())
	}
	// A new Walk replaces a path.
	h.input(cl, walkPath(long[:100]...))
	h.input(cl, walk(S))
	h.sim.RunTicks(40)
	if p.Pos() != pos(3, 5) {
		t.Fatalf("walk after path: at %v", p.Pos())
	}
}

func TestTurnAndPing(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	a, pa := h.join("Ana", at(10, 10))
	b, _ := h.join("Bob", at(12, 10))
	a.take()
	b.take()
	h.input(a, &pb.ClientMessage{Message: &pb.ClientMessage_Turn{Turn: &pb.Turn{Dir: W}}})
	h.input(a, &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: 1234}}})
	h.sim.Step()
	ae, be := a.take(), b.take()
	if got := kinds(ae); len(got) != 2 || got[0] != "creature_turn" || got[1] != "pong" {
		t.Fatalf("Ana got %v", got)
	}
	if ae[1].GetPong().GetClientTime() != 1234 || ae[1].GetPong().GetServerTime() == 0 {
		t.Fatalf("pong %v", ae[1])
	}
	if len(be) != 1 || be[0].GetCreatureTurn().GetId() != pa.ID() || be[0].GetCreatureTurn().GetDir() != W {
		t.Fatalf("Bob got %v", kinds(be))
	}
	// Turning to the same direction says nothing.
	h.input(a, &pb.ClientMessage{Message: &pb.ClientMessage_Turn{Turn: &pb.Turn{Dir: W}}})
	h.sim.Step()
	if len(a.take())+len(b.take()) != 0 {
		t.Fatal("a no-op turn was broadcast")
	}
}

func TestOneBatchPerTick(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	a, _ := h.join("Ana", at(10, 10))
	a.take()
	for range 5 {
		h.input(a, &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{}}})
	}
	h.input(a, walk(E))
	h.sim.Step()
	if len(a.batches) != 1 || len(a.batches[0].GetEvents()) < 6 || a.batches[0].GetTick() != uint64(h.sim.Tick()) {
		t.Fatalf("batches %v", a.batches)
	}
	a.take()
	h.sim.RunTicks(5)
	if len(a.batches) != 0 {
		t.Fatal("an idle tick sent a frame")
	}
}
