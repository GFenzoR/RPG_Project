package session_test

import (
	"math"
	"slices"
	"strconv"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
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
	// The quest log comes too, empty for a character with no quest (questlog.go).
	// And the minimap's explored sectors (minimap.go).
	want := []string{"welcome", "full_map_view", "player_stats", "inventory", "player_skills", "minimap_index", "quest_log"}
	if got := kinds(evs); len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[4] != want[4] || got[5] != want[5] || got[6] != want[6] {
		t.Fatalf("join events %v, want %v", got, want)
	}
	if wl := evs[0].GetWelcome(); wl.GetCreatureId() != p.ID() || wl.GetTickMs() != 50 || wl.GetViewWidth() != 31 || wl.GetViewHeight() != 21 {
		t.Fatalf("welcome %v", evs[0])
	}
	area := evs[1].GetFullMapView().GetArea()
	if area.GetX() != 102-16 || area.GetY() != 101-11 || area.GetWidth() != 33 || area.GetHeight() != 23 {
		t.Fatalf("area %d,%d %dx%d", area.GetX(), area.GetY(), area.GetWidth(), area.GetHeight())
	}
	if len(area.GetFloors()) != 1 || area.GetFloors()[0].GetZ() != 7 || len(area.GetFloors()[0].GetTiles()) != 33*23 {
		t.Fatalf("floors %v", area.GetFloors())
	}
	// The wall east of the temple: grass with the wall item on top.
	tiles := area.GetFloors()[0].GetTiles()
	wall := area.GetPalette()[tiles[11*33+17]]
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
	// 10 s of a client asking for a step every tick (a speed hack), following every
	// walk epoch the server starts: speed 200 on 100 % terrain is 1000*100/200 = 500 ms =
	// 10 ticks per step, so 20 steps at most. Its queue overflows max_queued_steps over
	// and over, and every overflow resets the walk (docs/05 "Caminar").
	epoch := uint32(1)
	var ms []*pb.CreatureMove
	var last uint64
	rejected := 0
	for range 200 {
		h.input(cl, walkIn(E, epoch))
		h.sim.Step()
		for _, b := range cl.batches {
			for _, e := range b.GetEvents() {
				if r := e.GetWalkRejected(); r != nil {
					epoch = r.GetWalkEpoch()
					rejected++
				}
				if m := e.GetCreatureMove(); m != nil {
					if len(ms) > 0 && b.GetTick()-last < 10 {
						t.Fatalf("a step at tick %d, %d ticks after the last", b.GetTick(), b.GetTick()-last)
					}
					ms, last = append(ms, m), b.GetTick()
				}
			}
		}
		cl.batches = nil
	}
	if len(ms) > 20 || len(ms) < 10 || p.Pos() != pos(1+len(ms), 8) || rejected == 0 {
		t.Fatalf("%d steps, %d resets, at %v", len(ms), rejected, p.Pos())
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
		ms     int64
	}{
		{worldtest.Grass, false, 200, 500},
		{worldtest.Grass, true, 200, 707}, // 500 × √2
		{worldtest.Mud, false, 200, 1000},
		{worldtest.Road, false, 200, 250},
		{worldtest.Grass, false, 205, 488}, // 487.8 ms: to the millisecond, not to the tick
		{worldtest.Grass, true, 205, 690},
		{worldtest.Road, true, 200, 354},
		{worldtest.Mud, true, 200, 1414},
		{worldtest.Grass, false, 30000, 50}, // never under one tick
		{worldtest.Grass, true, 30000, 71},
		{worldtest.Road, true, 1000, 71},
		{worldtest.Road, true, 999, 72}, // 51 ms straight
	}
	for _, c := range cases {
		if got := h.w.StepMs(c.ground, c.speed, c.diag); got != c.ms {
			t.Errorf("StepMs(%d, %d, %v) = %d, want %d", c.ground, c.speed, c.diag, got, c.ms)
		}
	}
}

// TestDiagonalSameSpeed: with diagonal_cost √2 a diagonal step covers its √2 tiles at the
// speed of a straight one (docs/02 "Movimiento"), to the millisecond, at every terrain
// and speed, and is never shorter than the straight step.
func TestDiagonalSameSpeed(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, "...m="))
	for _, ground := range []uint16{worldtest.Grass, worldtest.Mud, worldtest.Road} {
		for speed := 50; speed <= 3000; speed += 7 {
			straight := float64(h.w.StepMs(ground, speed, false))
			diag := float64(h.w.StepMs(ground, speed, true))
			if diag < straight || math.Abs(diag-straight*1.414) > 0.5 {
				t.Fatalf("ground %d speed %d: straight %v ms, diagonal %v, want %.2f ±0.5",
					ground, speed, straight, diag, straight*1.414)
			}
		}
	}
}

// ownerPace is the walk of a level 1 player of the repo's data (data/balance.yaml
// base_step_ms 891, data/vocations.yaml speed 205): 435 ms a tile, not a whole number of
// ticks.
func ownerPace(cfg *session.Config) {
	cfg.Balance.Movement.BaseStepMs = 891
	vs := content.Vocations{}
	for id, v := range cfg.Vocations {
		v.Start.Speed = 205
		vs[id] = v
	}
	cfg.Vocations = vs
}

// TestFourDirectionsOnePace: a walk north, east, south or west costs the same, step by
// step and tick by tick (owner, 2026-11-26: "up and down feels faster than sideways"; the
// server never told them apart, and this pins it). Each step is 435 ms for its client;
// the loop waits whole ticks and carries what is left to the next step, so ten tiles take
// 4350 ms, less than one tick short, not ten steps rounded up to 450 ms. A diagonal is
// 435 × √2 = 615 ms the same way.
func TestFourDirectionsOnePace(t *testing.T) {
	run := func(d pb.Direction, n int) (ticks []uint64, ms []uint32) {
		h := newHarness(t, worldtest.Open(t, 0, 0, 40, 40), ownerPace)
		cl, _ := h.join("Mira", at(20, 20))
		cl.take()
		cl.batches = nil
		steps := make([]pb.Direction, n)
		for i := range steps {
			steps[i] = d
		}
		h.input(cl, walkPath(steps...))
		var first uint64
		for range 200 {
			h.sim.Step()
			for _, b := range cl.batches {
				for _, e := range b.GetEvents() {
					if m := e.GetCreatureMove(); m != nil {
						if len(ticks) == 0 {
							first = b.GetTick()
						}
						ticks, ms = append(ticks, b.GetTick()-first), append(ms, m.GetDurationMs())
					}
				}
			}
			cl.batches = nil
		}
		return ticks, ms
	}
	const n = 10
	east, eastMs := run(E, n)
	if len(east) != n {
		t.Fatalf("%d steps east, want %d", len(east), n)
	}
	for i, at := range east {
		// Step i starts when the i before it are over: i × 435 ms, in whole ticks.
		if want := uint64(i * 435 / 50); at != want || eastMs[i] != 435 {
			t.Fatalf("east: step %d at tick %d for %d ms, want tick %d for 435 ms (%v)", i, at, eastMs[i], want, east)
		}
	}
	for _, c := range []struct {
		name string
		dir  pb.Direction
	}{{"north", N}, {"south", S}, {"west", W}} {
		ticks, ms := run(c.dir, n)
		if !slices.Equal(ticks, east) || !slices.Equal(ms, eastMs) {
			t.Errorf("%s: steps at ticks %v for %v ms, east at %v for %v", c.name, ticks, ms, east, eastMs)
		}
	}
	diag, diagMs := run(SE, n)
	if len(diag) != n {
		t.Fatalf("%d steps south-east, want %d", len(diag), n)
	}
	for i, at := range diag {
		if want := uint64(i * 615 / 50); at != want || diagMs[i] != 615 {
			t.Fatalf("south-east: step %d at tick %d for %d ms, want tick %d for 615 ms", i, at, diagMs[i], want)
		}
	}
}

// TestPaceOwesNoMoreThanATick: whatever a step lasts, a walk of n steps takes n times
// that, less than one tick short and never longer; a step after a stop owes nothing.
func TestPaceOwesNoMoreThanATick(t *testing.T) {
	for ms := int64(50); ms <= 1500; ms += 7 {
		var total int64
		for i, n := range session.PaceTicks(ms, 40) {
			if n < 1 {
				t.Fatalf("%d ms: step %d waits %d ticks", ms, i, n)
			}
			total += int64(n) * 50
			if want := int64(i+1) * ms; total > want || want-total >= 50 {
				t.Fatalf("%d ms: %d steps took %d ms, want %d less under a tick", ms, i+1, total, want)
			}
		}
	}
	// 435 ms: 8, 9, 9, 8, 9 ticks; after a stop, from 8 again.
	if got := session.PaceTicks(435, 5); !slices.Equal(got, []game.Tick{8, 9, 9, 8, 9}) {
		t.Errorf("435 ms: %v", got)
	}
	if a, b := session.PaceAfterStop(435); a != 8 || b != 8 {
		t.Errorf("435 ms after a stop: %d then %d ticks, want 8 and 8", a, b)
	}
}

// TestSpeedGrowsWithLevel: a player's speed is its vocation's with
// movement.speed_per_level_pct per level over the first (docs/02 "Movimiento"), from its
// first tick in the world and at every level it gains.
func TestSpeedGrowsWithLevel(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 16, 16), func(cfg *session.Config) {
		cfg.Balance.Movement.SpeedPerLevelPct = 0.2
	})
	speed := func(level int) uint32 {
		nextChar++
		cl, _ := h.joinChar(session.Character{ID: nextChar, AccountID: nextChar, Name: "L" + strconv.Itoa(level),
			Vocation: "guardian", Level: level, Health: 145, Mana: 20})
		st := find(cl.take(), (*pb.ServerMessage).GetPlayerStats)
		if len(st) == 0 {
			t.Fatalf("level %d: no stats", level)
		}
		return st[0].GetSpeed()
	}
	// The test vocation: 200 + 2 a level; then 0.2 % of that a level.
	if got := speed(1); got != 200 {
		t.Errorf("level 1: speed %d, want the vocation's 200", got)
	}
	if got := speed(2); got != 202 { // 202 × 1.002 = 202.4
		t.Errorf("level 2: speed %d, want 202", got)
	}
	if got := speed(51); got != 330 { // 300 × 1.1
		t.Errorf("level 51: speed %d, want 330", got)
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
	// Diagonal onto mud: 1000*200/200 = 1000 ms straight, × √2 = 1414 ms; then two
	// straight steps on mud.
	if ms[0].GetDurationMs() != 1414 || ms[1].GetDurationMs() != 1000 || ms[2].GetDurationMs() != 1000 {
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

// Turn anti-flood (lote 16): 30 alternating Turns in one tick reach each observer at most
// turnBurst times; the turner's direction is always the last one, and the held-back last
// direction reaches the observers once the bucket refills, so they end on it too.
func TestTurnSpamLimited(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	a, pa := h.join("Ana", at(10, 10))
	b, _ := h.join("Bob", at(12, 10))
	c, _ := h.join("Cid", at(10, 12))
	a.take()
	b.take()
	c.take()
	dirs := []pb.Direction{W, E}
	for i := range 30 {
		h.input(a, &pb.ClientMessage{Message: &pb.ClientMessage_Turn{Turn: &pb.Turn{Dir: dirs[i%2]}}})
	}
	h.sim.Step()
	for _, o := range []*fakeClient{b, c} {
		if n := len(find(o.take(), (*pb.ServerMessage).GetCreatureTurn)); n == 0 || n > 6 {
			t.Fatalf("observer got %d turns in one tick", n)
		}
	}
	if got := find(a.take(), (*pb.ServerMessage).GetCreatureTurn); len(got) != 30 || got[29].GetDir() != E {
		t.Fatalf("turner got %d turns", len(got))
	}
	h.sim.RunTicks(20)
	for _, o := range []*fakeClient{b, c} {
		turns := find(o.take(), (*pb.ServerMessage).GetCreatureTurn)
		if len(turns) != 1 || turns[0].GetId() != pa.ID() || turns[0].GetDir() != E {
			t.Fatalf("held-back last direction: %v", turns)
		}
	}
}
