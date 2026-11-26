package session_test

import (
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// welcomeOptions is the GameOptions of the Welcome in evs.
func welcomeOptions(t *testing.T, evs []*pb.ServerMessage) *pb.GameOptions {
	t.Helper()
	ws := find(evs, (*pb.ServerMessage).GetWelcome)
	if len(ws) != 1 || ws[0].GetOptions() == nil {
		t.Fatalf("want one Welcome with options, got %v", ws)
	}
	return ws[0].GetOptions()
}

func wantOptions(t *testing.T, when string, got *pb.GameOptions, stance pb.FightStance, chase, safe bool) {
	t.Helper()
	if got.GetStance() != stance || got.GetChase() != chase || got.GetSafeMode() != safe {
		t.Errorf("%s: options %v, want stance %v chase %v safe %v", when, got, stance, chase, safe)
	}
}

// What a player picks for a character (fight stance, chase, safe mode) travels in every
// snapshot, comes back at the next login (from the database row, from the unsaved
// snapshot of a quick relog and from the online player a second login replaces), and the
// Welcome tells the client. A character that never chose gets the defaults.
func TestGameOptionsAreSavedAndRestored(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: "Ana", Vocation: "guardian", Level: 1, Health: 145,
		HasPos: true, Pos: pos(10, 10)}
	cl, _ := h.joinChar(c)
	wantOptions(t, "first login", welcomeOptions(t, cl.take()), pb.FightStance_FIGHT_STANCE_BALANCED, false, true)

	h.send(cl, fightMode(pb.FightStance_FIGHT_STANCE_DEFENSIVE, true))
	h.send(cl, safeMode(false))

	// A second login while online takes the options of the player in memory.
	second := &fakeClient{}
	h.sim.Command(h.joinCmd(c, second))
	h.sim.Step()
	wantOptions(t, "login while online", welcomeOptions(t, second.take()), pb.FightStance_FIGHT_STANCE_DEFENSIVE, true, false)

	// The logout's snapshot carries them, and a quick relog reads them from it.
	h.sim.Command(h.w.Leave(second))
	h.sim.Step()
	last := h.saves[len(h.saves)-1]
	if !last.Final || last.Options != (session.GameOptions{Stance: pb.FightStance_FIGHT_STANCE_DEFENSIVE, Chase: true, Unsafe: true}) {
		t.Fatalf("final snapshot options %+v (final %v)", last.Options, last.Final)
	}
	cl, _ = h.joinChar(c) // c is the stale database row: no options
	wantOptions(t, "quick relog", welcomeOptions(t, cl.take()), pb.FightStance_FIGHT_STANCE_DEFENSIVE, true, false)

	// A later login reads them from the database row.
	nextChar++
	d := session.Character{ID: nextChar, AccountID: nextChar, Name: "Bea", Vocation: "guardian", Level: 1, Health: 145,
		HasPos: true, Pos: pos(12, 10), Options: session.GameOptions{Stance: pb.FightStance_FIGHT_STANCE_OFFENSIVE, Chase: true}}
	cl, p := h.joinChar(d)
	wantOptions(t, "from the row", welcomeOptions(t, cl.take()), pb.FightStance_FIGHT_STANCE_OFFENSIVE, true, true)
	if !p.SafeMode() {
		t.Error("safe mode off for a character that never turned it off")
	}
}

// The server validates what it saves: a stance the protocol does not have changes
// nothing, and a saved one that is not valid (a row edited by hand) fights balanced.
func TestGameOptionsRejectInvalidStances(t *testing.T) {
	h := newHarness(t, worldtest.Open(t, 0, 0, 32, 32))
	nextChar++
	c := session.Character{ID: nextChar, AccountID: nextChar, Name: "Ana", Vocation: "guardian", Level: 1, Health: 145,
		HasPos: true, Pos: pos(10, 10), Options: session.GameOptions{Stance: 99, Chase: true}}
	cl, _ := h.joinChar(c)
	wantOptions(t, "junk row", welcomeOptions(t, cl.take()), pb.FightStance_FIGHT_STANCE_BALANCED, true, true)
	for _, s := range []pb.FightStance{pb.FightStance_FIGHT_STANCE_UNSPECIFIED, 4, -1} {
		h.send(cl, fightMode(s, false))
	}
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	if got := h.saves[len(h.saves)-1].Options; got != (session.GameOptions{Stance: pb.FightStance_FIGHT_STANCE_BALANCED, Chase: true}) {
		t.Errorf("options after invalid stances %+v, want balanced and still chasing", got)
	}
}

// Dying keeps the options: the player wakes at the temple fighting as it chose.
func TestGameOptionsSurviveDeath(t *testing.T) {
	h := monsterHarness(t, nil)
	cl, p := h.geared("Victim", 20, 0)
	h.send(cl, fightMode(pb.FightStance_FIGHT_STANCE_OFFENSIVE, true))
	h.send(cl, safeMode(false))
	h.kill(p)
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
	if got := h.saves[len(h.saves)-1].Options; got != (session.GameOptions{Stance: pb.FightStance_FIGHT_STANCE_OFFENSIVE, Chase: true, Unsafe: true}) {
		t.Errorf("options after dying %+v", got)
	}
}
