package game

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

func newTestLoop(t *testing.T, cfg Config) (*Loop, *clock.Fake) {
	t.Helper()
	fc := clock.NewFake(time.Time{})
	if cfg.Clock == nil {
		cfg.Clock = fc
	}
	if cfg.Rand == nil {
		cfg.Rand = rand.New(rand.NewPCG(1, 1))
	}
	l, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return l, fc
}

func TestNewValidatesConfig(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 1))
	fc := clock.NewFake(time.Time{})
	bad := []Config{
		{Rand: r},
		{Clock: fc},
		{Clock: fc, Rand: r, QueueCapacity: -1},
		{Clock: fc, Rand: r, MaxCommandsPerTick: -1},
		{Clock: fc, Rand: r, Systems: []System{nil}},
	}
	for i, cfg := range bad {
		if _, err := New(cfg); err == nil {
			t.Errorf("config %d: New succeeded, want error", i)
		}
	}
}

func TestStepOrderCommandsEventsSystems(t *testing.T) {
	var got []string
	l, _ := newTestLoop(t, Config{Systems: []System{
		SystemFunc(func(ctx *TickContext) { got = append(got, "sys1") }),
		SystemFunc(func(ctx *TickContext) { got = append(got, "sys2") }),
	}})
	l.Scheduler().At(1, func(*TickContext) { got = append(got, "event") })
	for _, name := range []string{"cmd1", "cmd2"} {
		if err := l.Enqueue(CommandFunc(func(*TickContext) { got = append(got, name) })); err != nil {
			t.Fatal(err)
		}
	}

	stats := l.Step()
	if want := []string{"cmd1", "cmd2", "event", "sys1", "sys2"}; !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	want := TickStats{Tick: 1, Commands: 2, Events: 1}
	if stats != want {
		t.Fatalf("stats = %+v, want %+v", stats, want)
	}
	if l.Tick() != 1 {
		t.Fatalf("Tick() = %d, want 1", l.Tick())
	}
}

func TestStepContext(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 7))
	var seen []TickContext
	l, fc := newTestLoop(t, Config{Rand: r, Systems: []System{
		SystemFunc(func(ctx *TickContext) { seen = append(seen, *ctx) }),
	}})
	l.Step()
	fc.Advance(TickDuration)
	l.Step()
	if len(seen) != 2 {
		t.Fatalf("system ran %d times, want 2", len(seen))
	}
	for i, ctx := range seen {
		if ctx.Tick != Tick(i+1) {
			t.Errorf("tick %d: ctx.Tick = %d", i+1, ctx.Tick)
		}
		if want := clock.Epoch.Add(time.Duration(i) * TickDuration); !ctx.Now.Equal(want) {
			t.Errorf("tick %d: ctx.Now = %v, want %v", i+1, ctx.Now, want)
		}
		if ctx.Rand != r || ctx.Sched != l.Scheduler() {
			t.Errorf("tick %d: ctx does not carry the loop's Rand and Scheduler", i+1)
		}
	}
}

func TestEnqueueCapacityAndPerTickCap(t *testing.T) {
	l, _ := newTestLoop(t, Config{QueueCapacity: 5, MaxCommandsPerTick: 2})
	ran := 0
	cmd := CommandFunc(func(*TickContext) { ran++ })
	for i := range 5 {
		if err := l.Enqueue(cmd); err != nil {
			t.Fatalf("Enqueue %d: %v", i, err)
		}
	}
	if err := l.Enqueue(cmd); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("Enqueue on full queue = %v, want ErrQueueFull", err)
	}
	if err := l.Enqueue(nil); err == nil {
		t.Fatal("Enqueue(nil) succeeded")
	}

	var perTick []int
	for range 4 {
		s := l.Step()
		perTick = append(perTick, s.Commands)
	}
	if want := []int{2, 2, 1, 0}; !slices.Equal(perTick, want) {
		t.Fatalf("commands per tick = %v, want %v", perTick, want)
	}
	if ran != 5 {
		t.Fatalf("ran %d commands, want 5", ran)
	}
}

func TestEnqueueConcurrent(t *testing.T) {
	const producers, each = 8, 100
	l, _ := newTestLoop(t, Config{QueueCapacity: producers * each})
	var wg sync.WaitGroup
	for range producers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range each {
				if err := l.Enqueue(CommandFunc(func(*TickContext) {})); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	if s := l.Step(); s.Commands != producers*each {
		t.Fatalf("ran %d commands, want %d", s.Commands, producers*each)
	}
}

func TestCommandSchedulesEventForNextTick(t *testing.T) {
	l, _ := newTestLoop(t, Config{})
	var ranAt Tick
	_ = l.Enqueue(CommandFunc(func(ctx *TickContext) {
		ctx.Sched.After(0, func(ctx *TickContext) { ranAt = ctx.Tick })
	}))
	l.Step()
	if ranAt != 0 {
		t.Fatalf("event scheduled in tick 1 ran in tick %d", ranAt)
	}
	l.Step()
	if ranAt != 2 {
		t.Fatalf("event ran at tick %d, want 2", ranAt)
	}
}

func TestStepReportsOverrun(t *testing.T) {
	var logs bytes.Buffer
	var stats []TickStats
	var fc *clock.Fake
	slow := true
	l, fc := newTestLoop(t, Config{
		Logger: slog.New(slog.NewTextHandler(&logs, nil)),
		OnTick: func(s TickStats) { stats = append(stats, s) },
		Systems: []System{SystemFunc(func(*TickContext) {
			if slow {
				fc.Advance(70 * time.Millisecond)
			}
		})},
	})
	l.Step()
	slow = false
	l.Step()

	if len(stats) != 2 {
		t.Fatalf("OnTick called %d times, want 2", len(stats))
	}
	if !stats[0].Overrun || stats[0].Duration != 70*time.Millisecond {
		t.Fatalf("slow tick stats = %+v, want overrun of 70ms", stats[0])
	}
	if stats[1].Overrun {
		t.Fatalf("fast tick reported overrun: %+v", stats[1])
	}
	if !strings.Contains(logs.String(), "tick overrun") {
		t.Fatalf("overrun not logged; logs: %q", logs.String())
	}
}

func TestReentrantStepIsIgnored(t *testing.T) {
	var l *Loop
	l, _ = newTestLoop(t, Config{Systems: []System{
		SystemFunc(func(*TickContext) { l.Step() }),
	}})
	l.Step()
	if l.Tick() != 1 {
		t.Fatalf("Tick() = %d after reentrant Step, want 1", l.Tick())
	}
}

// TestRunPacesTicksWithClock drives Run with a fake clock: one tick per TickDuration.
func TestRunPacesTicksWithClock(t *testing.T) {
	ticks := make(chan TickStats, 100)
	l, fc := newTestLoop(t, Config{OnTick: func(s TickStats) { ticks <- s }})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- l.Run(ctx) }()

	// Tick 1 runs immediately; then Run parks on the clock until we advance it.
	if s := <-ticks; s.Tick != 1 {
		t.Fatalf("first tick = %d, want 1", s.Tick)
	}
	for want := Tick(2); want <= 5; want++ {
		fc.BlockUntil(1)
		fc.Advance(TickDuration - time.Millisecond)
		select {
		case s := <-ticks:
			t.Fatalf("tick %d ran early", s.Tick)
		default:
		}
		fc.Advance(time.Millisecond)
		if s := <-ticks; s.Tick != want {
			t.Fatalf("tick = %d, want %d", s.Tick, want)
		}
	}

	fc.BlockUntil(1)
	if err := l.Run(ctx); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second Run = %v, want ErrAlreadyRunning", err)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run returned %v", err)
	}
}

// TestRunDoesNotAccumulateDebt checks that after an overrun the next tick starts at once
// and the grid restarts from there instead of firing catch-up ticks.
func TestRunDoesNotAccumulateDebt(t *testing.T) {
	ticks := make(chan TickStats, 100)
	var fc *clock.Fake
	l, fc := newTestLoop(t, Config{
		OnTick: func(s TickStats) { ticks <- s },
		Systems: []System{SystemFunc(func(ctx *TickContext) {
			if ctx.Tick == 1 {
				fc.Advance(3 * TickDuration) // a very slow first tick
			}
		})},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- l.Run(ctx) }()

	if s := <-ticks; !s.Overrun {
		t.Fatalf("tick 1 = %+v, want overrun", s)
	}
	// Tick 2 starts without waiting for the clock.
	if s := <-ticks; s.Tick != 2 {
		t.Fatalf("tick = %d, want 2", s.Tick)
	}
	// Tick 3 waits a full TickDuration: no catch-up burst.
	fc.BlockUntil(1)
	select {
	case s := <-ticks:
		t.Fatalf("catch-up tick %d ran without waiting", s.Tick)
	default:
	}
	fc.Advance(TickDuration)
	if s := <-ticks; s.Tick != 3 {
		t.Fatalf("tick = %d, want 3", s.Tick)
	}
	fc.BlockUntil(1)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run returned %v", err)
	}
}

func TestRunStopsOnCancelledContext(t *testing.T) {
	l, _ := newTestLoop(t, Config{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := l.Run(ctx); err != nil {
		t.Fatalf("Run = %v", err)
	}
	if l.Tick() != 0 {
		t.Fatalf("Run with cancelled context processed %d ticks", l.Tick())
	}
}
