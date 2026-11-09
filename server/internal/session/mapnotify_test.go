package session_test

import (
	"slices"
	"testing"
	"time"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// mapNotices are the map notices in evs as "key id title|count".
func mapNotices(evs []*pb.ServerMessage) []string {
	var out []string
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		l := m.GetLocalized()
		if k := l.GetKey(); k == "gm.map_submission" || k == "gm.map_submissions" {
			s := k
			for _, p := range l.GetParams() {
				if p.GetName() == "count" {
					s += " " + itoa(int(p.GetNumber()))
				} else {
					s += " " + p.GetText()
				}
			}
			out = append(out, s)
		}
	}
	return out
}

// T4.5: a map submission tells the online gm and admin characters (not players), with its
// number and title only; a burst after it is grouped into one notice a minute later.
func TestMapSubmissionNotifiesGMs(t *testing.T) {
	a := newAdminHarness(t)
	pl, _ := a.joinAs("Player", session.RolePlayer, pos(5, 5))
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(7, 5))
	adm, _ := a.joinAs("Root", session.RoleAdmin, pos(9, 5))
	for _, c := range []*fakeClient{pl, gm, adm} {
		c.take()
	}
	a.sim.Command(a.w.MapSubmitted(7, "Puerto norte"))
	a.sim.Step()
	want := []string{"gm.map_submission 7 Puerto norte"}
	for _, c := range []*fakeClient{gm, adm} {
		if got := mapNotices(c.take()); !slices.Equal(got, want) {
			t.Fatalf("staff heard %v", got)
		}
	}
	if got := mapNotices(pl.take()); got != nil {
		t.Fatalf("a player heard %v", got)
	}

	for id := int64(8); id <= 10; id++ { // a burst: counted, not sent
		a.sim.Command(a.w.MapSubmitted(id, "spam"))
	}
	a.sim.RunFor(30 * time.Second)
	if got := mapNotices(gm.take()); got != nil {
		t.Fatalf("burst sent at once: %v", got)
	}
	a.sim.RunFor(31 * time.Second)
	if got := mapNotices(gm.take()); !slices.Equal(got, []string{"gm.map_submissions 3 10"}) {
		t.Fatalf("grouped notice %v", got)
	}
	if got := mapNotices(pl.take()); got != nil {
		t.Fatalf("a player heard %v", got)
	}
}
