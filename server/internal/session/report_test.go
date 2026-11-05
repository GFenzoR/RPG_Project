package session_test

import (
	"slices"
	"testing"
	"time"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

func reportMsg(id uint32, reason string) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_ReportPlayer{ReportPlayer: &pb.ReportPlayer{CreatureId: id, Reason: reason}}}
}

// T4.1: "/report Name reason" and the report button queue a report with the context
// the server builds (both positions and the reported player's recent events); GMs
// online hear of it. Everything is audited.
func TestReportCommandAndContext(t *testing.T) {
	a := newAdminHarness(t)
	ana, pa := a.joinAs("Ana", session.RolePlayer, pos(5, 5))
	bob, pb2 := a.joinAs("Bob Rude", session.RolePlayer, pos(8, 5))
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	a.input(bob, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "you are all noobs"))
	a.sim.Step()
	a.sim.RunTicks(10)
	gm.take()

	if keys := a.cmd(ana, "/report Bob Rude insults in the chat"); !slices.Equal(keys, []string{"report.sent"}) {
		t.Fatalf("report: %v", keys)
	}
	js := a.takeJobs()
	if len(js) != 1 || js[0].Kind != session.AdminReport || js[0].Report == nil {
		t.Fatalf("jobs %+v", js)
	}
	j := js[0]
	if e := j.Audit; e.Action != "report" || e.ActorCharacterID != pa.CharacterID() || e.TargetCharacterID != pb2.CharacterID() ||
		e.TargetName != "Bob Rude" || e.Args["reason"] != "insults in the chat" || e.Result != "ok" {
		t.Fatalf("audit %+v", e)
	}
	rc := j.Report.Context
	if j.Report.Reason != "insults in the chat" || rc.ReporterPos != (session.ReportPos{X: 5, Y: 5, Z: 7}) ||
		rc.TargetPos != (session.ReportPos{X: 8, Y: 5, Z: 7}) || rc.TargetLevel != 1 {
		t.Fatalf("report %+v", j.Report)
	}
	if len(rc.Events) != 1 || rc.Events[0].Kind != "chat" || rc.Events[0].Ref != "you are all noobs" || rc.Events[0].AgoMs != 550 {
		t.Fatalf("events %+v", rc.Events)
	}
	if keys := sysKeys(gm.take()); !slices.Equal(keys, []string{"gm.report_new"}) {
		t.Fatalf("GM heard %v", keys)
	}

	// The button: only a player the reporter sees.
	a.input(ana, reportMsg(pb2.ID(), "spam"))
	a.sim.Step()
	if keys := sysKeys(ana.take()); !slices.Equal(keys, []string{"report.same_target"}) { // same target within the hour
		t.Fatalf("second report of Bob: %v", keys)
	}
	far, pf := a.joinAs("Faraway", session.RolePlayer, pos(35, 10))
	_ = far
	a.input(ana, reportMsg(pf.ID(), "spam"))
	a.sim.Step()
	if keys := sysKeys(ana.take()); !slices.Equal(keys, []string{"report.not_visible"}) || len(a.takeJobs()) != 0 {
		t.Fatalf("report of an unseen player: %v", keys)
	}
	for line, want := range map[string]string{
		"/report":            "report.usage",
		"/report Ana spam":   "report.self",
		"/report Nobody x y": "report.offline",
		"/report Warden ":    "report.usage",
	} {
		if keys := a.cmd(ana, line); !slices.Equal(keys, []string{want}) {
			t.Errorf("%q: %v, want %s", line, keys, want)
		}
	}
	if len(a.takeJobs()) != 0 {
		t.Fatal("invalid reports were queued")
	}
}

// Reports are rate limited per account (balance reports.burst / refill_ms), not per
// character, so a second character of the account does not reset it.
func TestReportRateLimitPerAccount(t *testing.T) {
	a := newAdminHarness(t)
	ana, _ := a.joinAs("Ana", session.RolePlayer, pos(5, 5))
	for _, n := range []string{"Bob", "Cid", "Dan"} {
		a.joinAs(n, session.RolePlayer, pos(6+len(a.w.Players()), 5))
	}
	if k := a.cmd(ana, "/report Bob spam"); k[0] != "report.sent" {
		t.Fatal(k)
	}
	if k := a.cmd(ana, "/report Cid spam"); k[0] != "report.sent" {
		t.Fatal(k)
	}
	if k := a.cmd(ana, "/report Dan spam"); !slices.Equal(k, []string{"report.too_fast"}) { // burst 2
		t.Fatalf("third report: %v", k)
	}
	a.sim.RunFor(time.Minute) // refill_ms 60000
	if k := a.cmd(ana, "/report Dan spam"); k[0] != "report.sent" {
		t.Fatalf("after the refill: %v", k)
	}
	if n := len(a.takeJobs()); n != 3 {
		t.Fatalf("%d reports queued", n)
	}
}

// GMs list and close the queue; players do not have the commands.
func TestReportQueueCommands(t *testing.T) {
	a := newAdminHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	pl, _ := a.joinAs("Ana", session.RolePlayer, pos(5, 5))
	if k := a.cmd(pl, "/reports"); !slices.Equal(k, []string{"command.unknown"}) {
		t.Fatalf("player /reports: %v", k)
	}
	a.cmd(gm, "/reports")
	js := a.takeJobs()
	if len(js) != 1 || js[0].Kind != session.AdminListReports || js[0].Audit.Action != "list_reports" {
		t.Fatalf("jobs %+v", js)
	}
	at := a.sim.Now().Add(-5 * time.Minute)
	a.sim.Command(a.w.AdminDone(session.AdminResult{ID: js[0].ID, Result: session.AdminOK, Reports: []session.ReportSummary{
		{ID: 4, At: at, Reporter: "Ana", Target: "Bob", Reason: "spam"}, {ID: 5, At: at, Reporter: "Cid", Target: "Bob", Reason: "bot"}}}))
	a.sim.Step()
	if k := sysKeys(gm.take()); !slices.Equal(k, []string{"gm.reports", "gm.report_entry", "gm.report_entry"}) {
		t.Fatalf("list: %v", k)
	}
	if k := a.cmd(gm, "/closereport 4"); !slices.Equal(k, []string{"gm.usage"}) {
		t.Fatalf("no resolution: %v", k)
	}
	a.takeJobs() // the invalid attempt's audit entry
	a.cmd(gm, "/closereport 4 warned the player")
	js = a.takeJobs()
	if len(js) != 1 || js[0].Kind != session.AdminCloseReport || js[0].ReportID != 4 || js[0].Reason != "warned the player" ||
		js[0].Audit.Args["id"] != "4" {
		t.Fatalf("close jobs %+v", js)
	}
	for res, want := range map[string]string{session.AdminOK: "gm.report_closed", session.AdminNotFound: "gm.report_not_found",
		session.AdminNotOpen: "gm.report_not_open", session.AdminFailed: "gm.failed"} {
		a.cmd(gm, "/closereport 4 again")
		j := a.takeJobs()[0]
		a.sim.Command(a.w.AdminDone(session.AdminResult{ID: j.ID, Result: res, ReportID: 4}))
		a.sim.Step()
		if k := sysKeys(gm.take()); !slices.Equal(k, []string{want}) {
			t.Errorf("%s: %v", res, k)
		}
	}
}
