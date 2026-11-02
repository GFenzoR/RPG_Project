package session_test

import (
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
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
			mv, flush := w.Systems()
			r := rand.New(rand.NewPCG(1, 2))
			loop, err := game.New(game.Config{Clock: clock.NewFake(time.Time{}), Rand: r, Systems: []game.System{mv, flush}})
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
