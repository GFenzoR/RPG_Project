package session_test

import (
	"slices"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

func reportMsg(id uint32, reason string) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_ReportPlayer{ReportPlayer: &pb.ReportPlayer{CreatureId: id, Reason: reason}}}
}

// T4.1: "/report Name reason" and the report button queue a report with the context
// the server builds (both positions and the reported player's recent events); GMs
// online hear of it. Everything is audited.
func TestReportCommandAndContext(t *testing.T) {
	// Every /report past the usage check spends quota (the invalid lines below too).
	a := newAdminHarness(t, func(c *session.Config) { c.Balance.Reports.Burst = 20 })
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

// /report spends the quota before resolving the name: past the burst, an online name, an
// offline one and an invisible one all answer report.too_fast, and before it an
// invisible player the reporter does not see looks offline (T4.1).
func TestReportIsNoOnlineOracle(t *testing.T) {
	a := newAdminHarness(t)
	ana, _ := a.joinAs("Ana", session.RolePlayer, pos(5, 5))
	_, ghost := a.joinAs("Ghost", session.RolePlayer, pos(35, 5))
	a.sim.Command(gameFunc(func() { a.w.SetInvisibleForTest(ghost, true) }))
	a.sim.Step()
	if k := a.cmd(ana, "/report Ghost bot"); !slices.Equal(k, []string{"report.offline"}) {
		t.Fatalf("invisible unseen target: %v", k)
	}
	a.cmd(ana, "/report Nobody spam") // the burst (2) is spent
	for _, line := range []string{"/report Ghost bot", "/report Nobody spam", "/report Ana x"} {
		if k := a.cmd(ana, line); !slices.Equal(k, []string{"report.too_fast"}) {
			t.Errorf("%q past the burst: %v", line, k)
		}
	}
	if len(a.takeJobs()) != 0 {
		t.Fatal("a report was queued")
	}
}

// The reported player cannot push its chat line out of the report's context in a tick:
// chat has its own ring, and toggling the same target is not a new event (T4.1).
func TestReportKeepsChatLine(t *testing.T) {
	var jobs []session.AdminJob
	m := worldtest.Open(t, 0, 0, 64, 64)
	m.Islands()[0].Spawns = []world.Spawn{spawnAt("wolf", 30, 30, 0, 600)}
	wolf := wolfDef()
	wolf.Behavior.Aggressive = false
	h := newHarness(t, m, func(c *session.Config) {
		c.Monsters = content.Monsters{"wolf": wolf}
		c.Items = testItems()
		c.Admin = func(j session.AdminJob) bool { jobs = append(jobs, j); return true }
	})
	ana, _ := h.join("Ana", at(26, 30))
	bob, _ := h.join("Bob", at(26, 31))
	rude, pr := h.join("Rude", at(28, 30))
	h.sim.Step()
	w := onlyMonster(t, h)
	h.input(rude, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "abusive line"))
	h.sim.Step()
	count := func(j session.AdminJob) (attacks int, chat bool) {
		for _, e := range j.Report.Context.Events {
			switch {
			case e.Kind == "chat" && e.Ref == "abusive line":
				chat = true
			case e.Kind == "attack":
				attacks++
			}
		}
		return attacks, chat
	}
	for range 20 { // toggling the same target is one event
		h.input(rude, setTarget(w.ID()))
		h.input(rude, setTarget(0))
	}
	h.sim.Step()
	h.input(bob, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/report Rude abuse"))
	h.sim.Step()
	if len(jobs) != 1 || jobs[0].Report == nil {
		t.Fatalf("jobs %+v", jobs)
	}
	if attacks, chat := count(jobs[0]); !chat || attacks != 1 {
		t.Fatalf("after the toggles: chat kept %v, attack events %d", chat, attacks)
	}
	h.sim.Command(gameFunc(func() { // a flood of other events (economy)
		for range 30 {
			h.w.GiveForTest(pr, "copper_coin", 1)
		}
	}))
	h.sim.Step()
	h.input(ana, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "/report Rude abuse"))
	h.sim.Step()
	if len(jobs) != 2 {
		t.Fatalf("jobs %+v", jobs)
	}
	if _, chat := count(jobs[1]); !chat {
		t.Fatalf("after the flood the chat line is gone: %+v", jobs[1].Report.Context.Events)
	}
}

// The button spends quota only on a report that is filed: answers that reveal nothing
// (a player out of view, the same target again) leave it intact (T4.1).
func TestReportButtonKeepsQuota(t *testing.T) {
	a := newAdminHarness(t, func(c *session.Config) { c.Balance.Reports.Burst = 3 })
	ana, _ := a.joinAs("Ana", session.RolePlayer, pos(5, 5))
	_, bob := a.joinAs("Bob", session.RolePlayer, pos(7, 5))
	_, gone := a.joinAs("Gone", session.RolePlayer, pos(35, 5)) // out of view
	_, carl := a.joinAs("Carl", session.RolePlayer, pos(5, 7))
	send := func(id uint32) []string {
		ana.take()
		a.input(ana, reportMsg(id, "bot"))
		a.sim.Step()
		return sysKeys(ana.take())
	}
	if k := send(bob.ID()); !slices.Equal(k, []string{"report.sent"}) {
		t.Fatalf("first report: %v", k)
	}
	for range 3 {
		if k := send(gone.ID()); !slices.Equal(k, []string{"report.not_visible"}) {
			t.Fatalf("out of view: %v", k)
		}
	}
	if k := send(bob.ID()); !slices.Equal(k, []string{"report.same_target"}) {
		t.Fatalf("same target: %v", k)
	}
	if k := send(carl.ID()); !slices.Equal(k, []string{"report.sent"}) {
		t.Fatalf("a visible player after refusals: %v", k)
	}
	if n := len(a.takeJobs()); n != 2 {
		t.Fatalf("%d reports queued", n)
	}
}
