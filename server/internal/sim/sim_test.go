package sim

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

// spawner is a toy system: every tick it may "spawn" something that "dies" after a random
// number of ticks, logging every decision. It exercises commands, the scheduler and the
// random source together.
type spawner struct {
	log []string
}

func (sp *spawner) Update(ctx *game.TickContext) {
	if ctx.Rand.IntN(4) != 0 {
		return
	}
	id := len(sp.log)
	life := game.Tick(1 + ctx.Rand.IntN(30))
	sp.log = append(sp.log, fmt.Sprintf("t%d spawn %d life %d", ctx.Tick, id, life))
	ctx.Sched.After(life, func(ctx *game.TickContext) {
		sp.log = append(sp.log, fmt.Sprintf("t%d despawn %d", ctx.Tick, id))
	})
}

func runScenario(t *testing.T, seed uint64) []string {
	t.Helper()
	sp := &spawner{}
	s := New(t, WithSeed(seed), WithSystems(sp))
	for i := range 10 {
		s.RunTicks(7)
		s.Command(game.CommandFunc(func(ctx *game.TickContext) {
			sp.log = append(sp.log, fmt.Sprintf("t%d cmd %d roll %d", ctx.Tick, i, ctx.Rand.IntN(100)))
		}))
	}
	s.RunFor(5 * time.Second)
	return sp.log
}

func TestSameSeedSameRun(t *testing.T) {
	a := runScenario(t, 42)
	b := runScenario(t, 42)
	if len(a) < 20 {
		t.Fatalf("scenario too small to be meaningful: %d entries", len(a))
	}
	if !slices.Equal(a, b) {
		t.Fatalf("same seed produced different runs:\n%v\n%v", a, b)
	}
	if c := runScenario(t, 43); slices.Equal(a, c) {
		t.Fatal("different seeds produced identical runs")
	}
}

func TestStepAdvancesClockAndTick(t *testing.T) {
	s := New(t)
	if s.Tick() != 0 || !s.Now().Equal(clock.Epoch) {
		t.Fatalf("new sim at tick %d, time %v", s.Tick(), s.Now())
	}
	s.RunTicks(3)
	if s.Tick() != 3 {
		t.Fatalf("Tick() = %d, want 3", s.Tick())
	}
	if want := clock.Epoch.Add(150 * time.Millisecond); !s.Now().Equal(want) {
		t.Fatalf("Now() = %v, want %v", s.Now(), want)
	}
	s.RunFor(time.Second)
	if s.Tick() != 23 || s.Elapsed() != 1150*time.Millisecond {
		t.Fatalf("after RunFor(1s): tick %d, elapsed %v", s.Tick(), s.Elapsed())
	}
}

func TestStepKeepsSlowTickTime(t *testing.T) {
	var s *Sim
	s = New(t, WithSystems(game.SystemFunc(func(ctx *game.TickContext) {
		if ctx.Tick == 1 {
			s.Clock().Advance(80 * time.Millisecond)
		}
	})))
	st := s.Step()
	if !st.Overrun || s.LastStats() != st {
		t.Fatalf("stats = %+v, want overrun", st)
	}
	if want := clock.Epoch.Add(80 * time.Millisecond); !s.Now().Equal(want) {
		t.Fatalf("Now() = %v, want %v (time must not go back)", s.Now(), want)
	}
}

func TestRunUntil(t *testing.T) {
	s := New(t)
	fired := false
	s.Schedule(game.TicksFor(2*time.Second), func(*game.TickContext) { fired = true })
	n := s.RunUntil(func() bool { return fired }, MaxSeconds(3))
	if n != 40 || s.Tick() != 40 {
		t.Fatalf("RunUntil took %d ticks (now at %d), want 40", n, s.Tick())
	}
	if n := s.RunUntil(func() bool { return true }, MaxTicks(0)); n != 0 {
		t.Fatalf("already-true condition took %d ticks", n)
	}
}

// fakeTB records Fatalf calls instead of stopping the test.
type fakeTB struct {
	testing.TB
	fatal string
}

func (f *fakeTB) Helper() {}
func (f *fakeTB) Fatalf(format string, args ...any) {
	f.fatal = fmt.Sprintf(format, args...)
}

func TestRunUntilFailsAtLimit(t *testing.T) {
	tb := &fakeTB{TB: t}
	s := New(tb)
	n := s.RunUntil(func() bool { return false }, MaxTicks(5))
	if n != 5 || s.Tick() != 5 {
		t.Fatalf("RunUntil ran %d ticks (now at %d), want 5", n, s.Tick())
	}
	if tb.fatal == "" {
		t.Fatal("RunUntil did not fail the test at its limit")
	}
}

func TestCommandFailsWhenQueueFull(t *testing.T) {
	tb := &fakeTB{TB: t}
	s := New(tb, WithQueueLimits(1, 1))
	noop := game.CommandFunc(func(*game.TickContext) {})
	s.Command(noop)
	if tb.fatal != "" {
		t.Fatalf("first command failed: %s", tb.fatal)
	}
	s.Command(noop)
	if tb.fatal == "" {
		t.Fatal("enqueue on a full queue did not fail the test")
	}
}
