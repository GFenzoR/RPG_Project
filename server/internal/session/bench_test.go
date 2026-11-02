package session_test

import (
	"fmt"
	"math"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
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
// 100 players (docs/07-performance-budget.md).
func BenchmarkTickMonsters(b *testing.B) {
	for _, n := range []int{256, 1024} {
		b.Run(fmt.Sprintf("players=100/monsters=%d", n), func(b *testing.B) {
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
			w, err := session.New(session.Config{
				Map:       m,
				Balance:   testBalance(),
				Vocations: testVocations,
				Monsters:  content.Monsters{"wolf": wolfDef()},
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
		})
	}
}
