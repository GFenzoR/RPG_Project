package session_test

import (
	"math/rand/v2"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
)

// simBot plays a pkg/bot profile through World.Input, tick by tick.
type simBot struct {
	prof     bot.Profile
	cl       *fakeClient
	p        *session.Player
	home     [2]int
	r        *rand.Rand
	next     game.Tick // next action
	heal     game.Tick // pending heal (0 = none)
	beat     game.Tick // next action besides walking
	paused   game.Tick // in a pause until then
	steps    int
	answered int
}

func ticksOf(d time.Duration) game.Tick { return game.TicksFor(d) }

var botDirs = map[bot.Direction]pb.Direction{bot.North: N, bot.East: E, bot.South: S, bot.West: W}

func (b *simBot) tick(h *harness, now game.Tick) {
	if b.heal != 0 && now >= b.heal {
		b.heal = 0
		if now >= b.paused { // a break is a real break: no heal either
			h.input(b.cl, cast("bot_heal"))
		}
	}
	// A human answers a presence check after reading it; a script never does.
	for _, e := range b.cl.take() {
		if c := e.GetPresenceCheck(); c != nil && b.prof.Wander {
			want := strings.TrimPrefix(c.GetQuestion().GetKey(), "presence.question.")
			for _, o := range c.GetOptions() {
				if o.GetText().GetKey() == "presence.option."+want {
					h.input(b.cl, &pb.ClientMessage{Message: &pb.ClientMessage_PresenceAnswer{
						PresenceAnswer: &pb.PresenceAnswer{CheckId: c.GetCheckId(), OptionId: o.GetOptionId()}}})
					b.answered++
				}
			}
		}
	}
	if now < b.paused {
		return
	}
	if now >= b.beat {
		h.input(b.cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "training"))
		b.beat = now + max(ticksOf(b.prof.BeatDelay(b.r)), 1)
	}
	if now < b.next {
		return
	}
	pos := b.p.Pos()
	d := b.prof.Step(b.r, b.steps, int(pos.X)-b.home[0], int(pos.Y)-b.home[1])
	b.steps++
	h.input(b.cl, walk(botDirs[d]))
	wait := b.prof.Delay(b.r)
	b.next = now + max(ticksOf(wait), 1)
	if pause := b.prof.Pause(b.r, wait); pause > 0 { // a break: nothing at all
		b.paused = b.next + ticksOf(pause)
		b.next, b.beat = b.paused, b.paused
	}
}

// T4.1: a "human" profile (uneven pace, breaks, slow and varied heals, its own way) and a
// "mechanical" one (fixed beat, no breaks, heals 100 ms after every hit, the same loop)
// play side by side for hours of game time with the detection of data/balance.yaml.
// The mechanical one climbs every graded response up to a suspension; the human one is
// never even logged.
func TestAntiBotFlagsMechanicalNotHuman(t *testing.T) {
	bal, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	var jobs []session.AdminJob
	h := newHarness(t, worldtest.Open(t, 0, 0, 96, 64), func(c *session.Config) {
		c.Balance.AntiBot = bal.AntiBot
		c.Spells = content.Spells{"bot_heal": {ID: "bot_heal", Words: "bot heal", Vocations: []string{"guardian"},
			Level: 1, Group: "healing", CooldownMs: 1000, GroupCooldownMs: 1000,
			Effect: content.SpellEffect{Heal: &content.SpellHeal{Scaling: content.Scaling{Base: 30}}}}}
		c.Balance.Skills.Base["magic"] = content.SkillBase{BaseTries: 1000}
		c.Admin = func(j session.AdminJob) bool {
			if j.Kind != session.AdminCheckRoles {
				jobs = append(jobs, j)
			}
			return true
		}
	})
	r := h.sim.Rand()
	bots := []*simBot{{prof: bot.Human(), home: [2]int{20, 20}}, {prof: bot.Mechanical(), home: [2]int{60, 30}}}
	for i, b := range bots {
		b.r = rand.New(rand.NewPCG(uint64(i+1), 99))
		b.cl, b.p = h.join([]string{"Person", "Script"}[i], at(b.home[0], b.home[1]))
	}
	hurtEvery := ticksOf(10 * time.Second)
	nextHurt := h.sim.Tick() + hurtEvery
	banned := func() bool {
		return slices.ContainsFunc(jobs, func(j session.AdminJob) bool { return j.Kind == session.AdminBan })
	}
	limit := h.sim.Tick() + ticksOf(5*time.Hour)
	for !banned() && h.sim.Tick() < limit {
		now := h.sim.Tick()
		if now >= nextHurt {
			nextHurt = now + hurtEvery/2 + game.Tick(r.Uint64N(uint64(hurtEvery)))
			for _, b := range bots {
				if now < b.paused { // nobody hits a player on a break (it is somewhere safe)
					continue
				}
				h.sim.Command(ctxFunc(func(ctx *game.TickContext) { h.w.HurtForTest(ctx, b.p, 3) }))
				b.heal = now + 1 + ticksOf(b.prof.HealDelay(b.r))
			}
		}
		for _, b := range bots {
			b.tick(h, now)
		}
		h.sim.Step()
	}
	if !banned() {
		t.Fatalf("the mechanical bot was not suspended in %v", (h.sim.Tick() - limit + ticksOf(5*time.Hour)).Duration())
	}
	got := map[string][]string{}
	for _, j := range jobs {
		if j.Audit.ActorName == "system:antibot" {
			name := j.Audit.TargetName + j.TargetName // a ban names its target in the job
			got[name] = append(got[name], j.Audit.Action+":"+j.Audit.Result)
		}
	}
	t.Logf("after %v: %v", h.sim.Elapsed().Round(time.Minute), got)
	if len(got["Person"]) != 0 {
		t.Errorf("the human profile was flagged: %v", got["Person"])
	}
	want := []string{"bot_suspect:log", "bot_suspect:notify", "presence_check:sent", "presence_check:failed_timeout", "ban:"}
	if g := got["Script"]; !slices.Equal(g, want) {
		t.Errorf("mechanical responses %v, want %v", g, want)
	}
}

// habits are things a real player does with the shipped client that look mechanical.
type habits struct {
	clickWalk bool // clicks the same far tile and back (the same A* path every time)
	mash      bool // mashes a cooldown hotkey: one key press every 150-300 ms
	quickHeal bool // heals at human reaction speed: N(250, 50) ms + 50 ms of latency
	pauses    bool // takes Human()'s breaks (otherwise plays without a pause)
}

func (hb habits) String() string {
	var out []string
	for _, x := range []struct {
		on   bool
		name string
	}{{hb.clickWalk, "clickwalk"}, {hb.mash, "mash"}, {hb.quickHeal, "quickheal"}, {hb.pauses, "pauses"}} {
		if x.on {
			out = append(out, x.name)
		}
	}
	return strings.Join(out, "+")
}

// playHabits plays a Human() profile with hb for d of game time and returns the final
// response level and the bot detection's audit actions.
func playHabits(t *testing.T, hb habits, d time.Duration, seed uint64) (int, []string) {
	bal, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	var acts []string
	h := newHarness(t, worldtest.Open(t, 0, 0, 64, 64), func(c *session.Config) {
		c.Balance.AntiBot = bal.AntiBot
		c.Balance.AntiBot.Presence.RandomPerHour = 0 // only the score's checks
		c.Spells = content.Spells{"bot_heal": {ID: "bot_heal", Words: "bot heal", Vocations: []string{"guardian"},
			Level: 1, Group: "healing", CooldownMs: 1000, GroupCooldownMs: 1000,
			Effect: content.SpellEffect{Heal: &content.SpellHeal{Scaling: content.Scaling{Base: 30}}}}}
		c.Balance.Skills.Base["magic"] = content.SkillBase{BaseTries: 1000}
		c.Admin = func(j session.AdminJob) bool {
			if j.Audit.ActorName == "system:antibot" {
				acts = append(acts, j.Audit.Action+":"+j.Audit.Result)
			}
			return true
		}
	})
	prof := bot.Human()
	r := rand.New(rand.NewPCG(seed, 5))
	cl, p := h.join("Person", at(20, 20))
	there := []pb.Direction{E, E, E, E, E, E, E, E, S, S, S, S}
	back := []pb.Direction{N, N, N, N, W, W, W, W, W, W, W, W}
	out := true
	tk := func(d time.Duration) game.Tick { return max(ticksOf(d), 1) }
	var nextStep, nextKey, nextBeat, paused, heal game.Tick
	nextHurt := h.sim.Tick() + tk(10*time.Second)
	end := h.sim.Tick() + ticksOf(d)
	for h.sim.Tick() < end {
		now := h.sim.Tick()
		if now >= paused {
			if heal != 0 && now >= heal {
				heal = 0
				h.input(cl, cast("bot_heal"))
			}
			if hb.mash && now >= nextKey { // one press: the server casts if the cooldown is over
				h.input(cl, cast("bot_heal"))
				nextKey = now + tk(time.Duration(150+r.IntN(151))*time.Millisecond)
			}
			if now >= nextBeat {
				h.input(cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hm"))
				nextBeat = now + tk(prof.BeatDelay(r))
			}
			if now >= nextStep && !p.Walking() {
				wait := prof.Delay(r)
				if hb.clickWalk {
					if out {
						h.input(cl, walkPath(there...))
					} else {
						h.input(cl, walkPath(back...))
					}
					out = !out
					wait += time.Duration(1000+r.IntN(3000)) * time.Millisecond // a look before the next click
				} else {
					pos := p.Pos()
					h.input(cl, walk(botDirs[prof.Step(r, 0, int(pos.X)-20, int(pos.Y)-20)]))
				}
				nextStep = now + tk(wait)
				if hb.pauses {
					if pause := prof.Pause(r, wait); pause > 0 {
						paused = nextStep + tk(pause)
						nextStep, nextBeat, nextKey, heal = paused, paused, paused, 0
					}
				}
			}
			if now >= nextHurt {
				nextHurt = now + tk(5*time.Second) + game.Tick(r.Uint64N(uint64(tk(10*time.Second))))
				h.sim.Command(ctxFunc(func(ctx *game.TickContext) { h.w.HurtForTest(ctx, p, 3) }))
				react := prof.HealDelay(r)
				if hb.quickHeal {
					react = time.Duration(250+50*r.NormFloat64())*time.Millisecond + 50*time.Millisecond
				}
				heal = now + 1 + tk(react)
			}
		}
		h.sim.Step()
		cl.take()
	}
	sc, sg, lv := h.w.SuspicionForTest(p)
	t.Logf("%s: score %.0f level %d signals %.2f", hb, sc, lv, sg)
	return lv, acts
}

// Negative controls (T4.1): habits a real player can have with the shipped client, alone
// and in pairs, with and without breaks, for 6 hours of play. None reaches a GM notice,
// a presence check or a suspension ("a normal player never reaches notify").
func TestAntiBotHumanHabitsNeverNotify(t *testing.T) {
	var cases []habits
	singles := []habits{{clickWalk: true}, {mash: true}, {quickHeal: true}}
	pairs := []habits{{clickWalk: true, mash: true}, {clickWalk: true, quickHeal: true}, {mash: true, quickHeal: true}}
	for _, hb := range append(singles, pairs...) {
		cases = append(cases, hb)
		hb.pauses = true
		cases = append(cases, hb)
	}
	for i, hb := range cases {
		t.Run(hb.String(), func(t *testing.T) {
			t.Parallel()
			lv, acts := playHabits(t, hb, 6*time.Hour, uint64(i+1))
			if lv >= 2 { // antibot.LevelNotify
				t.Errorf("level %d, actions %v", lv, acts)
			}
			for _, a := range acts {
				if strings.HasPrefix(a, "presence_check") || strings.HasPrefix(a, "ban") || a == "bot_suspect:notify" {
					t.Errorf("response %s", a)
				}
			}
		})
	}
}

// Signals age with their own evidence: after 30 minutes of scripted hunting, five hours
// of only chatting (and answering the checks right) bring the character back to level 0,
// with no suspension (T4.1: a past hunt used to keep scoring).
func TestAntiBotPastHuntStopsScoring(t *testing.T) {
	bal, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	var acts []string
	h := newHarness(t, worldtest.Open(t, 0, 0, 96, 64), func(c *session.Config) {
		c.Balance.AntiBot = bal.AntiBot
		c.Balance.AntiBot.Presence.RandomPerHour = 0
		c.Spells = content.Spells{"bot_heal": {ID: "bot_heal", Words: "bot heal", Vocations: []string{"guardian"},
			Level: 1, Group: "healing", CooldownMs: 1000, GroupCooldownMs: 1000,
			Effect: content.SpellEffect{Heal: &content.SpellHeal{Scaling: content.Scaling{Base: 30}}}}}
		c.Balance.Skills.Base["magic"] = content.SkillBase{BaseTries: 1000}
		c.Admin = func(j session.AdminJob) bool {
			if j.Audit.ActorName == "system:antibot" {
				acts = append(acts, j.Audit.Action+":"+j.Audit.Result)
			}
			return true
		}
	})
	b := &simBot{prof: bot.Mechanical(), home: [2]int{60, 30}, r: rand.New(rand.NewPCG(3, 99))}
	b.cl, b.p = h.join("Retired", at(60, 30))
	end := h.sim.Tick() + ticksOf(30*time.Minute)
	for h.sim.Tick() < end { // the scripted hunt
		now := h.sim.Tick()
		if now%ticksOf(10*time.Second) == 0 {
			h.sim.Command(ctxFunc(func(ctx *game.TickContext) { h.w.HurtForTest(ctx, b.p, 3) }))
			b.heal = now + 1 + ticksOf(b.prof.HealDelay(b.r))
		}
		b.tick(h, now)
		h.sim.Step()
	}
	if _, sg, _ := h.w.SuspicionForTest(b.p); sg[0]+sg[1]+sg[2] < 2 {
		t.Fatalf("the hunt did not look scripted: %v", sg)
	}
	r := rand.New(rand.NewPCG(4, 4))
	end = h.sim.Tick() + ticksOf(5*time.Hour)
	next := h.sim.Tick()
	for h.sim.Tick() < end { // then a person in town: a chat line every 1-4 min
		now := h.sim.Tick()
		if now >= next {
			h.input(b.cl, say(pb.ChatChannel_CHAT_CHANNEL_SAY, "hi"))
			next = now + ticksOf(time.Duration(60+r.IntN(180))*time.Second)
		}
		for _, e := range b.cl.take() {
			if c := e.GetPresenceCheck(); c != nil {
				h.input(b.cl, answer(c, true))
			}
		}
		h.sim.Step()
	}
	if _, sg, lv := h.w.SuspicionForTest(b.p); lv != 0 {
		t.Fatalf("level %d after five hours of chatting (signals %v): %v", lv, sg, acts)
	}
	for _, a := range acts {
		if strings.HasPrefix(a, "ban") {
			t.Fatalf("suspended: %v", acts)
		}
	}
}
