package game

import (
	"math/rand/v2"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

func newBenchLoop(b *testing.B, systems ...System) *Loop {
	b.Helper()
	l, err := New(Config{
		Clock:   clock.NewFake(time.Time{}),
		Rand:    rand.New(rand.NewPCG(1, 1)),
		Systems: systems,
	})
	if err != nil {
		b.Fatal(err)
	}
	return l
}

// BenchmarkStepIdle measures the fixed cost of an empty tick.
func BenchmarkStepIdle(b *testing.B) {
	l := newBenchLoop(b)
	b.ReportAllocs()
	for b.Loop() {
		l.Step()
	}
}

// BenchmarkStepCommands measures draining 200 commands per tick (≈ 100 players at 2
// commands per tick each).
func BenchmarkStepCommands(b *testing.B) {
	l := newBenchLoop(b)
	cmd := CommandFunc(func(*TickContext) {})
	b.ReportAllocs()
	for b.Loop() {
		for range 200 {
			_ = l.Enqueue(cmd)
		}
		l.Step()
	}
}

// BenchmarkStepEvents keeps ~10 000 pending events (respawns, conditions, cooldowns) and
// runs and reschedules 500 of them every tick.
func BenchmarkStepEvents(b *testing.B) {
	var reschedule EventFunc
	reschedule = func(ctx *TickContext) { ctx.Sched.After(Tick(1+ctx.Rand.IntN(40)), reschedule) }
	l := newBenchLoop(b)
	for i := range 10_000 {
		l.Scheduler().At(Tick(1+i%20), reschedule)
	}
	b.ReportAllocs()
	for b.Loop() {
		l.Step()
	}
}
