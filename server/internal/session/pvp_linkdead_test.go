package session_test

import (
	"slices"
	"testing"
	"time"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// A connection the server ends is no way out of a PvP fight (T5.2, docs/02 "Bloqueo de
// combate PvP"): a player under the lock cut off as a slow client or by a password reset
// loses its connection but stays in the world link-dead, as if it had closed it. Worlds
// and numbers as in pvp_condition_test.go (lock 10 s, poison hits of 10 once a second).

// cutSlow makes cl's queue full and steps until the server drops it as a slow client (a
// ping's pong is the first batch that does not fit).
func (g *pvpWorld) cutSlow(cl *fakeClient) {
	g.t.Helper()
	cl.full = true
	g.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: 1}}})
	for i := 0; i < 100 && !cl.closed; i++ {
		g.sim.Step()
	}
	if !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_SLOW_CLIENT {
		g.t.Fatalf("not dropped as a slow client: closed %v, reason %v", cl.closed, cl.reason)
	}
}

// finalSaves counts the final snapshots of character id.
func (g *pvpWorld) finalSaves(id int64) int {
	n := 0
	for _, s := range g.saves {
		if s.CharacterID == id && s.Final {
			n++
		}
	}
	return n
}

// An attacker that stops reading its socket: cut off, but link-dead in the world. Her
// poison keeps hurting as her attack (it renews her lock), the gateway's Leave for the
// closed connection and a command it sent late change nothing, and she is saved and leaves
// once the lock ends. Her connection is closed once.
func TestPvPSlowAttackerStaysLinkDead(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.poison(a, b, 8)
	g.cutSlow(ca)
	if g.w.PlayerByCharacter(a.CharacterID()) != a || !a.LinkDead() || g.finalSaves(a.CharacterID()) != 0 {
		t.Fatalf("Ana in the world %v, link-dead %v, final saves %d", g.w.PlayerByCharacter(a.CharacterID()) == a,
			a.LinkDead(), g.finalSaves(a.CharacterID()))
	}
	g.sim.Command(g.w.Leave(ca)) // the gateway, once the socket is closed
	g.input(ca, walk(W))         // read before the close, queued after it
	cb.take()
	g.sim.RunFor(3 * time.Second)
	if g.w.PlayerByCharacter(a.CharacterID()) != a || a.Pos() != pos(10, 10) {
		t.Fatalf("Ana in the world %v at %v", g.w.PlayerByCharacter(a.CharacterID()) == a, a.Pos())
	}
	if hits := damageTexts(cb.take()); !allTen(hits) {
		t.Fatalf("Ana's poison while she is link-dead: %v", hits)
	}
	// The poison's last hit is at about 8 s, and its lock lasts 10 s more.
	g.sim.RunFor(16 * time.Second)
	if g.w.PlayerByCharacter(a.CharacterID()) != nil || g.finalSaves(a.CharacterID()) != 1 || ca.closes != 1 {
		t.Fatalf("after the lock: in the world %v, final saves %d, closes %d",
			g.w.PlayerByCharacter(a.CharacterID()) != nil, g.finalSaves(a.CharacterID()), ca.closes)
	}
}

// A victim cut off as a slow client in a fight stays in the world too: still attackable,
// the poison keeps hurting her there instead of leaving with her.
func TestPvPSlowVictimStaysLinkDead(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	cb, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.poison(a, b, 8)
	g.cutSlow(cb)
	if g.w.PlayerByCharacter(b.CharacterID()) != b || !b.LinkDead() || g.finalSaves(b.CharacterID()) != 0 {
		t.Fatalf("Bea in the world %v, link-dead %v", g.w.PlayerByCharacter(b.CharacterID()) == b, b.LinkDead())
	}
	before, _ := b.Health()
	g.hit(a, b)
	g.sim.RunFor(2 * time.Second)
	if cur, _ := b.Health(); cur >= before {
		t.Fatalf("Bea %d → %d while link-dead", before, cur)
	}
}

// A password reset still cuts every connection of the account (security), but a character
// under the PvP lock stays in the world link-dead until the lock ends; the account's other
// character, out of any fight, leaves as before. A login with the new password takes the
// link-dead one over, lock included, without closing its old connection again.
func TestKickAccountKeepsLockedLinkDead(t *testing.T) {
	g := newPvPCond(t, nil)
	const account = 77_001
	same := func(c *session.Character) { c.AccountID = account }
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0, same)
	cc, c := g.fighter("Cid", 0, 30, 30, 30, 0, same)
	_, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.sim.Command(g.w.KickAccount(account))
	g.sim.Step()
	for _, cl := range []*fakeClient{ca, cc} {
		if !cl.closed || cl.reason != pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED || cl.closes != 1 {
			t.Fatalf("closed %v, reason %v, closes %d", cl.closed, cl.reason, cl.closes)
		}
	}
	if g.w.PlayerByCharacter(c.CharacterID()) != nil || g.finalSaves(c.CharacterID()) != 1 {
		t.Fatal("Cid, out of any fight, is still in the world")
	}
	if g.w.PlayerByCharacter(a.CharacterID()) != a || !a.LinkDead() || g.finalSaves(a.CharacterID()) != 0 {
		t.Fatalf("Ana in the world %v, link-dead %v", g.w.PlayerByCharacter(a.CharacterID()) == a, a.LinkDead())
	}
	g.sim.Command(g.w.Leave(ca))
	g.sim.Command(g.w.KickAccount(account)) // a second reset: her connection is closed already
	g.sim.Step()
	if g.w.PlayerByCharacter(a.CharacterID()) != a || ca.closes != 1 {
		t.Fatalf("after the gateway's Leave and a second reset: in the world %v, closes %d",
			g.w.PlayerByCharacter(a.CharacterID()) == a, ca.closes)
	}

	ca2, a2 := g.fighter("Ana", a.CharacterID(), 10, 10, 30, 0, same)
	if a2 == a || a2.LinkDead() || ca.closes != 1 {
		t.Fatalf("took over %v, link-dead %v, old connection closed %d times", a2 != a, a2.LinkDead(), ca.closes)
	}
	g.input(ca2, logout())
	g.sim.Step()
	if keys := sysKeys(ca2.take()); ca2.closed || !slices.Contains(keys, "pvp.logout_locked") {
		t.Fatalf("the lock did not carry over: %v", keys)
	}
}

// A password reset of a character already link-dead (it closed the connection itself)
// keeps it in the world: the loop closes that connection once, now, and not again when the
// lock ends.
func TestKickAccountOfLinkDead(t *testing.T) {
	g := newPvPCond(t, nil)
	ca, a := g.fighter("Ana", 0, 10, 10, 30, 0)
	_, b := g.fighter("Bea", 0, 11, 10, 30, 0)
	g.unsafe(ca)
	g.hit(a, b)
	g.sim.Command(g.w.Leave(ca))
	g.sim.Step()
	if !a.LinkDead() || ca.closes != 0 {
		t.Fatalf("link-dead %v, closes %d", a.LinkDead(), ca.closes)
	}
	g.sim.Command(g.w.KickAccount(a.CharacterID())) // fighter: account = character
	g.sim.Step()
	if g.w.PlayerByCharacter(a.CharacterID()) != a || ca.closes != 1 ||
		ca.reason != pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED {
		t.Fatalf("in the world %v, closes %d, reason %v", g.w.PlayerByCharacter(a.CharacterID()) == a, ca.closes, ca.reason)
	}
	g.sim.RunFor(12 * time.Second) // the lock of her hit ends
	if g.w.PlayerByCharacter(a.CharacterID()) != nil || g.finalSaves(a.CharacterID()) != 1 || ca.closes != 1 {
		t.Fatalf("after the lock: in the world %v, final saves %d, closes %d",
			g.w.PlayerByCharacter(a.CharacterID()) != nil, g.finalSaves(a.CharacterID()), ca.closes)
	}
}

// Without a lock the server-side disconnects are unchanged: out of the world at once.
func TestPvPUnlockedDisconnectsLeave(t *testing.T) {
	g := newPvPCond(t, nil)
	cs, s := g.fighter("Sol", 0, 10, 10, 30, 0)
	ck, k := g.fighter("Kai", 0, 20, 20, 30, 0)
	g.cutSlow(cs)
	g.sim.Command(g.w.KickAccount(k.CharacterID())) // fighter: account = character
	g.sim.Step()
	for _, p := range []*session.Player{s, k} {
		if g.w.PlayerByCharacter(p.CharacterID()) != nil || p.LinkDead() || g.finalSaves(p.CharacterID()) != 1 {
			t.Fatalf("%d: in the world %v, link-dead %v", p.CharacterID(), g.w.PlayerByCharacter(p.CharacterID()) != nil, p.LinkDead())
		}
	}
	if !ck.closed || ck.reason != pb.DisconnectReason_DISCONNECT_REASON_PASSWORD_CHANGED {
		t.Fatalf("Kai closed %v, reason %v", ck.closed, ck.reason)
	}
}
