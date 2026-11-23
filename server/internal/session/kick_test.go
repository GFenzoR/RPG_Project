package session_test

import (
	"testing"
	"time"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// A password reset (T2.1) disconnects every online character of the account, and only
// that account's.
func TestKickAccountDisconnectsEveryCharacter(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, ".....", ".....", "....."))
	const account = 900
	a, _ := h.joinChar(session.Character{ID: 901, AccountID: account, Name: "Alfa", Vocation: "guardian", Level: 1, Health: 145})
	b, _ := h.joinChar(session.Character{ID: 902, AccountID: account, Name: "Beta", Vocation: "guardian", Level: 1, Health: 145})
	other, _ := h.joinChar(session.Character{ID: 903, AccountID: 901, Name: "Gamma", Vocation: "guardian", Level: 1, Health: 145})

	h.sim.Command(h.w.KickAccount(account, h.sim.Now()))
	h.sim.Step()
	for _, cl := range []*fakeClient{a, b} {
		if !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED {
			t.Fatalf("closed %v reason %v", cl.closed, cl.reason)
		}
	}
	if h.w.PlayerByCharacter(901) != nil || h.w.PlayerByCharacter(902) != nil {
		t.Fatal("a kicked character is still in the world")
	}
	if other.closed || h.w.PlayerByCharacter(903) == nil {
		t.Fatal("another account was kicked")
	}
	// Both were saved like on a logout.
	saved := map[int64]bool{}
	for _, s := range h.saves {
		saved[s.CharacterID] = true
	}
	if !saved[901] || !saved[902] {
		t.Fatalf("saves %v", saved)
	}
}

// "Sign out everywhere" (lote 17) takes the account's characters out the same way, saved,
// with its own reason.
func TestSignOutAccountDisconnectsEveryCharacter(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, ".....", ".....", "....."))
	const account = 900
	a, _ := h.joinChar(session.Character{ID: 901, AccountID: account, Name: "Alfa", Vocation: "guardian", Level: 1, Health: 145})
	other, _ := h.joinChar(session.Character{ID: 903, AccountID: 901, Name: "Gamma", Vocation: "guardian", Level: 1, Health: 145})

	h.sim.Command(h.w.SignOutAccount(account, h.sim.Now()))
	h.sim.Step()
	if !a.closed || a.reason != pb.DisconnectReason_DISCONNECT_REASON_SIGNED_OUT_EVERYWHERE {
		t.Fatalf("closed %v reason %v", a.closed, a.reason)
	}
	if h.w.PlayerByCharacter(901) != nil {
		t.Fatal("the signed-out character is still in the world")
	}
	if other.closed || h.w.PlayerByCharacter(903) == nil {
		t.Fatal("another account was signed out")
	}
	saved := false
	for _, s := range h.saves {
		saved = saved || s.CharacterID == 901
	}
	if !saved {
		t.Fatal("the signed-out character was not saved")
	}
}

// A login that redeemed its play token before "sign out everywhere" committed, and whose
// Join reaches the loop only after the kick, is refused (review of lote 17): the kick
// could not find it online and the revocation could not find its token, spent already.
func TestSignOutAccountRefusesLoginInFlight(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, ".....", ".....", "....."))
	const account = 900
	c := session.Character{ID: 901, AccountID: account, Name: "Alfa", Vocation: "guardian", Level: 1, Health: 145,
		RedeemedAt: h.sim.Now()}
	h.sim.Clock().Advance(time.Second)
	h.sim.Command(h.w.LoginStarted(c.ID))
	h.sim.Command(h.w.SignOutAccount(account, h.sim.Now()))
	h.sim.Step()
	cl := &fakeClient{}
	h.sim.Command(h.joinCmd(c, cl))
	h.sim.Step()
	if !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_SIGNED_OUT_EVERYWHERE {
		t.Fatalf("closed %v reason %v", cl.closed, cl.reason)
	}
	if h.w.PlayerByCharacter(901) != nil {
		t.Fatal("a login from before the revocation joined")
	}

	// A login that redeemed a token after the revocation (the owner logging in again) joins,
	// and so does another account's.
	c.RedeemedAt = h.sim.Now()
	if _, p := h.joinChar(c); p == nil {
		t.Fatal("a later login was refused")
	}
	h.joinChar(session.Character{ID: 903, AccountID: 901, Name: "Gamma", Vocation: "guardian", Level: 1, Health: 145})
}

// A password reset or change refuses a login in flight the same way, with its reason,
// and the loop forgets the revocation after session.RevocationMemory.
func TestKickAccountRefusesLoginInFlight(t *testing.T) {
	h := newHarness(t, worldtest.Map(t, 0, 0, 7, ".....", ".....", "....."))
	const account = 900
	c := session.Character{ID: 901, AccountID: account, Name: "Alfa", Vocation: "guardian", Level: 1, Health: 145,
		RedeemedAt: h.sim.Now()}
	h.sim.Command(h.w.KickAccount(account, h.sim.Now()))
	h.sim.Step()
	cl := &fakeClient{}
	h.sim.Command(h.joinCmd(c, cl))
	h.sim.Step()
	if !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED {
		t.Fatalf("closed %v reason %v", cl.closed, cl.reason)
	}

	h.sim.Clock().Advance(session.RevocationMemory + time.Second)
	if _, p := h.joinChar(c); p == nil {
		t.Fatal("the revocation was never forgotten")
	}
}
