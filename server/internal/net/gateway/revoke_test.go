package gateway

import (
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// A login whose play token was redeemed before "sign out everywhere" committed is
// refused at its Join, even though the kick ran before the Join reached the loop (review
// of lote 17). A token redeemed after the revocation logs in: the gateway stamps each
// login with the time its redeem started.
func TestSignOutEverywhereRefusesLoginPastItsRedeem(t *testing.T) {
	// The loop runs on the real clock; in the app the gateway shares it.
	clk := clock.NewFake(clock.Real{}.Now())
	s := newStack(t, func(c *Config) { c.Clock = clk })
	release := make(chan struct{})
	s.accounts.mu.Lock()
	s.accounts.block = release
	s.accounts.mu.Unlock()
	s.token("a", 7)
	c := s.dial()
	if err := c.send(hello("a", DefaultMinClientVersion)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return s.accounts.calls.Load() == 1 }) // the redeem started

	clk.Advance(time.Second)
	kicked := make(chan struct{})
	if err := s.loop.Enqueue(s.world.SignOutAccount(1, clk.Now())); err != nil {
		t.Fatal(err)
	}
	if err := s.loop.Enqueue(game.CommandFunc(func(*game.TickContext) { close(kicked) })); err != nil {
		t.Fatal(err)
	}
	<-kicked
	s.accounts.mu.Lock()
	s.accounts.block = nil
	s.accounts.mu.Unlock()
	close(release)
	if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_SIGNED_OUT_EVERYWHERE {
		t.Fatalf("reason %v", r)
	}

	clk.Advance(time.Second)
	s.login("b", 7) // a new login of the account after the revocation
}
