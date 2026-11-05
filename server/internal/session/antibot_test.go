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
	a.setScore(p, 310)                                      // past log and notify
	if got := a.antibotActions(); !slices.Equal(got, []string{"bot_suspect:log", "bot_suspect:notify"}) {
		t.Fatalf("at 310: %v", got)
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

// Income compares with peers who play and earn, floored at the pace target of the level
// (experience.pace): in a band whose peers earn little, a level 5 hunter
// levelling at the target pace is not an outlier. In a high band, where a level takes
// hours, one earning ten times the pace is, with nearly the full ratio.
func TestIncomeAgainstPlayingPeers(t *testing.T) {
	a := antibotHarness(t)
	e := testBalance().Experience
	pace := func(level int) float64 { // experience per hour at the target pace
		return float64(e.TotalFor(level+1)-e.TotalFor(level)) * e.LevelsPerHour(level)
	}
	join := func(names []string, levels []int, y int) ([]*fakeClient, []*session.Player) {
		var cls []*fakeClient
		var ps []*session.Player
		for i, lv := range levels {
			cl, p := a.joinAs(names[i], session.RolePlayer, pos(2+i*2, y))
			a.sim.Command(gameFunc(func() { a.w.SetLevelForTest(p, lv) }))
			cls, ps = append(cls, cl), append(ps, p)
		}
		return cls, ps
	}
	low := []int{2, 3, 3, 4, 5} // the first four earn a tenth of the pace, the last one all of it
	cls, ps := join([]string{"Ana", "Bea", "Cid", "Dan", "Eve", "Idle"}, append(slices.Clone(low), 5), 5)
	high := []int{40, 41, 42, 43, 45, 44} // the last one earns ten times the pace
	hcls, hps := join([]string{"Hal", "Ivo", "Jon", "Kim", "Lia", "Max"}, high, 9)
	cls = append(cls, hcls...)
	a.sim.Step()
	for range 10 { // 20 min of play (the idle one only chats)
		for i, p := range ps[:5] {
			f := 0.1
			if i == 4 {
				f = 1
			}
			a.sim.Command(gameFunc(func() { a.w.GainExperienceForTest(p, int64(f*pace(low[i])/30)) }))
		}
		for i, p := range hps {
			f := 1.0
			if i == len(hps)-1 {
				f = 10
			}
			a.sim.Command(gameFunc(func() { a.w.GainExperienceForTest(p, int64(f*pace(high[i])/30)) }))
		}
		for _, cl := range cls {
			a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hm"))
		}
		a.sim.RunFor(2 * time.Minute)
	}
	if r := a.w.IncomeRatioForTest(ps[4]); r <= 0 || r >= 2 {
		t.Fatalf("a hunter at the normal pace: ratio %.1f", r)
	}
	if r := a.w.IncomeRatioForTest(hps[0]); r <= 0 || r >= 2 {
		t.Fatalf("a level 40 hunter at the normal pace: ratio %.1f", r)
	}
	if r := a.w.IncomeRatioForTest(hps[5]); r < 8 {
		t.Fatalf("ten times the pace at level 44: ratio %.1f", r)
	}
}

// The contract the client's countdown relies on: a check played through runs out no
// sooner than its timeout_ms (the client closes it before), the server says nothing to
// the player then, and a late answer is dropped without the usual reply (T4.1).
func TestPresenceTimeoutWhilePlaying(t *testing.T) {
	a := antibotHarness(t)
	cl, p := a.joinAs("Busy", session.RolePlayer, pos(5, 5))
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.setScore(p, 450)
	c := a.presence(cl)
	a.takeJobs()
	a.playFor(cl, time.Duration(c.GetTimeoutMs())*time.Millisecond-30*time.Second)
	if got := a.antibotActions(); slices.Contains(got, "presence_check:failed_timeout") {
		t.Fatalf("failed before timeout_ms of play: %v", got)
	}
	cl.take()
	a.playFor(cl, time.Minute)
	if got := a.antibotActions(); !slices.Contains(got, "presence_check:failed_timeout") {
		t.Fatalf("not failed after timeout_ms of play: %v", got)
	}
	for _, e := range cl.take() {
		if e.GetPresenceCheck() != nil || slices.Contains(sysKeys([]*pb.ServerMessage{e}), "presence.thanks") {
			t.Fatalf("the player heard of the timeout: %v", e)
		}
	}
	a.input(cl, answer(c, true))
	a.sim.Step()
	if k := sysKeys(cl.take()); len(k) != 0 {
		t.Fatalf("late answer: %v", k)
	}
}

// The clock of a check stops while the player is away; on the way back the check is sent
// again with the time left, and it does not fail before that time is played (T4.1).
func TestPresenceResentAfterIdle(t *testing.T) {
	a := antibotHarness(t)
	cl, p := a.joinAs("Afk", session.RolePlayer, pos(5, 5))
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.setScore(p, 450)
	c := a.presence(cl)
	a.takeJobs()
	a.sim.RunFor(12 * time.Minute) // away: about pause_ms of it counts, then the clock stops
	cl.take()
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "back"))
	var again *pb.PresenceCheck
	a.sim.RunUntil(func() bool { // to the tick it is sent again
		for _, e := range cl.take() {
			if c2 := e.GetPresenceCheck(); c2 != nil {
				again = c2
			}
		}
		return again != nil
	}, sim.MaxSeconds(3))
	if again == nil || again.GetCheckId() != c.GetCheckId() || again.GetTimeoutMs() < 380000 || again.GetTimeoutMs() > 460000 {
		t.Fatalf("sent again %v", again)
	}
	// The time sent is all there is: no failure before it is played to the last moment.
	a.playFor(cl, time.Duration(again.GetTimeoutMs())*time.Millisecond-200*time.Millisecond)
	if got := a.antibotActions(); slices.Contains(got, "presence_check:failed_timeout") {
		t.Fatalf("failed before its time was played: %v", got)
	}
	a.playFor(cl, 3*time.Second)
	if got := a.antibotActions(); !slices.Contains(got, "presence_check:failed_timeout") {
		t.Fatalf("not failed after its time: %v", got)
	}
}

// Idle time is not dodging: a due check waiting for a player who is away does not alert
// the GMs, however long it waits (nor does offline time: the relogin evaluates first).
func TestPresenceDeferralNotCountedAway(t *testing.T) {
	a := antibotHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	cl, p := a.joinAs("Sleeper", session.RolePlayer, pos(5, 5))
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.sim.RunFor(4 * time.Minute) // away from here
	a.setScore(p, 450)
	a.sim.RunFor(40 * time.Minute) // the due check waits
	if k := sysKeys(gm.take()); slices.Contains(k, "gm.presence_deferred") {
		t.Fatalf("GM heard %v", k)
	}
	if got := a.antibotActions(); slices.Contains(got, "presence_check:deferred") {
		t.Fatalf("audited %v", got)
	}
	for _, e := range cl.take() {
		if e.GetPresenceCheck() != nil {
			t.Fatal("asked while away")
		}
	}
}

// A response check left over from an episode that ended (the score decayed while
// offline) still comes, but as a random one: ignoring it has no effect.
func TestPresenceLeftoverCheckIsRandom(t *testing.T) {
	a := antibotHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	cl, p := a.joinAs("Leaver", session.RolePlayer, pos(5, 5))
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.setScore(p, 450) // a check is scheduled
	a.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	a.sim.RunFor(8 * time.Hour)
	c2 := &fakeClient{}
	a.sim.Command(a.w.Join(session.Character{ID: p.CharacterID(), AccountID: p.CharacterID(), Name: "Leaver",
		Vocation: "guardian", Level: 1, Health: 145, Mana: 20, HasPos: true, Pos: pos(5, 5)}, c2))
	a.sim.Step()
	a.takeJobs()
	gm.take()
	if a.presence(c2) == nil {
		t.Fatal("the leftover check was dropped")
	}
	a.playFor(c2, 12*time.Minute) // ignored
	got := a.antibotActions()
	if !slices.Equal(got, []string{"presence_check:random_sent", "presence_check:random_failed_timeout"}) {
		t.Fatalf("leftover check: %v", got)
	}
	if k := sysKeys(gm.take()); slices.Contains(k, "gm.presence_failed") {
		t.Fatalf("GM heard %v", k)
	}
	if sc, _, _ := a.w.SuspicionForTest(a.w.PlayerByCharacter(p.CharacterID())); sc >= 100 {
		t.Fatalf("score %.0f", sc)
	}
}

// A GM's /presence moves a pending response check forward without making it random,
// and a random check that was open when the score crossed presence is followed by the
// response check.
func TestPresenceGMAndRandomKeepTheResponse(t *testing.T) {
	a := antibotHarness(t)
	gm, _ := a.joinAs("Warden", session.RoleGM, pos(30, 5))
	cl, p := a.joinAs("Bot", session.RolePlayer, pos(5, 5))
	a.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.setScore(p, 450)
	a.cmd(gm, "/presence Bot")
	c := a.presence(cl)
	a.takeJobs()
	a.input(cl, answer(c, false))
	a.sim.Step()
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:failed_wrong"}) {
		t.Fatalf("after the GM moved the response check forward: %v", got)
	}
	if k := sysKeys(gm.take()); !slices.Contains(k, "gm.presence_failed") {
		t.Fatalf("GM heard %v", k)
	}

	cl2, q := a.joinAs("Other", session.RolePlayer, pos(8, 5))
	a.input(cl2, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
	a.cmd(gm, "/presence Other") // a random one, open...
	r := a.presence(cl2)
	a.setScore(q, 450) // ...when the score crosses presence
	a.takeJobs()
	a.input(cl2, answer(r, true))
	a.sim.Step()
	if a.presence(cl2) == nil {
		t.Fatal("no response check after the random one")
	}
	if got := a.antibotActions(); !slices.Equal(got, []string{"presence_check:random_passed", "presence_check:sent"}) {
		t.Fatalf("after the random check: %v", got)
	}
}
