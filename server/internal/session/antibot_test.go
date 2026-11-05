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

// presence waits for a PresenceCheck to cl, up to the configured delay, while the player
// keeps playing (a check is only asked to someone active).
func (a *adminHarness) presence(cl *fakeClient) *pb.PresenceCheck {
	a.t.Helper()
	var got *pb.PresenceCheck
	n := 0
	a.sim.RunUntil(func() bool {
		if n++; n%600 == 0 {
			a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hm"))
		}
		for _, e := range cl.take() {
			if c := e.GetPresenceCheck(); c != nil {
				got = c
			}
		}
		return got != nil
	}, sim.MaxSeconds(400))
	return got
}

// playFor runs d while cl keeps playing (a chat line every 30 s).
func (a *adminHarness) playFor(cl *fakeClient, d time.Duration) {
	for left := d; left > 0; left -= 30 * time.Second {
		a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hm"))
		a.sim.RunFor(min(left, 30*time.Second))
	}
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

// setScore sets p's score and evaluates it on the next tick.
func (a *adminHarness) setScore(p *session.Player, score float64) {
	a.sim.Command(gameFunc(func() { a.w.SetSuspicionForTest(p, score); a.w.EvaluateNowForTest(p) }))
	a.sim.RunTicks(2)
}

func (a *adminHarness) bans() int {
	n := 0
	for _, j := range a.takeJobs() {
		if j.Kind == session.AdminBan {
			n++
		}
	}
	return n
}

// T4.1: the responses are graded. Log and notify; past the suspension threshold without
// a check yet, only a check; a wrong answer tells the GMs (same reply as a right one);
// then, with the score still past the threshold, the next evaluation suspends.
func TestAntiBotGradedResponses(t *testing.T) {
	a := antibotHarness(t)
	cl, p := a.joinAs("Suspect", session.RolePlayer, pos(5, 5))
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	a.takeJobs()
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi")) // active
	a.setScore(p, 260)                                      // past log and notify
	if got := a.antibotActions(); !slices.Equal(got, []string{"bot_suspect:log", "bot_suspect:notify"}) {
		t.Fatalf("at 260: %v", got)
	}
	if k := sysKeys(gm.take()); !slices.Contains(k, "gm.bot_suspect") {
		t.Fatalf("GM heard %v", k)
	}
	a.setScore(p, 700) // past suspend, but no check yet: only a check
	c := a.presence(cl)
	if c == nil || len(c.GetOptions()) != 4 || c.GetTimeoutMs() != 600000 {
		t.Fatalf("check %v", c)
	}
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:sent"}) {
		t.Fatalf("past suspend without a check: %v", got)
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
	a.setScore(p, 700)
	js := a.takeJobs()
	if len(js) != 1 || js[0].Kind != session.AdminBan || js[0].TargetName != "Suspect" || js[0].Reason != "antibot" ||
		js[0].ActorRole != session.RoleGM || js[0].Audit.ActorName != "system:antibot" ||
		js[0].Until.Sub(a.sim.Now()) > 24*time.Hour {
		t.Fatalf("suspension %+v", js)
	}
}

// A failed check never pushes the score past the suspension threshold by itself.
func TestPresenceFailNeverSuspendsAlone(t *testing.T) {
	a := antibotHarness(t)
	cl, p := a.joinAs("Slow", session.RolePlayer, pos(5, 5))
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.setScore(p, 590)
	c := a.presence(cl)
	a.input(cl, answer(c, false))
	a.sim.Step()
	if sc, _, _ := a.w.SuspicionForTest(p); sc >= 600 {
		t.Fatalf("score %.0f after failing below the threshold", sc)
	}
	a.playFor(cl, 2*time.Minute)
	if n := a.bans(); n != 0 {
		t.Fatalf("%d suspensions", n)
	}
}

// Answering right proves an answer, not a person (a script can read the question): the
// score stays, and a score still past the threshold an hour after the check suspends.
func TestPresencePassDoesNotClear(t *testing.T) {
	a := antibotHarness(t)
	cl, p := a.joinAs("Script", session.RolePlayer, pos(5, 5))
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.setScore(p, 700)
	c := a.presence(cl)
	a.takeJobs()
	a.input(cl, answer(c, true))
	a.sim.Step()
	if k := sysKeys(cl.take()); !slices.Equal(k, []string{"presence.thanks"}) {
		t.Fatalf("reply to a right answer %v", k)
	}
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:passed"}) {
		t.Fatalf("after a right answer: %v", got)
	}
	if sc, _, _ := a.w.SuspicionForTest(p); sc < 690 {
		t.Fatalf("score %.0f after passing", sc)
	}
	a.setScore(p, 700)
	if n := a.bans(); n != 0 {
		t.Fatal("suspended right after a passed check")
	}
	a.playFor(cl, time.Hour)
	a.setScore(p, 700) // the pattern went on
	if n := a.bans(); n != 1 {
		t.Fatalf("%d suspensions an hour after the check", n)
	}
}

// A check is never asked in combat, on a no-logout tile or to someone idle; dodging it
// for long tells the GMs. A forged answer does nothing.
func TestPresenceCheckIsSafe(t *testing.T) {
	a := antibotHarness(t)
	s := a.w.Map().SectorAt(pos(8, 5))
	s.Flags[5*world.SectorSize+8] |= world.FlagNoLogout
	cl, p := a.joinAs("Guard", session.RolePlayer, pos(8, 5)) // on a no-logout tile
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.setScore(p, 450)
	a.playFor(cl, 36*time.Minute) // past the delay (5 min) and the alert (30): never asked here
	for _, e := range cl.take() {
		if e.GetPresenceCheck() != nil {
			t.Fatal("asked on a no-logout tile")
		}
	}
	if got := a.antibotActions(); !slices.Contains(got, "presence_check:deferred") {
		t.Fatalf("dodging: %v", got)
	}
	if k := sysKeys(gm.take()); !slices.Contains(k, "gm.presence_deferred") {
		t.Fatalf("GM heard %v", k)
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
	a.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_PresenceAnswer{PresenceAnswer: &pb.PresenceAnswer{CheckId: c.GetCheckId() + 1}}})
	a.sim.Step()
	if k := sysKeys(cl.take()); len(k) != 0 {
		t.Fatalf("forged id: %v", k)
	}
}

// A GM's check has no effect on the score. Its clock runs only while the player plays:
// idle or offline it waits, and it comes back with the same id after a relogin.
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
	a.playFor(pl, 4*time.Minute)
	a.sim.RunFor(time.Hour) // idle: the clock stops
	a.input(pl, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	a.sim.RunFor(time.Hour) // offline too
	a.takeJobs()
	c2 := &fakeClient{}
	a.sim.Command(a.w.Join(session.Character{ID: p.CharacterID(), AccountID: p.CharacterID(), Name: "Player",
		Vocation: "guardian", Level: 1, Health: 145, Mana: 20, HasPos: true, Pos: pos(5, 5)}, c2))
	a.sim.Step()
	again := a.presence(c2)
	if again == nil || again.GetCheckId() != c.GetCheckId() || again.GetTimeoutMs() > 361000 || again.GetTimeoutMs() < 150000 { // active counts pause_ms after the last action
		t.Fatalf("resumed check %v", again)
	}
	a.playFor(c2, 7*time.Minute)
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:random_failed_timeout"}) {
		t.Fatalf("after the timeout: %v", got)
	}
	if sc, _, lv := a.w.SuspicionForTest(a.w.PlayerByCharacter(p.CharacterID())); sc != 0 || lv != 0 {
		t.Fatalf("a GM's check changed the score: %.0f level %d", sc, lv)
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
