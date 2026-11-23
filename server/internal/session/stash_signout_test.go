package session_test

import (
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// "Sign out everywhere" and a password change (lote 17) take the account's characters out
// through the usual logout: a stash move still waiting for the database keeps the stash
// in memory until it is acked, a login in flight refused by the revocation does not keep
// it there, and once everything is written the next login reads the move from the rows.
func TestSignOutKeepsTheStashUntilSaved(t *testing.T) {
	for _, tc := range []struct {
		name   string
		kick   func(w *session.World, account int64, at time.Time) game.Command
		reason pb.DisconnectReason
	}{
		{"sign out everywhere", (*session.World).SignOutAccount, pb.DisconnectReason_DISCONNECT_REASON_SIGNED_OUT_EVERYWHERE},
		{"password change", (*session.World).KickAccount, pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := newStashRows()
			h := newStashHarness(t, 30, &d.log)
			ca, _ := h.account(1, 100, "Ana", pos(1, 1), nil, stack(swordID, 1, 0))
			cb, _ := h.account(2, 100, "Beto", pos(0, 1), nil)
			h.sim.Command(h.w.ForceSaveForTest(ca))
			h.sim.Command(h.w.ForceSaveForTest(cb))
			h.sim.Step()
			d.writeAll(h.harness)
			h.open(ca)
			h.open(cb)
			pack := openPack(t, h.harness, ca)
			if u := lastStash(h.send(ca, stashDeposit(inContainer(pack, 0), swordID, 1))); u.GetResult() != pb.StashResult_STASH_RESULT_OK {
				t.Fatalf("Ana's deposit: %v", u)
			}

			// Cleo's login redeemed its play token before the revocation and is still reading.
			cleo := withPack(3, pos(2, 2))
			cleo.AccountID, cleo.Name, cleo.RedeemedAt = 100, "Cleo", h.sim.Now()
			h.sim.Clock().Advance(time.Second)
			h.sim.Command(h.w.LoginStarted(3, 100))
			h.sim.Command(tc.kick(h.w, 100, h.sim.Now()))
			h.sim.Step()
			for _, cl := range []*fakeClient{ca, cb} {
				if !cl.closed || cl.reason != tc.reason {
					t.Fatalf("closed %v reason %v", cl.closed, cl.reason)
				}
			}
			if h.w.PlayerByCharacter(1) != nil || h.w.PlayerByCharacter(2) != nil {
				t.Fatal("a character of the account is still in the world")
			}
			cl := &fakeClient{}
			h.sim.Command(h.joinCmd(cleo, cl))
			h.sim.Step()
			if !cl.closed || cl.reason != tc.reason || h.w.PlayerByCharacter(3) != nil {
				t.Fatalf("the login in flight was not refused: closed %v reason %v", cl.closed, cl.reason)
			}
			if !h.w.StashLoaded(100) {
				t.Fatal("the stash left memory before the deposit was written")
			}

			d.writeAll(h.harness)
			if h.w.StashLoaded(100) {
				t.Fatal("the stash stayed in memory after the kick with everything written")
			}
			if countState(d.stash[100], swordID) != 1 || d.total(100, swordID, 1, 2) != 1 {
				t.Fatalf("the rows do not hold the sword once, in the stash (stash %d, Ana %d)",
					countState(d.stash[100], swordID), d.count(1, swordID))
			}
			// Logging in again (after the revocation) reads the stash from the rows.
			beto := withPack(2, pos(0, 1))
			beto.AccountID, beto.Name, beto.Stash, beto.RedeemedAt = 100, "Beto", d.stash[100], h.sim.Now()
			if _, p := h.joinChar(beto); p == nil {
				t.Fatal("a login after the revocation was refused")
			}
			if n := h.stashCount(100, swordID); n != 1 {
				t.Fatalf("the stash after logging in again holds %d swords", n)
			}
		})
	}
}
