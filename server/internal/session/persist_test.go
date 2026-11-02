package session_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

func TestRerouteAroundCreature(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	a, pa := h.join("Ana", at(5, 5))
	_, _ = h.join("Bob", at(7, 5)) // stands on Ana's straight path
	a.take()
	h.input(a, walkPath(E, E, E, E))
	h.sim.RunTicks(80)
	evs := a.take()
	if pa.Pos() != pos(9, 5) || len(find(evs, (*pb.ServerMessage).GetWalkRejected)) != 0 {
		t.Fatalf("at %v, events %v", pa.Pos(), kinds(evs))
	}
	h.checkInvariants()

	// Keyboard steps (no destination) are not rerouted: rejected.
	h.input(a, walk(W))
	h.sim.Step()
	h.input(a, walk(W))
	h.sim.RunTicks(30)
	if pa.Pos() != pos(8, 5) {
		t.Fatalf("at %v, want 8,5 (blocked by Bob at 7,5)", pa.Pos())
	}
	if len(find(a.take(), (*pb.ServerMessage).GetWalkRejected)) != 1 {
		t.Fatal("blocked keyboard step not rejected")
	}

	// An occupied destination cannot be reached: rejected after the reroute fails.
	h.input(a, walkPath(W))
	h.sim.RunTicks(5)
	if len(find(a.take(), (*pb.ServerMessage).GetWalkRejected)) != 1 {
		t.Fatal("path onto a creature not rejected")
	}
}

func TestPathfindingQuotaPerTick(t *testing.T) {
	// A quota of one search per tick: of two blocked walkers, the second reroutes a tick
	// later instead of being rejected.
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) {
		c.RerouteMaxNodes = 100
		c.PathNodesPerTick = 200
	})
	a, pa := h.join("Ana", at(5, 5))
	b, pbob := h.join("Bob", at(5, 9))
	h.join("Wall1", at(6, 5))
	h.join("Wall2", at(6, 9))
	a.take()
	b.take()
	h.input(a, walkPath(E, E))
	h.input(b, walkPath(E, E))
	h.sim.Step()
	if pa.Pos() == pos(5, 5) || pbob.Pos() != pos(5, 9) {
		t.Fatalf("tick 1: Ana %v Bob %v; want Ana moved and Bob waiting", pa.Pos(), pbob.Pos())
	}
	h.sim.Step()
	if pbob.Pos() == pos(5, 9) {
		t.Fatal("Bob did not reroute on the next tick")
	}
	h.sim.RunTicks(40)
	if pa.Pos() != pos(7, 5) || pbob.Pos() != pos(7, 9) {
		t.Fatalf("Ana %v Bob %v", pa.Pos(), pbob.Pos())
	}
	if len(find(a.take(), (*pb.ServerMessage).GetWalkRejected))+len(find(b.take(), (*pb.ServerMessage).GetWalkRejected)) != 0 {
		t.Fatal("a reroute was rejected")
	}
}

func TestLogoutSavesAndQuickReloginUsesMemory(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	a, pa := h.join("Ana", at(5, 5))
	obs, _ := h.join("Obs", at(8, 8))
	h.input(a, walk(E))
	h.sim.RunTicks(10)
	a.take()
	obs.take()
	h.input(a, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	h.sim.Step()
	if !a.closed || a.reason != pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT || h.w.Online() != 1 {
		t.Fatalf("closed=%v reason=%v online=%d", a.closed, a.reason, h.w.Online())
	}
	if d := find(obs.take(), (*pb.ServerMessage).GetCreatureDisappear); len(d) != 1 || d[0].GetId() != pa.ID() {
		t.Fatal("observer did not see Ana leave")
	}
	last := h.saves[len(h.saves)-1]
	if !last.Final || last.Pos != pos(6, 5) || last.CharacterID != pa.CharacterID() || last.Health != 145 {
		t.Fatalf("final snapshot %+v", last)
	}

	// The database still has the old row (no ack yet): the login uses the snapshot.
	stale := session.Character{ID: pa.CharacterID(), Name: "Ana", Vocation: "guardian", Level: 1, Health: 145, HasPos: true, Pos: pos(5, 5)}
	cl2, again := h.joinChar(stale)
	if again.Pos() != pos(6, 5) {
		t.Fatalf("relogin at %v, want the unsaved 6,5", again.Pos())
	}
	h.input(nil, walk(E)) // a command from an unknown client is ignored
	h.sim.Step()

	// Once the final snapshot is acknowledged, a later login trusts the database.
	h.sim.Command(h.w.Leave(cl2))
	h.sim.Step()
	final := h.saves[len(h.saves)-1]
	if final.Seq <= last.Seq {
		t.Fatalf("seq did not grow: %d then %d", last.Seq, final.Seq)
	}
	h.sim.Command(h.w.Saved(final.CharacterID, final.Seq))
	h.sim.Step()
	_, third := h.joinChar(stale)
	if third.Pos() != pos(5, 5) {
		t.Fatalf("after ack at %v, want the database's 5,5", third.Pos())
	}
}

func TestLoginElsewhereKicksTheOldConnection(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	old, p := h.join("Ana", at(5, 5))
	obs, _ := h.join("Obs", at(6, 6))
	h.input(old, walk(S))
	h.sim.RunTicks(10)
	obs.take()
	c := session.Character{ID: p.CharacterID(), Name: "Ana", Vocation: "guardian", Level: 1, Health: 145}
	nw, np := h.joinChar(c)
	if !old.closed || old.reason != pb.DisconnectReason_DISCONNECT_REASON_LOGGED_IN_ELSEWHERE {
		t.Fatalf("old connection closed=%v reason=%v", old.closed, old.reason)
	}
	if np.Pos() != pos(5, 6) || h.w.Online() != 2 || np.ID() == p.ID() {
		t.Fatalf("new player at %v, online %d", np.Pos(), h.w.Online())
	}
	if got := kinds(nw.take()); got[0] != "welcome" {
		t.Fatalf("new connection got %v", got)
	}
	ev := kinds(obs.take())
	if len(ev) != 2 || ev[0] != "creature_disappear" || ev[1] != "creature_appear" {
		t.Fatalf("observer got %v", ev)
	}
	// The new player's snapshots outrank the old connection's final one, so the late
	// ack of that final save cannot drop the new player's unsaved logout snapshot.
	oldFinal := h.saves[len(h.saves)-1]
	h.sim.Command(h.w.Leave(nw))
	h.sim.Step()
	newFinal := h.saves[len(h.saves)-1]
	if !oldFinal.Final || newFinal.Seq <= oldFinal.Seq {
		t.Fatalf("old final seq %d, new final seq %d", oldFinal.Seq, newFinal.Seq)
	}
	h.sim.Command(h.w.Saved(oldFinal.CharacterID, oldFinal.Seq))
	h.sim.Step()
	nw, np = h.joinChar(session.Character{ID: c.ID, Name: "Ana", Vocation: "guardian", Level: 1, Health: 145, HasPos: true, Pos: pos(1, 1)})
	if np.Pos() != pos(5, 6) {
		t.Fatalf("relogin at %v: the unsaved snapshot was dropped by an old ack", np.Pos())
	}
	nw.take()
	// The old connection's late input and Leave do not touch the new player.
	h.input(old, walk(E))
	h.sim.Command(h.w.Leave(old))
	h.sim.RunTicks(10)
	if h.w.PlayerByCharacter(c.ID) != np || np.Pos() != pos(5, 6) {
		t.Fatal("old connection affected the new player")
	}
	h.checkInvariants()
}

func TestSlowClientIsDropped(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	slow, ps := h.join("Slow", at(5, 5))
	obs, _ := h.join("Obs", at(6, 6))
	obs.take()
	slow.full = true
	h.input(slow, walk(E))
	h.sim.Step()
	if !slow.closed || slow.reason != pb.DisconnectReason_DISCONNECT_REASON_SLOW_CLIENT || h.w.Online() != 1 {
		t.Fatalf("closed=%v reason=%v online=%d", slow.closed, slow.reason, h.w.Online())
	}
	h.sim.Step()
	if d := find(obs.take(), (*pb.ServerMessage).GetCreatureDisappear); len(d) != 1 || d[0].GetId() != ps.ID() {
		t.Fatal("observer did not see the slow client leave")
	}
	if last := h.saves[len(h.saves)-1]; !last.Final || last.CharacterID != ps.CharacterID() {
		t.Fatalf("slow client not saved: %+v", last)
	}
}

func TestAutosaveIsStaggered(t *testing.T) {
	const every = 100
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) { c.AutosaveEvery = every })
	for i := range 8 {
		h.join("P", at(i*2, 1))
	}
	ticks := map[int64][]game.Tick{}
	start := h.sim.Tick()
	for range 3 * every {
		n := len(h.saves)
		h.sim.Step()
		for _, s := range h.saves[n:] {
			if s.Final {
				t.Fatal("autosave marked final")
			}
			ticks[s.CharacterID] = append(ticks[s.CharacterID], h.sim.Tick()-start)
		}
	}
	distinct := map[game.Tick]bool{}
	for id, ts := range ticks {
		if len(ts) < 2 || len(ts) > 3 {
			t.Fatalf("character %d saved at %v", id, ts)
		}
		for i := 1; i < len(ts); i++ {
			if ts[i]-ts[i-1] != every {
				t.Fatalf("character %d: interval %d", id, ts[i]-ts[i-1])
			}
		}
		distinct[ts[0]] = true
	}
	if len(ticks) != 8 || len(distinct) < 4 {
		t.Fatalf("first autosaves %v: not staggered", ticks)
	}
}

func TestSaveRetriedWhenQueueFull(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	a, p := h.join("Ana", at(5, 5))
	h.full = true
	h.input(a, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	h.sim.RunTicks(3)
	if len(h.saves) != 0 {
		t.Fatal("saved while full")
	}
	h.full = false
	h.sim.Step()
	if len(h.saves) != 1 || h.saves[0].CharacterID != p.CharacterID() || !h.saves[0].Final {
		t.Fatalf("saves %+v", h.saves)
	}
}

func TestSaveAllAtShutdown(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	h.join("Ana", at(5, 5))
	h.join("Bob", at(9, 5))
	h.saves = nil
	if pending := h.w.SaveAll(); len(pending) != 0 || len(h.saves) != 2 || !h.saves[0].Final {
		t.Fatalf("pending %v saves %v", pending, h.saves)
	}
	h.full = true
	if pending := h.w.SaveAll(); len(pending) != 2 {
		t.Fatalf("pending %v", pending)
	}
}

func TestSaverRetriesAndAcks(t *testing.T) {
	clk := clock.NewFake(time.Time{})
	var mu sync.Mutex
	var written, acked []session.Snapshot
	fails := 2
	s, err := session.NewSaver(session.SaverConfig{
		Clock: clk,
		Write: func(_ context.Context, snap session.Snapshot) error {
			mu.Lock()
			defer mu.Unlock()
			if snap.CharacterID == 9 {
				return session.ErrGone
			}
			if fails > 0 {
				fails--
				return errors.New("db down")
			}
			written = append(written, snap)
			return nil
		},
		Saved: func(snap session.Snapshot) { mu.Lock(); acked = append(acked, snap); mu.Unlock() },
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Start()
	if !s.Submit(session.Snapshot{CharacterID: 1, Seq: 1}) || !s.Submit(session.Snapshot{CharacterID: 9}) || !s.Submit(session.Snapshot{CharacterID: 1, Seq: 2}) {
		t.Fatal("submit refused")
	}
	// Two failures: the fake clock must move past both backoffs.
	go func() {
		for range 200 {
			clk.Advance(time.Second)
			<-wall.After(time.Millisecond)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Submit(session.Snapshot{CharacterID: 2}) {
		t.Fatal("submit after stop")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(written) != 2 || written[0].Seq != 1 || written[1].Seq != 2 || len(acked) != 3 {
		t.Fatalf("written %v acked %v", written, acked)
	}
}

func TestSaverStopDeadlineAbandonsRetries(t *testing.T) {
	s, _ := session.NewSaver(session.SaverConfig{
		Clock: clock.NewFake(time.Time{}),
		Write: func(context.Context, session.Snapshot) error { return errors.New("db down") },
	})
	s.Start()
	s.Submit(session.Snapshot{CharacterID: 1})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := s.Stop(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Stop = %v", err)
	}
}

var wall clock.Clock = clock.Real{}

// TestAckDuringLoginKeepsUnsaved is the race of a quick re-login: the gateway reads the
// row before the final save commits, and the save's ack reaches the loop before the
// Join. LoginStarted (enqueued before the read) keeps the snapshot for that Join.
func TestAckDuringLoginKeepsUnsaved(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	a, p := h.join("Ana", at(5, 5))
	h.input(a, walk(E))
	h.sim.RunTicks(10)
	h.input(a, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	h.sim.Step()
	final := h.saves[len(h.saves)-1]
	stale := session.Character{ID: p.CharacterID(), Name: "Ana", Vocation: "guardian", Level: 1, Health: 145, HasPos: true, Pos: pos(5, 5)}

	h.sim.Command(h.w.LoginStarted(stale.ID))              // gateway, before reading the row
	h.sim.Command(h.w.Saved(final.CharacterID, final.Seq)) // the save commits and acks
	h.sim.Step()
	_, again := h.joinChar(stale) // Join with the row read before the commit
	if again.Pos() != pos(6, 5) {
		t.Fatalf("relogin at %v, want the snapshot's 6,5", again.Pos())
	}

	// An aborted login releases the hold: the next ack forgets the snapshot.
	h.sim.Command(h.w.Leave(lookup(h, again)))
	h.sim.Step()
	final = h.saves[len(h.saves)-1]
	h.sim.Command(h.w.LoginStarted(stale.ID))
	h.sim.Command(h.w.LoginAborted(stale.ID))
	h.sim.Command(h.w.Saved(final.CharacterID, final.Seq))
	h.sim.Step()
	_, third := h.joinChar(stale)
	if third.Pos() != pos(5, 5) {
		t.Fatalf("after abort and ack at %v, want the database's 5,5", third.Pos())
	}
}

func lookup(h *harness, p *session.Player) session.Client {
	for _, c := range h.w.Clients() {
		if h.w.ClientPlayer(c) == p {
			return c
		}
	}
	return nil
}

func TestSaverDropsPermanentErrors(t *testing.T) {
	var mu sync.Mutex
	var written []int64
	s, _ := session.NewSaver(session.SaverConfig{
		Clock: clock.NewFake(time.Time{}), // never advances: a retry would hang Stop
		Write: func(_ context.Context, snap session.Snapshot) error {
			if snap.CharacterID == 1 {
				return fmt.Errorf("%w: check violation", session.ErrPermanent)
			}
			mu.Lock()
			written = append(written, snap.CharacterID)
			mu.Unlock()
			return nil
		},
	})
	s.Start()
	s.Submit(session.Snapshot{CharacterID: 1})
	s.Submit(session.Snapshot{CharacterID: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Stop(ctx); err != nil { // idempotent
		t.Fatal(err)
	}
	if len(written) != 1 || written[0] != 2 {
		t.Fatalf("written %v", written)
	}
}
