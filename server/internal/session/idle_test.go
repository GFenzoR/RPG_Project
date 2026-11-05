package session_test

import (
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

func idleHarness(t *testing.T) *harness {
	m := worldtest.Open(t, 0, 0, 64, 32)
	s := m.SectorAt(pos(40, 10))
	s.Flags[10*world.SectorSize+8] |= world.FlagNoLogout // (40, 10)
	return newHarness(t, m, func(c *session.Config) {
		c.Balance.Idle.KickAfterMs, c.Balance.Idle.WarnBeforeMs = 120_000, 30_000
		c.Balance.Travel.CombatBlockMs = 12_000
	})
}

// T4.1: no real action for idle.kick_after_ms disconnects with IDLE, after a warning;
// pings, turning and looking do not count, walking does.
func TestIdleDisconnect(t *testing.T) {
	h := idleHarness(t)
	cl, p := h.join("Sleepy", at(10, 10))
	busy, _ := h.join("Busy", at(14, 10))
	h.sim.RunFor(80 * time.Second)
	h.input(busy, walk(E))
	for range 40 { // keepalives for the rest of the time
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: 1}}})
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_Turn{Turn: &pb.Turn{Dir: N}}})
		// Intents that do nothing do not count either.
		h.input(cl, setTarget(0))
		h.input(cl, useItem(onTile(pos(30, 30)), 999, 0))
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_ShopBuy{ShopBuy: &pb.ShopBuy{DialogId: 9, ItemId: 1, Count: 1}}})
		h.sim.RunFor(time.Second)
	}
	if !hasKey(cl.take(), "idle.warning") || cl.closed {
		t.Fatalf("warned at 90 s and still online: closed %v", cl.closed)
	}
	h.sim.RunFor(2 * time.Second)
	if !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_IDLE || h.w.PlayerByCharacter(p.CharacterID()) != nil {
		t.Fatalf("closed %v reason %v", cl.closed, cl.reason)
	}
	if busy.closed {
		t.Fatal("the player who walked was disconnected")
	}
	if len(h.saves) == 0 || !h.saves[len(h.saves)-1].Final {
		t.Fatal("idle disconnect did not save")
	}
}

// Never in combat or on a no-logout tile: the check waits until it can.
func TestIdleRespectsCombatAndNoLogout(t *testing.T) {
	h := idleHarness(t)
	cl, p := h.join("Guard", at(40, 10)) // no-logout tile
	h.sim.RunFor(125 * time.Second)
	if cl.closed {
		t.Fatal("disconnected on a no-logout tile")
	}
	h.input(cl, walk(W)) // a real action: the clock restarts
	h.sim.RunFor(119 * time.Second)
	h.sim.Command(ctxFunc(func(ctx *game.TickContext) { h.w.HurtForTest(ctx, p, 1) })) // combat
	h.sim.RunFor(5 * time.Second)
	if cl.closed {
		t.Fatal("disconnected in combat")
	}
	h.sim.RunFor(10 * time.Second) // travel.combat_block_ms passed
	if !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_IDLE {
		t.Fatalf("closed %v reason %v", cl.closed, cl.reason)
	}
}
