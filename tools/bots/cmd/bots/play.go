package main

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
)

// pacer is the bot's own rate limit: at most one command every minGap, like a fast
// human (the server allows 30/s; a client never needs more than a few).
type pacer struct {
	minGap time.Duration
	next   time.Time
	now    func() time.Time
}

// wait blocks until the next command may be sent.
func (p *pacer) wait(ctx context.Context) error {
	now := p.now()
	if d := p.next.Sub(now); d > 0 {
		if err := sleep(ctx, d); err != nil {
			return err
		}
		now = p.next
	}
	p.next = now.Add(p.minGap)
	return nil
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// actions counts what a bot did.
type actions struct {
	Walks, Attacks, Says, Talks, Dialogs, Pings int
}

func (a *actions) add(b actions) {
	a.Walks += b.Walks
	a.Attacks += b.Attacks
	a.Says += b.Says
	a.Talks += b.Talks
	a.Dialogs += b.Dialogs
	a.Pings += b.Pings
}

// player is one bot's behaviour: it walks to its area, then wanders, fights, chats and
// talks to NPCs until the context ends. Every command goes through the pacer.
type player struct {
	b     *bot.Bot
	nav   *bot.Nav // nil: no map, the bot walks at random
	r     *rand.Rand
	sc    scenario
	home  area
	pace  pacer
	acts  actions
	lastP time.Time
}

// errDisconnected reports that the server closed the connection.
var errDisconnected = errors.New("disconnected")

func (p *player) send(ctx context.Context, fn func(context.Context) error) error {
	if err := p.pace.wait(ctx); err != nil {
		return err
	}
	select {
	case <-p.b.Done():
		return fmt.Errorf("%w: %s", errDisconnected, p.b.Disconnected())
	default:
	}
	return fn(ctx)
}

// pingEvery is how often a bot measures its latency.
const pingEvery = 2 * time.Second

// ping sends a Ping when one is due.
func (p *player) ping(ctx context.Context) error {
	if time.Since(p.lastP) < pingEvery {
		return nil
	}
	p.lastP = time.Now()
	p.acts.Pings++
	return p.send(ctx, p.b.Ping)
}

// idle waits d, pinging on time, and fails if the connection closes.
func (p *player) idle(ctx context.Context, d time.Duration) error {
	end := time.Now().Add(d)
	for {
		if err := p.ping(ctx); err != nil {
			return err
		}
		left := time.Until(end)
		if left <= 0 {
			return nil
		}
		step := min(left, 250*time.Millisecond)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-p.b.Done():
			return fmt.Errorf("%w: %s", errDisconnected, p.b.Disconnected())
		case <-time.After(step):
		}
	}
}

// run plays until ctx ends. A context error is the normal end, not a failure.
func (p *player) run(ctx context.Context) error {
	err := p.loop(ctx)
	if ctx.Err() != nil && !errors.Is(err, errDisconnected) {
		return nil
	}
	return err
}

func (p *player) loop(ctx context.Context) error {
	if err := p.goTo(ctx, p.home.center, p.home.radius); err != nil {
		return err
	}
	for {
		var err error
		switch x := p.r.IntN(100); {
		case x < 45:
			err = p.wander(ctx)
		case x < 70 && p.sc.fight:
			err = p.fight(ctx)
		case x < 82:
			err = p.talk(ctx)
		case x < 92:
			err = p.chat(ctx)
		}
		if err != nil {
			return err
		}
		if err := p.idle(ctx, time.Duration(1000+p.r.IntN(3000))*time.Millisecond); err != nil {
			return err
		}
	}
}

// walkTo sends a planned path and waits until the bot arrives, is stopped or the
// expected time runs out.
func (p *player) walkTo(ctx context.Context, target bot.Pos, path []bot.Direction) error {
	if len(path) == 0 {
		return nil
	}
	p.acts.Walks++
	if err := p.send(ctx, func(c context.Context) error { return p.b.WalkPath(c, path) }); err != nil {
		return err
	}
	// A level 1 character takes well under 600 ms per step on any ground of the island.
	deadline := time.Now().Add(time.Duration(len(path))*600*time.Millisecond + 2*time.Second)
	rejected := p.b.Stats().Rejected
	for time.Now().Before(deadline) {
		if p.b.Pos() == target || p.b.Stats().Rejected != rejected {
			return nil
		}
		if err := p.idle(ctx, 200*time.Millisecond); err != nil {
			return err
		}
	}
	return nil
}

// goTo walks to a random tile within radius of center (several hops if it is far).
func (p *player) goTo(ctx context.Context, center bot.Pos, radius int) error {
	if p.nav == nil {
		return nil
	}
	for range 4 {
		from := p.b.Pos()
		if chebyshev(from, center) <= radius {
			return nil
		}
		target, path, ok := p.nav.RandomNear(p.r, from, center, radius, 20)
		if !ok {
			// Too far for one path (100 steps): head halfway first.
			mid := bot.Pos{X: (from.X + center.X) / 2, Y: (from.Y + center.Y) / 2, Z: center.Z}
			if target, path, ok = p.nav.RandomNear(p.r, from, mid, 6, 20); !ok {
				return nil
			}
		}
		if err := p.walkTo(ctx, target, path); err != nil {
			return err
		}
	}
	return nil
}

// wander walks a few tiles within the bot's area (back into it after a death).
func (p *player) wander(ctx context.Context) error {
	from := p.b.Pos()
	if p.nav == nil {
		steps := make([]bot.Direction, 1+p.r.IntN(6))
		for i := range steps {
			steps[i] = bot.Direction(p.r.IntN(8))
		}
		p.acts.Walks++
		return p.send(ctx, func(c context.Context) error { return p.b.WalkPath(c, steps) })
	}
	if chebyshev(from, p.home.center) > p.home.radius+3 {
		return p.goTo(ctx, p.home.center, p.home.radius)
	}
	target, path, ok := p.nav.RandomNear(p.r, from, from, 5, 10)
	if !ok || chebyshev(target, p.home.center) > p.home.radius+3 {
		target, path, ok = p.nav.RandomNear(p.r, from, p.home.center, p.home.radius, 10)
	}
	if !ok {
		return nil
	}
	return p.walkTo(ctx, target, path)
}

// fightFor bounds one fight: then the bot gives up, like a player that moves on.
const fightFor = 20 * time.Second

// fight attacks the nearest monster in sight and chases it until it dies, leaves the
// view or the fight takes too long.
func (p *player) fight(ctx context.Context) error {
	me := p.b.Pos()
	var target *bot.Creature
	for _, c := range p.b.Creatures(bot.KindMonster) {
		if c.Pos.Z == me.Z && (target == nil || chebyshev(me, c.Pos) < chebyshev(me, target.Pos)) {
			target = &c
		}
	}
	if target == nil || chebyshev(me, target.Pos) > 7 {
		return p.wander(ctx)
	}
	p.acts.Attacks++
	if err := p.send(ctx, func(c context.Context) error { return p.b.Attack(c, target.ID, true) }); err != nil {
		return err
	}
	end := time.Now().Add(fightFor)
	for time.Now().Before(end) && p.b.Sees(target.ID) {
		if err := p.idle(ctx, 500*time.Millisecond); err != nil {
			return err
		}
	}
	return p.send(ctx, func(c context.Context) error { return p.b.Attack(c, 0, false) })
}

// talk walks next to an NPC in sight, opens its dialog, maybe picks an option and
// closes it.
func (p *player) talk(ctx context.Context) error {
	npcs := p.b.Creatures(bot.KindNPC)
	if len(npcs) == 0 || p.nav == nil {
		return p.chat(ctx)
	}
	npc := npcs[p.r.IntN(len(npcs))]
	if chebyshev(p.b.Pos(), npc.Pos) > 2 {
		target, path, ok := p.nav.RandomNear(p.r, p.b.Pos(), npc.Pos, 2, 10)
		if !ok {
			return nil
		}
		if err := p.walkTo(ctx, target, path); err != nil {
			return err
		}
	}
	p.acts.Talks++
	if err := p.send(ctx, func(c context.Context) error { return p.b.TalkTo(c, npc.ID) }); err != nil {
		return err
	}
	var d *bot.Dialog
	for range 10 {
		if d = p.b.Dialog(); d != nil {
			break
		}
		if err := p.idle(ctx, 200*time.Millisecond); err != nil {
			return err
		}
	}
	if d == nil {
		return nil // too far (the NPC walked, or a creature was in the way)
	}
	p.acts.Dialogs++
	if len(d.Options) > 0 && p.r.IntN(2) == 0 {
		// Reading the answer takes a moment.
		if err := p.idle(ctx, time.Duration(800+p.r.IntN(1500))*time.Millisecond); err != nil {
			return err
		}
		opt := d.Options[p.r.IntN(len(d.Options))]
		if err := p.send(ctx, func(c context.Context) error { return p.b.Choose(c, d.ID, opt) }); err != nil {
			return err
		}
	}
	if err := p.idle(ctx, time.Duration(800+p.r.IntN(1500))*time.Millisecond); err != nil {
		return err
	}
	if d = p.b.Dialog(); d != nil {
		return p.send(ctx, func(c context.Context) error { return p.b.Choose(c, d.ID, 0) })
	}
	return nil
}

// phrases are what bots say: plain chat, no spell words.
var phrases = []string{
	"hello", "anyone hunting?", "nice weather", "where are the wolves?", "brb",
	"selling fish", "lol", "need a team", "good luck", "see you",
}

func (p *player) chat(ctx context.Context) error {
	p.acts.Says++
	text := phrases[p.r.IntN(len(phrases))]
	return p.send(ctx, func(c context.Context) error { return p.b.Say(c, text) })
}

func chebyshev(a, b bot.Pos) int {
	return max(abs(a.X-b.X), abs(a.Y-b.Y))
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
