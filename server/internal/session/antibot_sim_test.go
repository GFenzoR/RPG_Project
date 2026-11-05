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
		h.input(b.cl, cast("bot_heal"))
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
