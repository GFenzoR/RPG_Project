package session_test

import (
	"math/rand/v2"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/sim"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// sizeClient counts the bytes of every batch the World sends it: proto.Size of the
// ServerBatch, what the gateway writes (without the 2-4 bytes of the WebSocket frame).
type sizeClient struct{ bytes int }

func (c *sizeClient) Send(b *pb.ServerBatch) bool { c.bytes += proto.Size(b); return true }
func (c *sizeClient) Close(pb.DisconnectReason)   {}

// crowdArea is where a crowd bot spends the run.
type crowdArea struct {
	center world.Pos
	radius int
}

// The areas of tools/bots/cmd/bots/scenario.go (docs/07 "Pruebas de carga"): base spreads
// the bots over Velmara, stress packs them all in Lanternby.
var (
	crowdTown  = crowdArea{world.Pos{X: 3166, Y: 6386, Z: 7}, 8}
	crowdAreas = map[string][]crowdArea{
		"base": {
			crowdTown,
			{world.Pos{X: 3192, Y: 6430, Z: 7}, 6},
			{world.Pos{X: 3212, Y: 6372, Z: 7}, 6},
			{world.Pos{X: 3220, Y: 6394, Z: 7}, 6},
			{world.Pos{X: 3118, Y: 6378, Z: 7}, 6},
			{world.Pos{X: 3124, Y: 6416, Z: 7}, 6},
			{world.Pos{X: 3122, Y: 6334, Z: 7}, 7},
			{world.Pos{X: 3236, Y: 6384, Z: 7}, 4},
			{world.Pos{X: 3172, Y: 6329, Z: 7}, 5},
		},
		"stress": {crowdTown},
	}
)

// crowdBot is one simulated bot: what it is doing and when it acts again.
type crowdBot struct {
	cl   *sizeClient
	p    *session.Player
	home crowdArea
	// walking: it sent a path at sent and waits until it stops walking. Then it talks to
	// npc (0: none) and rests.
	walking bool
	sent    game.Tick
	npc     uint32
	// foe is the monster it fights (0: none) until the tick until.
	foe   uint32
	until game.Tick
	next  game.Tick // its next activity
	ping  game.Tick // its next Ping
}

// crowd plays tools/bots' behaviour in process, on the real world/ and data/ with the
// simulated clock: every bot wanders, fights, talks to an NPC, chats or rests with the
// same mix as the load test (base: 45/25/12/10/8 %; stress, in a protection zone,
// 45/0/37/10/8 %), rests 1-4 s between activities and pings every 2 s.
type crowd struct {
	t     testing.TB
	sim   *sim.Sim
	w     *session.World
	m     *world.Map
	pf    *world.Pathfinder
	r     *rand.Rand
	fight bool
	bots  []*crowdBot
}

func newCrowd(t testing.TB, scenario string, n int) *crowd {
	t.Helper()
	root := filepath.Join("..", "..", "..")
	m, err := compile.Build(root, compile.Options{})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "data")
	npcs, err := content.LoadNPCs(dir)
	if err != nil {
		t.Fatal(err)
	}
	routes, err := content.LoadBoatRoutes(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := dataConfig(t, routes)
	cfg.Map, cfg.NPCs, cfg.Quests = m, npcs, realQuests(t)
	cfg.Balance.AntiBot.EvalEveryMs = 0 // no presence checks: bots of the load test answer them
	w, err := session.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	mv, fight, flush := w.Systems()
	c := &crowd{
		t: t, w: w, m: m, pf: world.NewPathfinder(m, 4000),
		sim:   sim.New(t, sim.WithSeed(5), sim.WithSystems(mv, fight, flush), sim.WithQueueLimits(1<<16, 1<<16)),
		r:     rand.New(rand.NewPCG(5, 6)),
		fight: scenario == "base",
	}
	areas := crowdAreas[scenario]
	for i := range n {
		home := areas[i%len(areas)]
		at, ok := c.randomTile(home.center, home.radius)
		if !ok {
			t.Fatalf("no tile in the area at %v", home.center)
		}
		cl := &sizeClient{}
		ch := session.Character{ID: int64(9000 + i), AccountID: int64(9000 + i), Name: "Crowd", Vocation: "guardian",
			Level: 1, Health: 145, Mana: 20, HasPos: true, Pos: at}
		c.sim.Command(w.Join(ch, cl))
		c.sim.Step()
		p := w.PlayerByCharacter(ch.ID)
		if p == nil {
			t.Fatalf("bot %d did not join", i)
		}
		c.bots = append(c.bots, &crowdBot{cl: cl, p: p, home: home, next: c.sim.Tick() + c.rest()})
	}
	return c
}

func (c *crowd) send(b *crowdBot, msg *pb.ClientMessage) { c.sim.Command(c.w.Input(b.cl, msg)) }

// rest is the wait between two activities: 1-4 s.
func (c *crowd) rest() game.Tick {
	return game.Tick((1000 + c.r.IntN(3000)) / int(game.TickDuration/time.Millisecond))
}

// randomTile returns a random tile within radius of center that a bot can stand on.
func (c *crowd) randomTile(center world.Pos, radius int) (world.Pos, bool) {
	for range 50 {
		x := int(center.X) + c.r.IntN(2*radius+1) - radius
		y := int(center.Y) + c.r.IntN(2*radius+1) - radius
		p := world.Pos{X: uint16(x), Y: uint16(y), Z: center.Z}
		if c.m.Walkable(p) && !c.m.MovesOnStep(p) {
			return p, true
		}
	}
	return world.Pos{}, false
}

// walkNear sends b on a path to a random tile within radius of center (bot.Nav.RandomNear).
func (c *crowd) walkNear(b *crowdBot, center world.Pos, radius int) bool {
	for range 10 {
		to, ok := c.randomTile(center, radius)
		if !ok {
			return false
		}
		path, ok := c.pf.FindAvoiding(b.p.Pos(), to, nil, c.m.MovesOnStep)
		if !ok || len(path) == 0 || len(path) > 100 {
			continue
		}
		steps := make([]pb.Direction, len(path))
		for i, d := range path {
			steps[i] = pb.Direction(d + 1)
		}
		c.send(b, walkPath(steps...))
		b.walking, b.sent = true, c.sim.Tick()
		return true
	}
	return false
}

func crowdChebyshev(a, b world.Pos) int {
	return max(max(int(a.X)-int(b.X), int(b.X)-int(a.X)), max(int(a.Y)-int(b.Y), int(b.Y)-int(a.Y)))
}

var crowdPhrases = []string{"hello", "anyone hunting?", "nice weather", "where are the wolves?", "brb",
	"selling fish", "lol", "need a team", "good luck", "see you"}

// act runs one tick of b's behaviour.
func (c *crowd) act(b *crowdBot) {
	now := c.sim.Tick()
	if now >= b.ping {
		c.send(b, &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: uint64(now)}}})
		b.ping = now + 40
	}
	switch {
	case b.walking:
		if now <= b.sent+1 || b.p.Walking() {
			return
		}
		b.walking = false
		if b.npc != 0 {
			c.send(b, talkMsg(b.npc))
			b.npc = 0
		}
		b.next = now + c.rest()
		return
	case b.foe != 0:
		if now < b.until && b.p.Knows(b.foe) {
			return
		}
		c.send(b, &pb.ClientMessage{Message: &pb.ClientMessage_SetTarget{SetTarget: &pb.SetTarget{}}})
		b.foe, b.next = 0, now+c.rest()
		return
	case now < b.next:
		return
	}
	b.next = now + c.rest()
	switch x := c.r.IntN(100); {
	case x < 45:
		c.wander(b)
	case x < 70 && c.fight:
		c.startFight(b, now)
	case x < 82:
		c.talk(b)
	case x < 92:
		c.send(b, &pb.ClientMessage{Message: &pb.ClientMessage_Say{Say: &pb.Say{
			Channel: pb.ChatChannel_CHAT_CHANNEL_SAY, Text: crowdPhrases[c.r.IntN(len(crowdPhrases))]}}})
	}
}

// wander walks a few tiles within the bot's area, or back into it.
func (c *crowd) wander(b *crowdBot) {
	if crowdChebyshev(b.p.Pos(), b.home.center) > b.home.radius+3 {
		c.walkNear(b, b.home.center, b.home.radius)
		return
	}
	c.walkNear(b, b.p.Pos(), 5)
}

// startFight attacks the nearest monster in sight (at most 7 tiles away) for up to 20 s.
func (c *crowd) startFight(b *crowdBot, now game.Tick) {
	var foe *session.Monster
	for _, m := range c.w.Monsters() {
		if b.p.Knows(m.ID()) && m.Pos().Z == b.p.Pos().Z &&
			(foe == nil || crowdChebyshev(b.p.Pos(), m.Pos()) < crowdChebyshev(b.p.Pos(), foe.Pos())) {
			foe = m
		}
	}
	if foe == nil || crowdChebyshev(b.p.Pos(), foe.Pos()) > 7 {
		c.wander(b)
		return
	}
	c.send(b, &pb.ClientMessage{Message: &pb.ClientMessage_SetFightMode{SetFightMode: &pb.SetFightMode{
		Stance: pb.FightStance_FIGHT_STANCE_BALANCED, Chase: true}}})
	c.send(b, &pb.ClientMessage{Message: &pb.ClientMessage_SetTarget{SetTarget: &pb.SetTarget{CreatureId: foe.ID()}}})
	b.foe, b.until = foe.ID(), now+20*20
}

// talk walks next to an NPC in sight and talks to it (or chats without one).
func (c *crowd) talk(b *crowdBot) {
	var known []*session.NPC
	for _, n := range c.w.NPCs() {
		if b.p.Knows(n.ID()) {
			known = append(known, n)
		}
	}
	if len(known) == 0 {
		c.send(b, &pb.ClientMessage{Message: &pb.ClientMessage_Say{Say: &pb.Say{Channel: pb.ChatChannel_CHAT_CHANNEL_SAY, Text: "hello"}}})
		return
	}
	n := known[c.r.IntN(len(known))]
	if crowdChebyshev(b.p.Pos(), n.Pos()) <= 2 {
		c.send(b, talkMsg(n.ID()))
		return
	}
	if c.walkNear(b, n.Pos(), 2) {
		b.npc = n.ID()
	}
}

// crowdResult is what a run measured over its window.
type crowdResult struct {
	bytesPerPlayer float64 // B/s, average of every bot
	// The wall time of the ticks on this machine, the bots' commands included.
	tickMean, tickP99, tickMax time.Duration
}

// tick lets every bot act and runs one tick.
func (c *crowd) tick() {
	for _, b := range c.bots {
		c.act(b)
	}
	c.sim.Step()
}

// run plays warmup, then measures window.
func (c *crowd) run(warmup, window time.Duration) crowdResult {
	ticks := func(d time.Duration) int { return int(d / game.TickDuration) }
	for range ticks(warmup) {
		c.tick()
	}
	start := make([]int, len(c.bots))
	for i, b := range c.bots {
		start[i] = b.cl.bytes
	}
	wall := clock.Real{}
	durs := make([]time.Duration, 0, ticks(window))
	var sum time.Duration
	for range ticks(window) {
		t0 := wall.Now()
		c.tick()
		d := wall.Now().Sub(t0)
		durs = append(durs, d)
		sum += d
	}
	total := 0
	for i, b := range c.bots {
		total += b.cl.bytes - start[i]
	}
	slices.Sort(durs)
	return crowdResult{
		bytesPerPlayer: float64(total) / float64(len(c.bots)) / window.Seconds(),
		tickMean:       sum / time.Duration(len(durs)),
		tickP99:        durs[len(durs)*99/100],
		tickMax:        durs[len(durs)-1],
	}
}

// The output per player of the load test's scenarios (docs/07 "Pruebas de carga"),
// played in process on the real world with the wide view: within the 4 KB/s budget.
func TestCrowdBandwidth(t *testing.T) {
	if testing.Short() {
		t.Skip("plays a minute of 100 bots and half a minute of 300")
	}
	for _, tc := range []struct {
		scenario       string
		bots           int
		warmup, window time.Duration
	}{
		{"base", 100, 10 * time.Second, 60 * time.Second},
		{"stress", 300, 10 * time.Second, 30 * time.Second},
	} {
		c := newCrowd(t, tc.scenario, tc.bots)
		res := c.run(tc.warmup, tc.window)
		t.Logf("%s, %d bots: %.0f B/s per player; tick mean %v, p99 %v, max %v",
			tc.scenario, tc.bots, res.bytesPerPlayer, res.tickMean, res.tickP99, res.tickMax)
		if res.bytesPerPlayer > 4096 {
			t.Errorf("%s: %.0f B/s per player, over the 4 KB/s budget", tc.scenario, res.bytesPerPlayer)
		}
	}
}

// BenchmarkCrowdTick is one tick of TestCrowdBandwidth's scenarios on the real world,
// the bots' commands included (stress: 300 bots in the town, everyone sees everyone).
func BenchmarkCrowdTick(b *testing.B) {
	for _, sc := range []struct {
		name string
		bots int
	}{{"base", 100}, {"stress", 300}} {
		b.Run(sc.name, func(b *testing.B) {
			c := newCrowd(b, sc.name, sc.bots)
			c.run(10*time.Second, time.Second)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				c.tick()
			}
		})
	}
}

// BenchmarkFullMapView measures the area of a FullMapView (a login, a teleport, every
// portal) with its monsters and NPCs on the real world: building it and its size. In the
// town of Lanternby (on the surface: floors 0-7) and in the volcanic mine (floor 8).
func BenchmarkFullMapView(b *testing.B) {
	for _, tc := range []struct {
		name string
		at   world.Pos
	}{
		{"town", crowdTown.center},
		{"mine", world.Pos{X: 3692, Y: 5797, Z: 8}},
	} {
		b.Run(tc.name, func(b *testing.B) {
			c := newCrowd(b, "stress", 1)
			p := c.bots[0].p
			c.sim.Command(gameFunc(func() { c.w.Teleport(p, tc.at) }))
			c.sim.RunFor(2 * time.Second)
			if p.Pos() != tc.at {
				b.Fatalf("at %v, want %v", p.Pos(), tc.at)
			}
			size := proto.Size(c.w.FullViewForTest(p))
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				c.w.FullViewForTest(p)
			}
			b.ReportMetric(float64(size), "bytes/view")
		})
	}
}
