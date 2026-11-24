package session_test

import (
	"fmt"
	"math"
	"math/rand/v2"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/explore"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

type discardClient struct{ events int }

func (c *discardClient) Send(b *pb.ServerBatch) bool { c.events += len(b.Events); return true }
func (c *discardClient) Close(pb.DisconnectReason)   {}

// BenchmarkTickPlayersWalking measures one tick of the loop with N players walking
// random paths in a 128x128 area (a crowded town: ~40 players in each view at N=300):
// commands, movement, AOI events and batch building. Serialization happens in the
// gateway's writer goroutines and is not included. Budget: p99 < 10 ms at N=100
// (docs/07-performance-budget.md).
func BenchmarkTickPlayersWalking(b *testing.B) {
	for _, n := range []int{100, 300} {
		b.Run(fmt.Sprintf("players=%d", n), func(b *testing.B) {
			w, err := session.New(session.Config{
				Map:       worldtest.Open(b, 0, 0, 128, 128),
				Balance:   testBalance(),
				Vocations: testVocations,
				Save:      func(session.Snapshot) bool { return true },
			})
			if err != nil {
				b.Fatal(err)
			}
			mv, fight, flush := w.Systems()
			r := rand.New(rand.NewPCG(1, 2))
			loop, err := game.New(game.Config{Clock: clock.NewFake(time.Time{}), Rand: r, Systems: []game.System{mv, fight, flush}})
			if err != nil {
				b.Fatal(err)
			}
			clients := make([]*discardClient, n)
			for i := range clients {
				clients[i] = &discardClient{}
				c := session.Character{ID: int64(i + 1), Name: "P", Vocation: "guardian", Level: 1, Health: 145,
					HasPos: true, Pos: pos(r.IntN(128), r.IntN(128))}
				_ = loop.Enqueue(w.Join(c, clients[i]))
			}
			loop.Step()
			steps := make([]pb.Direction, 10)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				for _, p := range w.Players() {
					if !p.Walking() && r.IntN(4) == 0 {
						for i := range steps {
							steps[i] = pb.Direction(1 + r.IntN(8))
						}
						_ = loop.Enqueue(w.Input(clients[p.ID()-1], walkPath(steps...)))
					}
				}
				loop.Step()
			}
			b.StopTimer()
			events := 0
			for _, c := range clients {
				events += c.events
			}
			b.ReportMetric(float64(events)/float64(b.N)/float64(n), "events/player/tick")
		})
	}
}

// BenchmarkTickMonsters measures one tick with 100 players walking in a 256x256 area
// among N aggressive monsters (spawns of 4 every 16 tiles): AI in active sectors,
// chasing, melee and the AOI events of all of it. Budget as above: p99 < 10 ms at
// 100 players (docs/07-performance-budget.md). The portal variants add one teleport in a
// corner: a map with portals reads FlagPortalStep in every A* expansion, reroute and
// monsterCanEnter (Map.MovesOnStep), which a map without any skips; every island of the
// real world has portals. The leash variant runs with balance combat.monster_leash_tiles
// 6, as data/balance.yaml (its checks of the way to the target, chase); the areas variant
// gives the wolves a circle of radius 2 around themselves every 2 s (monsterArea: its
// tiles, their line of sight and effects, the players in it).
func BenchmarkTickMonsters(b *testing.B) {
	for _, n := range []int{256, 1024} {
		for _, portal := range []bool{false, true} {
			name := fmt.Sprintf("players=100/monsters=%d", n)
			if portal {
				name += "/portal"
			}
			b.Run(name, func(b *testing.B) { benchMonsters(b, n, portal, benchPlain) })
		}
	}
	b.Run("players=100/monsters=1024/leash", func(b *testing.B) { benchMonsters(b, 1024, false, benchLeash) })
	b.Run("players=100/monsters=1024/areas", func(b *testing.B) { benchMonsters(b, 1024, false, benchAreas) })
}

// Variants of benchMonsters.
const (
	benchPlain = iota
	benchLeash
	benchAreas
)

func benchMonsters(b *testing.B, n int, portal bool, variant int) {
	m := worldtest.Open(b, 0, 0, 256, 256)
	step := 256 / int(math.Sqrt(float64(n/4)))
	var spawns []world.Spawn
	for y := step / 2; y < 256; y += step {
		for x := step / 2; x < 256; x += step {
			spawns = append(spawns, world.Spawn{ID: "s", Center: pos(x, y), Radius: 3, RespawnSeconds: 30,
				Monsters: []world.SpawnMonster{{Monster: "wolf", Count: 4}}})
		}
	}
	m.Islands()[0].Spawns = spawns
	if portal {
		m = worldtest.WithPortals(b, m, world.Portal{ID: "gate", Kind: world.PortalTeleport, From: pos(255, 0), To: pos(253, 2)})
	}
	bal, wolf := testBalance(), wolfDef()
	switch variant {
	case benchLeash:
		bal.Combat.MonsterLeashTiles = 6
	case benchAreas:
		wolf.Attacks = append(wolf.Attacks, content.MonsterAttack{Type: "spell", Element: "fire", Min: 1, Max: 4,
			IntervalMs: 2000, Chance: 1, Area: &content.AttackArea{Shape: content.AreaCircle, Radius: 2, Center: content.AreaSelf}})
	}
	w, err := session.New(session.Config{
		Map:       m,
		Balance:   bal,
		Vocations: testVocations,
		Monsters:  content.Monsters{"wolf": wolf},
		Items:     testItems(),
		Save:      func(session.Snapshot) bool { return true },
	})
	if err != nil {
		b.Fatal(err)
	}
	mv, fight, flush := w.Systems()
	r := rand.New(rand.NewPCG(1, 2))
	loop, err := game.New(game.Config{Clock: clock.NewFake(time.Time{}), Rand: r, Systems: []game.System{mv, fight, flush}})
	if err != nil {
		b.Fatal(err)
	}
	const players = 100
	clients := make([]*discardClient, players)
	for i := range clients {
		clients[i] = &discardClient{}
		c := session.Character{ID: int64(i + 1), Name: "P", Vocation: "guardian", Level: 1, Health: 145,
			HasPos: true, Pos: pos(r.IntN(256), r.IntN(256))}
		_ = loop.Enqueue(w.Join(c, clients[i]))
	}
	loop.Step()
	byID := map[uint32]*discardClient{}
	for i, p := range w.Players() {
		byID[p.ID()] = clients[i]
	}
	steps := make([]pb.Direction, 10)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		for _, p := range w.Players() {
			if !p.Walking() && r.IntN(4) == 0 {
				for i := range steps {
					steps[i] = pb.Direction(1 + r.IntN(8))
				}
				_ = loop.Enqueue(w.Input(byID[p.ID()], walkPath(steps...)))
			}
		}
		loop.Step()
	}
	b.StopTimer()
	b.ReportMetric(float64(len(w.Monsters())), "monsters")
}

// BenchmarkTickConditions is BenchmarkTickMonsters with every player and every monster
// poisoned (one hit a second each) and slowed for the whole run (T3.2): the cost of the
// condition events on top of walking, AI and combat. Conditions are scheduler events,
// so this should stay close to BenchmarkTickMonsters.
func BenchmarkTickConditions(b *testing.B) {
	const n = 1024
	m := worldtest.Open(b, 0, 0, 256, 256)
	step := 256 / int(math.Sqrt(float64(n/4)))
	var spawns []world.Spawn
	for y := step / 2; y < 256; y += step {
		for x := step / 2; x < 256; x += step {
			spawns = append(spawns, world.Spawn{ID: "s", Center: pos(x, y), Radius: 3, RespawnSeconds: 30,
				Monsters: []world.SpawnMonster{{Monster: "wolf", Count: 4}}})
		}
	}
	m.Islands()[0].Spawns = spawns
	bal := testBalance()
	bal.Conditions = content.ConditionDefs{
		"poison": {ID: "poison", Kind: content.ConditionDamage, Element: "earth", IntervalMs: 1000, MaxTicks: 1 << 30, Stacking: content.StackAdd},
		"slowed": {ID: "slowed", Kind: content.ConditionSpeed, SpeedPct: -20, MaxMs: 1 << 30, Stacking: content.StackRefresh},
	}
	wolf := wolfDef()
	wolf.Health = 1 << 30 // poison never kills them during the run
	w, err := session.New(session.Config{
		Map: m, Balance: bal, Vocations: testVocations, Monsters: content.Monsters{"wolf": wolf}, Items: testItems(),
		Save: func(session.Snapshot) bool { return true },
	})
	if err != nil {
		b.Fatal(err)
	}
	mv, fight, flush := w.Systems()
	r := rand.New(rand.NewPCG(1, 2))
	loop, err := game.New(game.Config{Clock: clock.NewFake(time.Time{}), Rand: r, Systems: []game.System{mv, fight, flush}})
	if err != nil {
		b.Fatal(err)
	}
	const players = 100
	byID := map[uint32]*discardClient{}
	clients := make([]*discardClient, players)
	for i := range clients {
		clients[i] = &discardClient{}
		c := session.Character{ID: int64(i + 1), Name: "P", Vocation: "guardian", Level: 1, Health: 145,
			HasPos: true, Pos: pos(r.IntN(256), r.IntN(256))}
		_ = loop.Enqueue(w.Join(c, clients[i]))
	}
	loop.Step()
	loop.Step() // monsters spawn
	poison := &content.ConditionApply{ID: "poison", Ticks: 1 << 30, Damage: 1}
	slow := &content.ConditionApply{ID: "slowed", DurationMs: 1 << 30}
	_ = loop.Enqueue(game.CommandFunc(func(ctx *game.TickContext) {
		for i, p := range w.Players() {
			byID[p.ID()] = clients[i]
			w.ApplyConditionForTest(ctx, p, nil, poison, 0)
			w.ApplyConditionForTest(ctx, p, nil, slow, 0)
		}
		for _, mo := range w.Monsters() {
			w.ApplyConditionForTest(ctx, nil, mo, poison, 0)
			w.ApplyConditionForTest(ctx, nil, mo, slow, 0)
		}
	}))
	loop.Step()
	steps := make([]pb.Direction, 10)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		for _, p := range w.Players() {
			if !p.Walking() && r.IntN(4) == 0 {
				for i := range steps {
					steps[i] = pb.Direction(1 + r.IntN(8))
				}
				_ = loop.Enqueue(w.Input(byID[p.ID()], walkPath(steps...)))
			}
			if cur, _ := p.Health(); cur < 50 {
				_ = loop.Enqueue(gameFunc(func() { w.RestoreForTest(p) }))
			}
		}
		loop.Step()
	}
	b.StopTimer()
	b.ReportMetric(float64(2*(len(w.Monsters())+len(w.Players()))), "conditions")
}

// BenchmarkDoorLockRefused measures one tick in which a key holder tries to lock a gate
// with a player without the key in the room behind it: the worst try (docs/02 "Puertas
// con llave", docs/07). The room (3968 tiles, near the 4096 a room may have) is worked out
// once at start; a try looks at the players of the room's sectors only. Here every one
// of them is in the room: 150 carry the key at the bottom of a 40-item chest (each costs a
// walk of its bags), and the one without it is the last one looked at. 50 more players
// stand outside. door_cooldown_ms is one tick here, so every tick runs the whole check (a
// player tries at most twice a second in the game). Budget: a small fraction of the 10 ms
// tick.
func BenchmarkDoorLockRefused(b *testing.B) {
	m := field(b, 128, 128, 96, 0, 127, 64)
	items := doorTestItems(true)
	var chest content.Item
	_ = yaml.Unmarshal([]byte("{id: bench_chest, kind: container, weight: 100, container: {slots: 40}}"), &chest)
	chest.Numeric = 170
	items[chest.ID] = &chest
	bal := testBalance()
	bal.Inventory.DoorCooldownMs = 1
	w, err := session.New(session.Config{
		Map: m, Balance: bal, Vocations: testVocations, Items: items,
		Save: func(session.Snapshot) bool { return true },
	})
	if err != nil {
		b.Fatal(err)
	}
	mv, fight, flush := w.Systems()
	r := rand.New(rand.NewPCG(1, 2))
	loop, err := game.New(game.Config{Clock: clock.NewFake(time.Time{}), Rand: r, Systems: []game.System{mv, fight, flush}})
	if err != nil {
		b.Fatal(err)
	}
	// keyAtTheBottom is a character at p with a chest of 39 swords and the gate key last.
	keyAtTheBottom := func(id int64, p world.Pos) session.Character {
		c := withPack(id, p)
		in := make([]session.ItemState, 0, 40)
		for i := range 39 {
			in = append(in, session.ItemState{ItemID: swordID, Count: 1, Slot: i})
		}
		in = append(in, session.ItemState{ItemID: gateKeyID, Count: 1, Slot: 39})
		c.Inventory = []session.ItemState{{ItemID: chest.Numeric, Count: 1, Slot: int(slotBackpack), Items: in}}
		return c
	}
	gate := pos(64, 96)
	holder := &discardClient{}
	_ = loop.Enqueue(w.Join(keyAtTheBottom(1, pos(64, 95)), holder))
	for i := range 50 {
		_ = loop.Enqueue(w.Join(withPack(int64(i+2), pos(r.IntN(128), r.IntN(90))), &discardClient{}))
	}
	for i := range 150 { // in the room, rows 98..127, every tile its own
		_ = loop.Enqueue(w.Join(keyAtTheBottom(int64(i+100), pos(i%120, 98+i/120*2)), &discardClient{}))
	}
	_ = loop.Enqueue(w.Join(withPack(999, pos(127, 127)), &discardClient{})) // without the key, looked at last
	loop.Step()
	if n := len(w.Players()); n != 202 {
		b.Fatalf("%d players", n)
	}
	_ = loop.Enqueue(w.Input(holder, useItem(onTile(gate), worldtest.Door, 1)))
	loop.Step()
	if !w.Walkable(gate) {
		b.Fatal("the gate did not open")
	}
	lock := useItem(onTile(gate), worldtest.OpenDoor, 1)
	loop.Step()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_ = loop.Enqueue(w.Input(holder, lock))
		loop.Step()
	}
	b.StopTimer()
	if !w.Walkable(gate) {
		b.Fatal("the gate locked on a player without the key")
	}
	if holder.events < b.N {
		b.Fatalf("%d answers to %d tries", holder.events, b.N)
	}
}

// BenchmarkThrowAway measures one tick in which a player throws one coin on the street and
// picks it back up (two commands). Throwing something away keeps the player's snapshot of
// the end of that command for its next transfer (T5.3 fail-safe, hold.go gaveAway): its
// cost is one snapshot of a player carrying a 40-item chest, taken in the loop (no write
// until a transfer follows). Budget: a small fraction of the 10 ms tick (docs/07).
func BenchmarkThrowAway(b *testing.B) {
	items := testItems()
	var chest content.Item
	_ = yaml.Unmarshal([]byte("{id: bench_chest, kind: container, weight: 100, container: {slots: 40}}"), &chest)
	chest.Numeric = 170
	items[chest.ID] = &chest
	w, err := session.New(session.Config{
		Map: worldtest.Open(b, 0, 0, 32, 32), Balance: testBalance(), Vocations: testVocations, Items: items,
		Save: func(session.Snapshot) bool { return true },
	})
	if err != nil {
		b.Fatal(err)
	}
	mv, fight, flush := w.Systems()
	loop, err := game.New(game.Config{Clock: clock.NewFake(time.Time{}), Rand: rand.New(rand.NewPCG(1, 2)),
		Systems: []game.System{mv, fight, flush}})
	if err != nil {
		b.Fatal(err)
	}
	c := withPack(1, pos(10, 10))
	in := make([]session.ItemState, 0, 40)
	in = append(in, session.ItemState{ItemID: coinID, Count: 50, Slot: 0})
	for i := range 39 {
		in = append(in, session.ItemState{ItemID: swordID, Count: 1, Slot: i + 1})
	}
	c.Inventory = []session.ItemState{{ItemID: chest.Numeric, Count: 1, Slot: int(slotBackpack), Items: in}}
	cl := &discardClient{}
	_ = loop.Enqueue(w.Join(c, cl))
	loop.Step()
	_ = loop.Enqueue(w.Input(cl, useItem(inSlot(slotBackpack), uint32(chest.Numeric), 0)))
	loop.Step()
	const window = 1 // the first container p opens
	throw := moveItem(inContainer(window, 0), coinID, 0, onTile(pos(11, 10)), 1)
	back := moveItem(onTile(pos(11, 10)), coinID, 1, inContainer(window, 0), 1)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_ = loop.Enqueue(w.Input(cl, throw))
		_ = loop.Enqueue(w.Input(cl, back))
		loop.Step()
	}
	b.StopTimer()
	if p := w.PlayerByCharacter(1); p == nil || w.CountItem(p, "copper_coin") != 50 {
		b.Fatal("the coin did not come back")
	}
}

// BenchmarkMinimapRequestBurst measures the worst tick one client can force with
// MinimapRequest (docs/07 "Minimapa"): its whole budget at once, two requests of 16
// sectors, every tile of them explored (32 sectors: 32 768 tile and stack reads, the
// palettes and 32 sectors of ~1.2 KB). The 20 ticks that refill the budget are not timed.
func BenchmarkMinimapRequestBurst(b *testing.B) {
	w, err := session.New(session.Config{
		Map:       worldtest.Open(b, 0, 0, 256, 256),
		Balance:   testBalance(),
		Vocations: testVocations,
		Save:      func(session.Snapshot) bool { return true },
	})
	if err != nil {
		b.Fatal(err)
	}
	mv, fight, flush := w.Systems()
	loop, err := game.New(game.Config{Clock: clock.NewFake(time.Time{}), Rand: rand.New(rand.NewPCG(1, 2)), Systems: []game.System{mv, fight, flush}})
	if err != nil {
		b.Fatal(err)
	}
	var explored []explore.SectorState
	full := explore.Sector{}
	for i := range full {
		full[i] = 0xFF
	}
	reqs := make([]*pb.ClientMessage, 2)
	for i := range reqs {
		ids := make([]uint32, 16)
		for j := range ids {
			sx, sy := j%8, i*2+j/8
			ids[j] = uint32(sx)<<16 | uint32(sy)
			explored = append(explored, explore.SectorState{Key: explore.MakeKey(7, sx, sy), Bits: full})
		}
		reqs[i] = &pb.ClientMessage{Message: &pb.ClientMessage_MinimapRequest{MinimapRequest: &pb.MinimapRequest{Z: 7, Sectors: ids}}}
	}
	cl := &discardClient{}
	_ = loop.Enqueue(w.Join(session.Character{ID: 1, Name: "P", Vocation: "guardian", Level: 1, Health: 145,
		HasPos: true, Pos: pos(100, 100), Explored: explored}, cl))
	loop.Step()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		b.StopTimer()
		for range 20 {
			loop.Step()
		}
		before := cl.events
		for _, r := range reqs {
			_ = loop.Enqueue(w.Input(cl, r))
		}
		b.StartTimer()
		loop.Step()
		if cl.events-before < len(reqs) {
			b.Fatalf("%d of %d requests answered", cl.events-before, len(reqs))
		}
	}
}
