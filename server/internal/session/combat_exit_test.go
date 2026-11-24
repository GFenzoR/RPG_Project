package session_test

import (
	"slices"
	"testing"
	"time"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// Every way out of the game in the middle of a fight (owner 2026-11-23: "you cannot
// disconnect during a battle"; docs/02 "Bloqueo de logout en combate", "Salidas"): the
// character stays in the world, link-dead, until the logout block ends, and only then
// is it saved and taken out. Closing the tab, reloading the page, quitting the desktop
// app and losing the network all reach the server as the same closed connection (Leave);
// the account's security actions (a password change, "sign out everywhere") close the
// socket themselves but are no way out of a fight either.
func TestEveryExitPathInCombatKeepsTheCharacter(t *testing.T) {
	type exit struct {
		name string
		do   func(h *harness, cl *fakeClient, p *session.Player)
		// reason is the Disconnect the client gets (UNSPECIFIED: none, it closed itself).
		reason pb.DisconnectReason
	}
	exits := []exit{
		{"closed connection (tab, reload, app quit, network loss)", func(h *harness, cl *fakeClient, _ *session.Player) {
			h.sim.Command(h.w.Leave(cl))
		}, pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED},
		{"password change", func(h *harness, _ *fakeClient, p *session.Player) {
			h.sim.Command(h.w.KickAccount(p.CharacterID(), h.sim.Now())) // hunter: account = character
		}, pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED},
		{"sign out everywhere", func(h *harness, _ *fakeClient, p *session.Player) {
			h.sim.Command(h.w.SignOutAccount(p.CharacterID(), h.sim.Now()))
		}, pb.DisconnectReason_DISCONNECT_REASON_SIGNED_OUT_EVERYWHERE},
	}
	for _, e := range exits {
		t.Run(e.name, func(t *testing.T) {
			h := fightHarness(t, 15)
			cl, p := h.hunter("Runner", 1)
			hit := h.bitten(p)
			h.away(p)
			n := len(h.saves)
			e.do(h, cl, p)
			h.sim.Step()
			if e.reason != pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED && (!cl.closed || cl.reason != e.reason) {
				t.Fatalf("the socket: closed %v (%v), want %v", cl.closed, cl.reason, e.reason)
			}
			h.sim.Command(h.w.Leave(cl)) // the gateway's Leave after the socket closed
			h.sim.Step()
			h.runTo(hit, combatBlock-time.Second)
			if h.w.PlayerByCharacter(p.CharacterID()) != p || !p.LinkDead() || len(h.savesOf(p.CharacterID(), n)) != 0 {
				t.Fatalf("during the block: in the world %v, link-dead %v, saves %d",
					h.w.PlayerByCharacter(p.CharacterID()) == p, p.LinkDead(), len(h.savesOf(p.CharacterID(), n)))
			}
			h.runTo(hit, combatBlock+time.Second)
			s := h.savesOf(p.CharacterID(), n)
			if h.w.PlayerByCharacter(p.CharacterID()) != nil || len(s) != 1 || !s[0].Final {
				t.Fatalf("after the block: in the world %v, saves %+v", h.w.PlayerByCharacter(p.CharacterID()) != nil, s)
			}
		})
	}
}

// Out of combat the same exits take the character out at once (nothing to wait for).
func TestExitOutOfCombatLeavesAtOnce(t *testing.T) {
	h := fightHarness(t, 0) // a passive wolf: nobody fights
	cl, p := h.hunter("Calm", 1)
	h.sim.Command(h.w.SignOutAccount(p.CharacterID(), h.sim.Now()))
	h.sim.Step()
	if !cl.closed || h.w.PlayerByCharacter(p.CharacterID()) != nil || p.LinkDead() {
		t.Fatalf("closed %v, in the world %v, link-dead %v", cl.closed, h.w.PlayerByCharacter(p.CharacterID()) != nil, p.LinkDead())
	}
}

// The refusal of a Logout in a fight says how long is left ("seconds", rounded up): the
// same end the in_combat status counts down.
func TestLogoutRefusalSaysTheSecondsLeft(t *testing.T) {
	h := fightHarness(t, 15)
	cl, p := h.hunter("Patient", 1)
	hit := h.bitten(p)
	h.away(p)
	h.runTo(hit, 4*time.Second+500*time.Millisecond)
	cl.take()
	h.input(cl, logout())
	h.sim.Step()
	var got *pb.LocalizedText
	for _, m := range find(cl.take(), (*pb.ServerMessage).GetChatMessage) {
		if m.GetLocalized().GetKey() == "combat.logout_locked" {
			got = m.GetLocalized()
		}
	}
	if got == nil || cl.closed {
		t.Fatalf("no refusal (closed %v)", cl.closed)
	}
	ps := got.GetParams()
	// 12 s block, 4.5 s (and a tick) gone: 8 s left once rounded up.
	if len(ps) != 1 || ps[0].GetName() != "seconds" || ps[0].GetNumber() != 8 {
		t.Fatalf("params %v, want seconds 8", ps)
	}
}

// Lote 16's cap of characters online per account counts a link-dead one: an account
// cannot leave one character fighting offline and bring in two more. Logging the
// link-dead one in again takes it over (never a duplicate) and is no new character, so the
// cap does not refuse it.
func TestLinkDeadCountsTowardTheAccountCap(t *testing.T) {
	h := fightHarness(t, 15)
	const account = 7700
	char := func(id int64, name string) session.Character {
		return session.Character{ID: id, AccountID: account, Name: name, Vocation: "guardian", Level: 1,
			Health: 1 << 20, Pos: pos(21, 20), HasPos: true}
	}
	cl, p := h.joinChar(char(7701, "Fighter"))
	hit := h.bitten(p)
	h.away(p)
	h.sim.Command(h.w.Leave(cl)) // closed the tab in the fight
	h.sim.Step()
	if !p.LinkDead() {
		t.Fatal("not link-dead")
	}
	h.joinChar(session.Character{ID: 7702, AccountID: account, Name: "Second", Vocation: "guardian", Level: 1,
		Health: 145, Pos: far, HasPos: true})

	third := &fakeClient{}
	h.sim.Command(h.joinCmd(char(7703, "Third"), third))
	h.sim.Step()
	if !third.closed || third.reason != pb.DisconnectReason_DISCONNECT_REASON_TOO_MANY_CHARACTERS ||
		h.w.PlayerByCharacter(7703) != nil {
		t.Fatalf("a third character with one link-dead: closed %v (%v)", third.closed, third.reason)
	}

	// The relog takes the link-dead character over: one player of it, the fight carried.
	back := &fakeClient{}
	h.sim.Command(h.joinCmd(char(7701, "Fighter"), back))
	h.sim.Step()
	p2 := h.w.PlayerByCharacter(7701)
	if back.closed || p2 == nil || p2 == p || p2.LinkDead() || p2.Pos() != far {
		t.Fatalf("takeover: closed %v (%v), player %v", back.closed, back.reason, p2 != nil)
	}
	count := 0
	for _, o := range h.w.Players() {
		if o.CharacterID() == 7701 {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("%d players of the character", count)
	}
	back.take()
	h.input(back, logout())
	h.sim.Step()
	if !slices.Contains(sysKeys(back.take()), "combat.logout_locked") || back.closed {
		t.Fatal("the relog was a way out of the fight")
	}

	// Once the fight is over and it leaves, the place is free again.
	h.runTo(hit, combatBlock+time.Second)
	h.input(back, logout())
	h.sim.Step()
	if h.w.PlayerByCharacter(7701) != nil {
		t.Fatal("still in the world after logging out")
	}
	h.joinChar(char(7703, "Third"))
}
