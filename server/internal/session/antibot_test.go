package session_test

import (
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// antibotHarness is the admin harness with the detection of data/balance.yaml (combat
// blocks for 12 s, like travel.combat_block_ms).
func antibotHarness(t *testing.T) *adminHarness {
	t.Helper()
	b, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	return newAdminHarness(t, func(c *session.Config) {
		c.Balance.AntiBot = b.AntiBot
		c.Balance.Travel.CombatBlockMs = 12000
	})
}

// actions returns the system:antibot audit entries of the jobs since the last call.
func (a *adminHarness) antibotActions() []string {
	var out []string
	for _, j := range a.takeJobs() {
		if j.Audit.ActorName == "system:antibot" {
			out = append(out, j.Audit.Action+":"+j.Audit.Result)
		}
	}
	return out
}

// presence waits for a PresenceCheck to cl, up to the configured delay.
func (a *adminHarness) presence(cl *fakeClient) *pb.PresenceCheck {
	a.t.Helper()
	var got *pb.PresenceCheck
	a.sim.RunUntil(func() bool {
		for _, e := range cl.take() {
			if c := e.GetPresenceCheck(); c != nil {
				got = c
			}
		}
		return got != nil
	}, sim.MaxSeconds(400))
	return got
}

func answer(c *pb.PresenceCheck, right bool) *pb.ClientMessage {
	want := "presence.option." + c.GetQuestion().GetKey()[len("presence.question."):]
	var id uint32
	for _, o := range c.GetOptions() {
		if (o.GetText().GetKey() == want) == right {
			id = o.GetOptionId()
		}
	}
	return &pb.ClientMessage{Message: &pb.ClientMessage_PresenceAnswer{PresenceAnswer: &pb.PresenceAnswer{CheckId: c.GetCheckId(), OptionId: id}}}
}

// T4.1: the responses are graded. Log and notify; past the suspension threshold without
// a failed presence check, only a check; a wrong answer adds points and tells the GMs
// (same reply as a right one); then the next evaluation suspends.
func TestAntiBotGradedResponses(t *testing.T) {
	a := antibotHarness(t)
	cl, p := a.joinAs("Suspect", session.RolePlayer, pos(5, 5))
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	a.takeJobs()
	evalAt := func(score float64) {
		a.sim.Command(gameFunc(func() { a.w.SetSuspicionForTest(p, score); a.w.EvaluateNowForTest(p) }))
		a.sim.RunTicks(2)
	}
	evalAt(260) // past log and notify
	if got := a.antibotActions(); !slices.Equal(got, []string{"bot_suspect:log", "bot_suspect:notify"}) {
		t.Fatalf("at 260: %v", got)
	}
	if k := sysKeys(gm.take()); !slices.Contains(k, "gm.bot_suspect") {
		t.Fatalf("GM heard %v", k)
	}
	evalAt(700) // past suspend, but no failed check: only a check
	c := a.presence(cl)
	if c == nil || len(c.GetOptions()) != 4 || c.GetTimeoutMs() != 600000 {
		t.Fatalf("check %v", c)
	}
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:sent"}) {
		t.Fatalf("past suspend without a failed check: %v", got)
	}
	a.input(cl, answer(c, false))
	a.sim.Step()
	if k := sysKeys(cl.take()); !slices.Equal(k, []string{"presence.thanks"}) {
		t.Fatalf("reply to a wrong answer %v", k)
	}
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:failed_wrong"}) {
		t.Fatalf("after a wrong answer: %v", got)
	}
	if k := sysKeys(gm.take()); !slices.Contains(k, "gm.presence_failed") {
		t.Fatalf("GM heard %v", k)
	}
	a.sim.Command(gameFunc(func() { a.w.EvaluateNowForTest(p) }))
	a.sim.RunTicks(2)
	js := a.takeJobs()
	if len(js) != 1 || js[0].Kind != session.AdminBan || js[0].TargetName != "Suspect" ||
		js[0].ActorRole != session.RoleGM || js[0].Audit.ActorName != "system:antibot" ||
		js[0].Until.Sub(a.sim.Now()) > 24*time.Hour {
		t.Fatalf("suspension %+v", js)
	}
}

// A failed check never suspends below the threshold; a right answer halves the score and
// gets the same reply. A check is never asked in combat or on a no-logout tile.
func TestPresenceCheckIsSafe(t *testing.T) {
	a := antibotHarness(t)
	s := a.w.Map().SectorAt(pos(8, 5))
	s.Flags[5*world.SectorSize+8] |= world.FlagNoLogout
	cl, p := a.joinAs("Guard", session.RolePlayer, pos(8, 5)) // on a no-logout tile
	a.sim.Command(gameFunc(func() { a.w.SetSuspicionForTest(p, 450); a.w.EvaluateNowForTest(p) }))
	a.sim.RunFor(6 * time.Minute) // past the delay: still not asked
	for _, e := range cl.take() {
		if e.GetPresenceCheck() != nil {
			t.Fatal("asked on a no-logout tile")
		}
	}
	a.input(cl, walk(W))
	a.sim.Command(ctxFunc(func(ctx *game.TickContext) { a.w.HurtForTest(ctx, p, 1) })) // and in combat
	a.sim.RunFor(5 * time.Second)
	for _, e := range cl.take() {
		if e.GetPresenceCheck() != nil {
			t.Fatal("asked in combat")
		}
	}
	c := a.presence(cl) // once out of combat
	a.takeJobs()
	// A stale or forged check id does nothing; the right answer halves the score.
	a.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_PresenceAnswer{PresenceAnswer: &pb.PresenceAnswer{CheckId: c.GetCheckId() + 1}}})
	a.sim.Step()
	if k := sysKeys(cl.take()); len(k) != 0 {
		t.Fatalf("forged id: %v", k)
	}
	a.input(cl, answer(c, true))
	a.sim.Step()
	if k := sysKeys(cl.take()); !slices.Equal(k, []string{"presence.thanks"}) {
		t.Fatalf("reply to a right answer %v", k)
	}
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:passed"}) {
		t.Fatalf("after a right answer: %v", got)
	}
	if sc, _, _ := a.w.SuspicionForTest(p); sc > 230 {
		t.Fatalf("score %.0f after passing", sc)
	}
}

// A GM asks a check by name; a pending check survives a relogin with the time it had
// left, and expires (failure, no suspension below the threshold) only while online.
func TestPresenceByGMAndRelogin(t *testing.T) {
	a := antibotHarness(t)
	pl, p := a.joinAs("Player", session.RolePlayer, pos(5, 5))
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	if k := a.cmd(pl, "/presence Warden"); !slices.Equal(k, []string{"command.unknown"}) {
		t.Fatalf("player /presence: %v", k)
	}
	if k := a.cmd(gm, "/presence Player"); !slices.Equal(k, []string{"gm.presence_sent"}) {
		t.Fatalf("GM /presence: %v", k)
	}
	c := a.presence(pl)
	if c == nil {
		t.Fatal("no check")
	}
	a.sim.RunFor(4 * time.Minute)
	a.input(pl, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	a.sim.RunFor(time.Hour) // offline: the check does not expire
	a.takeJobs()
	c2 := &fakeClient{}
	a.sim.Command(a.w.Join(session.Character{ID: p.CharacterID(), AccountID: p.CharacterID(), Name: "Player",
		Vocation: "guardian", Level: 1, Health: 145, Mana: 20, HasPos: true, Pos: pos(5, 5)}, c2))
	a.sim.Step()
	again := a.presence(c2)
	if again == nil || again.GetCheckId() != c.GetCheckId() || again.GetTimeoutMs() > 360000 || again.GetTimeoutMs() < 300000 {
		t.Fatalf("resumed check %v", again)
	}
	a.sim.RunFor(7 * time.Minute)
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:failed_timeout", "bot_suspect:log"}) { // +150 points: past log
		t.Fatalf("after the timeout: %v", got)
	}
	for _, j := range a.takeJobs() {
		if j.Kind == session.AdminBan {
			t.Fatal("a failed check suspended below the threshold")
		}
	}
}

// Staff characters are not evaluated, and a GM cannot ask a check of its equals.
func TestAntiBotSkipsStaff(t *testing.T) {
	a := antibotHarness(t)
	gm, g := a.joinAs("Warden", session.RoleGM, pos(5, 5))
	a.joinAs("Keeper", session.RoleGM, pos(7, 5))
	a.sim.Command(gameFunc(func() { a.w.SetSuspicionForTest(g, 900); a.w.EvaluateNowForTest(g) }))
	a.sim.RunTicks(3)
	if got := a.antibotActions(); len(got) != 0 {
		t.Fatalf("staff evaluated: %v", got)
	}
	if k := a.cmd(gm, "/presence Keeper"); !slices.Equal(k, []string{"gm.protected"}) {
		t.Fatalf("GM on a GM: %v", k)
	}
}
