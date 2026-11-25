package session_test

import (
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Invitations by character name (the party window's "Invitar" button, docs/02 "Grupos").

func inviteName(name string) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_PartyCommand{PartyCommand: &pb.PartyCommand{
		Action: pb.PartyAction_PARTY_ACTION_INVITE_NAME, Name: name}}}
}

// inviteHarness is partyHarness with a chat anti-flood and an invitation limit too wide
// to get in the way, unless perMinute says otherwise.
func inviteHarness(t *testing.T, perMinute int) *harness {
	t.Helper()
	return newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) {
		c.Balance.Chat.Flood.Burst = 1000
		c.Balance.Party.InvitesPerMinute = perMinute
	})
}

// systemParam returns the text or number of param of each system message key in evs.
func systemParam(evs []*pb.ServerMessage, key, param string) []any {
	var out []any
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		if m.GetLocalized().GetKey() != key {
			continue
		}
		for _, p := range m.GetLocalized().GetParams() {
			if p.GetName() != param {
				continue
			}
			if _, ok := p.GetValue().(*pb.TextParam_Number); ok {
				out = append(out, p.GetNumber())
			} else {
				out = append(out, p.GetText())
			}
		}
	}
	return out
}

// A player far away, out of view, is invited by its name in any case; it gets the
// usual invitation, accepts it and joins the party.
func TestPartyInviteByNameFarAway(t *testing.T) {
	h := inviteHarness(t, 60)
	ca, a := h.join("Ana", at(5, 5))
	cb, b := h.join("Bruno", at(60, 60))
	if a.Knows(b.ID()) {
		t.Fatal("Bruno is in Ana's view")
	}
	ca.take()
	h.input(ca, inviteName("  bRUNO "))
	h.sim.Step()
	inv := find(cb.take(), (*pb.ServerMessage).GetPartyInvitation)
	if len(inv) != 1 || inv[0].GetInviterId() != a.ID() || inv[0].GetInviterName() != "Ana" {
		t.Fatalf("invitation %v", inv)
	}
	if got := systemParam(ca.take(), "party.invited", "name"); len(got) != 1 || got[0] != "Bruno" {
		t.Fatalf("inviter heard %v", got)
	}
	h.input(cb, partyCmd(pb.PartyAction_PARTY_ACTION_ACCEPT, a.ID()))
	h.sim.Step()
	if m, l, _ := b.PartyForTest(); len(m) != 2 || l != a.ID() {
		t.Fatalf("party %v led by %d", m, l)
	}
	// Only an exact name matches: no prefix, no partial match.
	ca.take()
	h.input(ca, inviteName("Bru"))
	h.sim.Step()
	if got := systemParam(ca.take(), "party.player_not_found", "name"); len(got) != 1 || got[0] != "Bru" {
		t.Fatalf("prefix: %v", got)
	}
	// An empty name, or one far longer than any name, is a malformed intent: nothing
	// happens, nothing is counted.
	h.input(ca, inviteName("   "))
	h.input(ca, inviteName(strings.Repeat("x", 81)))
	h.sim.Step()
	if evs := ca.take(); len(systemKeys(evs)) != 0 {
		t.Fatalf("empty name: %v", systemKeys(evs))
	}
}

// Every refusal of an invitation by name, each with its own message; an offline name and
// one nobody has answer alike, so nobody learns who exists.
func TestPartyInviteByNameResults(t *testing.T) {
	h := inviteHarness(t, 60)
	ca, a := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, c := h.join("Cora", at(40, 40))
	cd, d := h.join("Dario", at(50, 50))
	ce, _ := h.join("Elena", at(55, 55))
	cf, _ := h.join("Fabio", at(58, 58))
	// Gael was online and left: offline now.
	cg, _ := h.join("Gael", at(30, 30))
	h.sim.Command(h.w.Leave(cg))
	h.sim.Step()

	keyOf := func(cl *fakeClient, name string) map[string]int {
		t.Helper()
		cl.take()
		h.input(cl, inviteName(name))
		h.sim.Step()
		return systemKeys(cl.take())
	}

	// Offline and unknown: the same message, with the name as typed.
	if k := keyOf(ca, "Gael"); k["party.player_not_found"] != 1 || len(k) != 1 {
		t.Fatalf("offline: %v", k)
	}
	if k := keyOf(ca, "Zzyzx"); k["party.player_not_found"] != 1 || len(k) != 1 {
		t.Fatalf("unknown: %v", k)
	}
	// Oneself.
	if k := keyOf(ca, "ana"); k["party.invite_self"] != 1 || len(k) != 1 {
		t.Fatalf("self: %v", k)
	}
	// An invisible player Ana does not see is not online for her; one she sees is.
	h.do(func(*game.TickContext) { h.w.SetInvisibleForTest(c, true) })
	if k := keyOf(ca, "Cora"); k["party.player_not_found"] != 1 {
		t.Fatalf("invisible far: %v", k)
	}
	h.do(func(*game.TickContext) { h.w.SetInvisibleForTest(c, false) })
	if k := keyOf(ca, "Cora"); k["party.invited"] != 1 {
		t.Fatalf("visible again: %v", k)
	}
	if len(find(cc.take(), (*pb.ServerMessage).GetPartyInvitation)) != 1 {
		t.Fatal("Cora got no invitation")
	}
	// Twice the same while it is pending.
	if k := keyOf(ca, "Cora"); k["party.already_invited"] != 1 {
		t.Fatalf("repeat: %v", k)
	}
	// Already in a party: Dario and Elena form one; Ana invites Dario.
	h.input(cd, inviteName("Elena"))
	h.sim.Step()
	h.input(ce, partyCmd(pb.PartyAction_PARTY_ACTION_ACCEPT, d.ID()))
	h.sim.Step()
	if k := keyOf(ca, "dario"); k["party.already_in_party"] != 1 {
		t.Fatalf("in a party: %v", k)
	}
	// A member that does not lead cannot invite.
	if k := keyOf(ce, "Fabio"); k["party.not_leader"] != 1 {
		t.Fatalf("not leader: %v", k)
	}
	// Full: Ana, Bruno and Cora are max_members (3).
	h.form(ca, a, member{cb, b})
	h.input(cc, partyCmd(pb.PartyAction_PARTY_ACTION_ACCEPT, a.ID()))
	h.sim.Step()
	if m, _, _ := c.PartyForTest(); len(m) != 3 {
		t.Fatalf("party %v", m)
	}
	if k := keyOf(ca, "Fabio"); k["party.full"] != 1 {
		t.Fatalf("full: %v", k)
	}
	if len(find(cf.take(), (*pb.ServerMessage).GetPartyInvitation)) != 0 {
		t.Fatal("Fabio got an invitation")
	}
}

// party.invites_per_minute caps every invitation attempt, found or not, by name or by
// id: that many at once, then one every 60000 / invites_per_minute ms. Past it, the
// player hears how long to wait and nothing is sent.
func TestPartyInviteRateLimit(t *testing.T) {
	h := inviteHarness(t, 6) // 6 at once, then one every 10 s (200 ticks)
	ca, _ := h.join("Ana", at(10, 10))
	cb, b := h.join("Bruno", at(12, 10))
	cc, _ := h.join("Cora", at(60, 60))
	ca.take()
	for range 5 {
		h.input(ca, inviteName("Nobody"))
	}
	h.input(ca, partyCmd(pb.PartyAction_PARTY_ACTION_INVITE, b.ID())) // the 6th, by id
	h.input(ca, inviteName("Cora"))                                   // the 7th: refused
	h.sim.Step()
	evs := ca.take()
	k := systemKeys(evs)
	if k["party.player_not_found"] != 5 || k["party.invited"] != 1 || k["party.invite_rate"] != 1 {
		t.Fatalf("heard %v", k)
	}
	if got := systemParam(evs, "party.invite_rate", "seconds"); len(got) != 1 || got[0] != int64(10) {
		t.Fatalf("wait %v", got)
	}
	if len(find(cb.take(), (*pb.ServerMessage).GetPartyInvitation)) != 1 ||
		len(find(cc.take(), (*pb.ServerMessage).GetPartyInvitation)) != 0 {
		t.Fatal("wrong invitations sent")
	}
	// A refused attempt does not push the wait further: 10 s later one more goes.
	h.sim.RunTicks(199)
	h.input(ca, inviteName("Cora"))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.invited"] != 1 {
		t.Fatalf("after the wait: %v", k)
	}
	if len(find(cc.take(), (*pb.ServerMessage).GetPartyInvitation)) != 1 {
		t.Fatal("Cora got no invitation after the wait")
	}
	h.input(ca, inviteName("Nobody"))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.invite_rate"] != 1 {
		t.Fatalf("right after: %v", k)
	}
}

// The invitation limit belongs to the account, not to the connection: logging in again
// or playing the account's other character gives no fresh burst of names to try. It is
// forgotten once it is spent.
func TestPartyInviteRateLimitIsPerAccount(t *testing.T) {
	h := inviteHarness(t, 6)
	ana := session.Character{ID: 9001, AccountID: 9000, Name: "Ana", Vocation: "guardian", Level: 1, Health: 145, Mana: 20}
	alt := session.Character{ID: 9002, AccountID: 9000, Name: "Alma", Vocation: "guardian", Level: 1, Health: 145, Mana: 20}
	ca, _ := h.joinChar(ana)
	for range 6 {
		h.input(ca, inviteName("Nobody"))
	}
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.player_not_found"] != 6 {
		t.Fatalf("burst: %v", k)
	}
	// The other character of the account, online at the same time.
	cl, _ := h.joinChar(alt)
	cl.take()
	h.input(cl, inviteName("Nobody"))
	h.sim.Step()
	if k := systemKeys(cl.take()); k["party.invite_rate"] != 1 || k["party.player_not_found"] != 0 {
		t.Fatalf("other character: %v", k)
	}
	// A relogin.
	h.sim.Command(h.w.Leave(ca))
	h.sim.Step()
	ca, _ = h.joinChar(ana)
	ca.take()
	h.input(ca, inviteName("Nobody"))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.invite_rate"] != 1 || k["party.player_not_found"] != 0 {
		t.Fatalf("relogin: %v", k)
	}
	// Another account is not held back.
	cb, _ := h.join("Bruno", at(20, 20))
	cb.take()
	h.input(cb, inviteName("Nobody"))
	h.sim.Step()
	if k := systemKeys(cb.take()); k["party.player_not_found"] != 1 {
		t.Fatalf("other account: %v", k)
	}
	if n := h.w.InviteLimitsForTest(); n != 2 {
		t.Fatalf("%d limits kept", n)
	}
	// A minute later both limits are spent and forgotten.
	h.sim.RunTicks(1300)
	if n := h.w.InviteLimitsForTest(); n != 0 {
		t.Fatalf("%d limits kept after a minute", n)
	}
}

// An invited player that logs out takes the invitation along: the inviter may invite
// it again when it is back, and the name answers as any offline one meanwhile.
func TestPartyInviteByNameInviteeLogsOut(t *testing.T) {
	h := inviteHarness(t, 60)
	ca, _ := h.join("Ana", at(5, 5))
	bruno := session.Character{ID: 9101, AccountID: 9101, Name: "Bruno", Vocation: "guardian", Level: 1, Health: 145, Mana: 20}
	cb, _ := h.joinChar(bruno)
	h.input(ca, inviteName("Bruno"))
	h.sim.Step()
	if h.w.InvitesForTest() != 1 {
		t.Fatal("no invitation")
	}
	h.sim.Command(h.w.Leave(cb))
	h.sim.Step()
	if h.w.InvitesForTest() != 0 {
		t.Fatal("the invitation outlived the invited player")
	}
	ca.take()
	h.input(ca, inviteName("Bruno"))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.player_not_found"] != 1 {
		t.Fatalf("offline: %v", k)
	}
	cb, _ = h.joinChar(bruno)
	h.input(ca, inviteName("Bruno"))
	h.sim.Step()
	if k := systemKeys(ca.take()); k["party.invited"] != 1 {
		t.Fatalf("back online: %v", k)
	}
	if len(find(cb.take(), (*pb.ServerMessage).GetPartyInvitation)) != 1 {
		t.Fatal("no invitation after the relogin")
	}
}

// The typed name comes back in the answer: control characters never do.
func TestPartyInviteByNameIsCleaned(t *testing.T) {
	h := inviteHarness(t, 60)
	ca, _ := h.join("Ana", at(5, 5))
	ca.take()
	h.input(ca, inviteName("No\nbo\u202edy\x00"))
	h.input(ca, inviteName("\n\t"))
	h.sim.Step()
	if got := systemParam(ca.take(), "party.player_not_found", "name"); len(got) != 1 || got[0] != "No bo dy" {
		t.Fatalf("heard %q", got)
	}
}
