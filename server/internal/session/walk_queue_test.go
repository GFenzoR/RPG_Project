package session_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// walkIn is a keyboard step of the client's walk epoch (docs/05 "Caminar").
func walkIn(d pb.Direction, epoch uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_Walk{Walk: &pb.Walk{Dir: d, WalkEpoch: epoch}}}
}

// stepTicks returns the tick of every CreatureMove of creature id the client got, and
// forgets the batches.
func stepTicks(cl *fakeClient, id uint32) []uint64 {
	var out []uint64
	for _, b := range cl.batches {
		for _, e := range b.GetEvents() {
			if m := e.GetCreatureMove(); m != nil && m.GetId() == id {
				out = append(out, b.GetTick())
			}
		}
	}
	cl.batches = nil
	return out
}

// A client that predicts steps ahead sends their Walks before the server has taken the
// ones before: each waits its turn, and the steps run back to back. Before the queue, a
// Walk replaced the one still waiting and the server lost a step.
func TestWalkQueuesBehindWaitingSteps(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 16))
	cl, p := h.join("Mira", at(4, 8))
	cl.take()
	h.input(cl, walkIn(E, 1))
	h.input(cl, walkIn(E, 1))
	h.sim.Step()
	h.input(cl, walkIn(S, 1)) // a tick later, while the second still waits
	h.sim.RunTicks(40)
	ticks := stepTicks(cl, p.ID())
	if p.Pos() != pos(6, 9) || len(ticks) != 3 {
		t.Fatalf("at %v after steps at ticks %v; want 6,9 in 3 steps", p.Pos(), ticks)
	}
	// 500 ms (10 ticks) per straight step: no tick lost between them.
	if ticks[1]-ticks[0] != 10 || ticks[2]-ticks[1] != 10 {
		t.Fatalf("steps at ticks %v, want 10 apart", ticks)
	}
}

// A held key over a real link: the client sends each step one tick before the step it
// draws ends (its lead), and every Walk takes 1 or 2 ticks to arrive, in order (TCP).
// The server walks back to back, which is what the other players see. A stall of the link
// then delivers two Walks in the same tick: both are kept (before the queue, the second
// replaced the first and the server lost a step the client had drawn).
func TestHeldKeyWalksBackToBackOverALink(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 16))
	cl, p := h.join("Mira", at(2, 8))
	cl.take()
	start := h.sim.Tick()
	delays := []game.Tick{1, 2, 1, 2, 15, 1, 2, 1}
	arrive := map[game.Tick]int{}
	last := start
	for k, d := range delays {
		send := start + game.Tick(max(10*k-1, 0)) // Walk k leaves at tick 10k - 1
		last = max(last, send+d)
		arrive[last]++
	}
	for range 140 {
		for range arrive[h.sim.Tick()+1] {
			h.input(cl, walkIn(E, 1))
		}
		h.sim.Step()
	}
	ticks := stepTicks(cl, p.ID())
	if len(ticks) != len(delays) || p.Pos() != pos(2+len(delays), 8) {
		t.Fatalf("%d steps (at ticks %v) to %v; want %d", len(ticks), ticks, p.Pos(), len(delays))
	}
	gaps := 0
	for i := 1; i < len(ticks); i++ {
		if ticks[i]-ticks[i-1] != 10 {
			gaps++ // only the link's stall
		}
	}
	if gaps != 1 {
		t.Fatalf("steps at ticks %v: want them 10 apart but for the stall", ticks)
	}
}

// More keyboard steps than max_queued_steps (4 in the tests) is not a client the server
// believes: the walk resets with WalkRejected and a new epoch. Walks of the old epoch
// still on their way are dropped without an answer; the new epoch walks again.
func TestWalkQueueOverflowResets(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 16))
	cl, p := h.join("Mira", at(4, 8))
	evs := cl.take()
	if fv := find(evs, (*pb.ServerMessage).GetFullMapView); len(fv) != 1 || fv[0].GetWalkEpoch() != 1 {
		t.Fatalf("the first view starts walk epoch 1: %v", fv)
	}
	h.input(cl, walkIn(E, 1)) // runs at once
	h.sim.Step()
	for range 5 {
		h.input(cl, walkIn(E, 1)) // 4 wait, the fifth overflows
	}
	h.sim.Step()
	evs = cl.take()
	rej := find(evs, (*pb.ServerMessage).GetWalkRejected)
	if len(rej) != 1 || rej[0].GetWalkEpoch() != 2 || rej[0].GetPos().GetX() != 5 || p.Walking() || p.WalkEpoch() != 2 {
		t.Fatalf("overflow: %v, epoch %d, walking %v", kinds(evs), p.WalkEpoch(), p.Walking())
	}
	h.input(cl, walkIn(E, 1)) // sent before the client heard of the reset
	h.sim.RunTicks(30)
	if evs := cl.take(); len(evs) != 0 || p.Pos() != pos(5, 8) {
		t.Fatalf("a Walk of the old epoch did %v, at %v", kinds(evs), p.Pos())
	}
	h.input(cl, walkIn(S, 2))
	h.sim.RunTicks(12)
	if p.Pos() != pos(5, 9) {
		t.Fatalf("the new epoch does not walk: at %v", p.Pos())
	}
}

// A step refused in the middle of the queue (a wall) drops the steps behind it and starts
// a new epoch; the client's Walks already on their way are dropped. A Walk with epoch 0
// (a client older than the queue) is not checked.
func TestRefusedStepDropsTheQueuedOnes(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7,
		"......",
		"...#..",
		"......",
	))
	cl, p := h.join("Mira", at(1, 1))
	cl.take()
	h.input(cl, walkIn(E, 1)) // to 2,1
	h.input(cl, walkIn(E, 1)) // into the wall at 3,1
	h.input(cl, walkIn(E, 1))
	h.sim.RunTicks(11)
	evs := cl.take()
	rej := find(evs, (*pb.ServerMessage).GetWalkRejected)
	if len(moves(evs)) != 1 || len(rej) != 1 || rej[0].GetDir() != E || rej[0].GetWalkEpoch() != 2 ||
		p.Pos() != pos(2, 1) || p.Walking() {
		t.Fatalf("events %v, at %v, walking %v", kinds(evs), p.Pos(), p.Walking())
	}
	h.input(cl, walkIn(S, 1)) // predicted from 3,1: stale
	h.sim.RunTicks(12)
	if evs := cl.take(); len(evs) != 0 || p.Pos() != pos(2, 1) {
		t.Fatalf("a stale Walk did %v, at %v", kinds(evs), p.Pos())
	}
	h.input(cl, walk(S)) // epoch 0
	h.sim.RunTicks(12)
	if p.Pos() != pos(2, 2) {
		t.Fatalf("a Walk without epoch: at %v", p.Pos())
	}
}

// A teleport (a GM, a boat, a portal) resets the walk too: the FullMapView carries the new
// epoch, and a Walk sent for the old place is dropped.
func TestTeleportStartsANewWalkEpoch(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 16))
	cl, p := h.join("Mira", at(4, 8))
	cl.take()
	h.input(cl, walkIn(E, 1))
	h.input(cl, walkIn(E, 1))
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, world.Pos{X: 40, Y: 8, Z: 7}) }))
	h.sim.Step()
	evs := cl.take()
	fv := find(evs, (*pb.ServerMessage).GetFullMapView)
	if len(fv) != 1 || fv[0].GetWalkEpoch() != 2 || p.Walking() {
		t.Fatalf("teleport: %v, walking %v", kinds(evs), p.Walking())
	}
	h.input(cl, walkIn(E, 1))
	h.sim.RunTicks(12)
	if p.Pos() != pos(40, 8) {
		t.Fatalf("a Walk of the old epoch moved to %v", p.Pos())
	}
	h.input(cl, walkIn(W, 2))
	h.sim.RunTicks(12)
	if p.Pos() != pos(39, 8) {
		t.Fatalf("the new epoch does not walk: at %v", p.Pos())
	}
}

// A key held for a long walk never lets the queue empty (a step always waits): the queue
// drops the steps taken instead of growing for as long as the key is held.
func TestHeldKeyQueueDoesNotGrow(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 256, 8))
	cl, p := h.join("Mira", at(1, 4))
	cl.take()
	h.input(cl, walkIn(E, 1))
	h.input(cl, walkIn(E, 1))
	for i := range 2000 {
		if i%10 == 5 {
			h.input(cl, walkIn(E, 1)) // one more per step: one always waits
		}
		h.sim.Step()
		cl.batches = nil
	}
	if p.Pos().X < 150 || !p.Walking() || p.QueueCapForTest() > 8 {
		t.Fatalf("at %v, walking %v, queue capacity %d", p.Pos(), p.Walking(), p.QueueCapForTest())
	}
}
