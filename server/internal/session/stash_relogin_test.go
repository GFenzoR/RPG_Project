package session_test

import (
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// Logging in again with a character that is online replaces it: the stash in memory must
// not leave between the end of that login's read and the new player taking it, or the
// new player rebuilds it from the read, older than a write the database already acked
// (review of the stash, blocking 1: a sword taken out in that window came back).
func TestStashReloginKeepsTheStashInMemory(t *testing.T) {
	d := newStashRows()
	h := newStashHarness(t, 30, &d.log)
	ca, a := h.account(1, 100, "Ana", pos(1, 1), []session.ItemState{stack(swordID, 1, 0)})
	h.sim.Command(h.w.LoginStarted(1, 100)) // Ana again, elsewhere: its read has the sword
	h.sim.Step()
	h.open(ca)
	if u := lastStash(h.send(ca, stashWithdraw(0, swordID, 0, nil))); u.GetResult() != pb.StashResult_STASH_RESULT_OK ||
		h.w.CountItem(a, "test_sword") != 1 {
		t.Fatalf("Ana did not take the sword: %v", u)
	}
	d.writeAll(h.harness) // the withdrawal is acked: nothing pending
	// The second login joins with the stale read: it replaces Ana, the only one online.
	cb, b := h.account(1, 100, "Ana", pos(1, 1), []session.ItemState{stack(swordID, 1, 0)})
	if n := h.w.CountItem(b, "test_sword") + h.stashCount(100, swordID); n != 1 {
		t.Fatalf("after logging in again the sword is in %d places (Ana %d, stash %d)", n,
			h.w.CountItem(b, "test_sword"), h.stashCount(100, swordID))
	}
	// And nothing the new player writes puts it back in the database's stash.
	pack := openPack(t, h.harness, cb)
	h.open(cb)
	h.send(cb, stashDeposit(inContainer(pack, 0), swordID, 1))
	d.writeAll(h.harness)
	if n := d.total(100, swordID, 1); n != 1 {
		t.Fatalf("the database holds the sword %d times", n)
	}
}

// An equipable saved in the stash without an attribute rolls one when the stash loads:
// the stash is written at once with it, so leaving and coming back does not roll another
// (review of the stash, important 2).
func TestStashRollIsWrittenAtJoin(t *testing.T) {
	d := newStashRows()
	h := newStashHarness(t, 30, &d.log, withAttributes(t))
	ca, _ := h.account(1, 100, "Ana", pos(1, 1), []session.ItemState{stack(swordID, 1, 0)})
	var mem session.Mods
	if items := h.w.StashItems(100); len(items) != 1 || items[0].Mods.Attr == "" {
		t.Fatalf("the sword did not roll an attribute: %v", items)
	} else {
		mem = items[0].Mods
	}
	d.writeAll(h.harness)
	if got := d.stash[100]; len(got) != 1 || got[0].Mods != mem {
		t.Fatalf("the stash in the database %v, not the rolled %v", got, mem)
	}
	h.sim.Command(h.w.Leave(ca))
	h.sim.Step()
	d.writeAll(h.harness)
	if h.w.StashLoaded(100) {
		t.Fatal("the stash stayed in memory")
	}
	// The next login reads what was written: the same attribute, and nothing rolls again.
	n := len(d.log.jobs)
	h.account(1, 100, "Ana", pos(1, 1), d.stash[100])
	if items := h.w.StashItems(100); len(items) != 1 || items[0].Mods != mem {
		t.Fatalf("the attribute changed at the next login: %v, want %v", items, mem)
	}
	for _, j := range d.log.jobs[n:] {
		if j.Transfer != nil && len(j.Transfer.Stash) > 0 {
			t.Fatal("a stash that rolled nothing was written at join")
		}
	}
}

// A stack with mods is one instance: it goes in whole (it comes out whole), never split
// into two copies of its mods (review of the stash, minor).
func TestStashKeepsAStackWithModsWhole(t *testing.T) {
	h := newStashHarness(t, 30, nil)
	refined := session.ItemState{ItemID: salveID, Count: 10, Mods: session.Mods{Refine: 1}}
	cl, _ := h.account(1, 100, "Ana", pos(1, 1), nil, refined)
	h.open(cl)
	pack := openPack(t, h.harness, cl)
	if u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 0), salveID, 4))); u.GetResult() != pb.StashResult_STASH_RESULT_NOT_POSSIBLE {
		t.Fatalf("part of a stack with mods went in: %v", u)
	}
	if u := lastStash(h.send(cl, stashDeposit(inContainer(pack, 0), salveID, 10))); u.GetResult() != pb.StashResult_STASH_RESULT_OK {
		t.Fatalf("the whole stack with mods did not go in: %v", u)
	}
	if items := h.w.StashItems(100); len(items) != 1 || items[0].Count != 10 || items[0].Mods.Refine != 1 {
		t.Fatalf("the stash: %v", items)
	}
}
