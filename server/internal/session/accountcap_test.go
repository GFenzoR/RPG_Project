package session_test

import (
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Audit lote 16: one account may have DefaultMaxCharactersPerAccount (2) characters in
// the world at once; a relogin of one of them still takes it over.
func TestAccountCharacterCap(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	char := func(id int64, name string, x int) session.Character {
		return session.Character{ID: id, AccountID: 900, Name: name, Vocation: "guardian", Level: 1, Health: 145,
			Pos: pos(x, 5), HasPos: true}
	}
	h.joinChar(char(9001, "Uno", 3))
	h.joinChar(char(9002, "Dos", 5))

	third := &fakeClient{}
	h.sim.Command(h.joinCmd(char(9003, "Tres", 7), third))
	h.sim.Step()
	if !third.closed || third.reason != pb.DisconnectReason_DISCONNECT_REASON_TOO_MANY_CHARACTERS {
		t.Fatalf("third character: closed=%v reason=%v", third.closed, third.reason)
	}
	if h.w.PlayerByCharacter(9003) != nil || h.w.Online() != 2 {
		t.Fatalf("online %d", h.w.Online())
	}

	// Another account is not limited by this one.
	h.joinChar(session.Character{ID: 9004, AccountID: 901, Name: "Otra", Vocation: "guardian", Level: 1, Health: 145})

	// Logging one of the two in again replaces it.
	again, p := h.joinChar(char(9002, "Dos", 5))
	if again.closed || p.CharacterID() != 9002 || h.w.Online() != 3 {
		t.Fatalf("relogin: closed=%v (%v), online %d", again.closed, again.reason, h.w.Online())
	}

	// The takeover kept the count at two: a third is still refused.
	still := &fakeClient{}
	h.sim.Command(h.joinCmd(char(9003, "Tres", 7), still))
	h.sim.Step()
	if !still.closed || still.reason != pb.DisconnectReason_DISCONNECT_REASON_TOO_MANY_CHARACTERS {
		t.Fatalf("third after relogin: closed=%v reason=%v", still.closed, still.reason)
	}

	// One leaves: its place is free again.
	h.sim.Command(h.w.Leave(again))
	h.sim.Step()
	if h.w.PlayerByCharacter(9002) != nil {
		t.Fatal("the character that left is still in the world")
	}
	if _, p3 := h.joinChar(char(9003, "Tres", 7)); p3 == nil || p3.CharacterID() != 9003 {
		t.Fatal("third character refused after one of the two left")
	}
}

func TestAccountCharacterCapConfigurable(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32), func(c *session.Config) { c.MaxCharactersPerAccount = -1 })
	for i := range 4 {
		h.joinChar(session.Character{ID: int64(9100 + i), AccountID: 902, Name: "Bot", Vocation: "guardian", Level: 1,
			Health: 145, Pos: pos(2+2*i, 5), HasPos: true})
	}
	if h.w.Online() != 4 {
		t.Fatalf("online %d with no cap", h.w.Online())
	}
}
