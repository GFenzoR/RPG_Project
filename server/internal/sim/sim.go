// Package sim is the deterministic simulation harness for game tests.
//
// A Sim wires a game.Loop to a fake clock and a seeded random source and steps it
// synchronously: no goroutines, no wall clock. The same seed and the same commands always
// produce the same run.
//
//	s := sim.New(t, sim.WithSeed(42), sim.WithSystems(mySystem))
//	s.Command(game.CommandFunc(func(ctx *game.TickContext) { ... }))
//	s.RunUntil(func() bool { return done }, sim.MaxSeconds(10))
//
// World, players and monsters arrive with later roadmap tasks (T1.2+).
package sim

import (
	"math/rand/v2"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

// DefaultSeed is used when no WithSeed option is given.
const DefaultSeed uint64 = 1

// Sim is a deterministic, synchronously stepped game loop.
type Sim struct {
	t     testing.TB
	clock *clock.Fake
	rand  *rand.Rand
	loop  *game.Loop
	last  game.TickStats
}

type options struct {
	seed    uint64
	start   time.Time
	systems []game.System
	cfg     game.Config
}

// Option configures a Sim.
type Option func(*options)

// WithSeed sets the seed of the random source (default DefaultSeed).
func WithSeed(seed uint64) Option { return func(o *options) { o.seed = seed } }

// WithStart sets the fake clock's start time (default clock.Epoch).
func WithStart(start time.Time) Option { return func(o *options) { o.start = start } }

// WithSystems appends systems that run every tick, in order.
func WithSystems(systems ...game.System) Option {
	return func(o *options) { o.systems = append(o.systems, systems...) }
}

// WithQueueLimits overrides the command queue capacity and per-tick cap.
func WithQueueLimits(capacity, perTick int) Option {
	return func(o *options) {
		o.cfg.QueueCapacity = capacity
		o.cfg.MaxCommandsPerTick = perTick
	}
}

// New builds a Sim positioned before tick 1. It fails the test if the loop cannot be built.
func New(t testing.TB, opts ...Option) *Sim {
	t.Helper()
	o := options{seed: DefaultSeed}
	for _, opt := range opts {
		opt(&o)
	}
	s := &Sim{
		t:     t,
		clock: clock.NewFake(o.start),
		rand:  rand.New(rand.NewPCG(o.seed, o.seed)),
	}
	cfg := o.cfg
	cfg.Clock = s.clock
	cfg.Rand = s.rand
	cfg.Systems = o.systems
	loop, err := game.New(cfg)
	if err != nil {
		t.Fatalf("sim: %v", err)
	}
	s.loop = loop
	return s
}

// Loop returns the underlying game loop.
func (s *Sim) Loop() *game.Loop { return s.loop }

// Clock returns the fake clock.
func (s *Sim) Clock() *clock.Fake { return s.clock }

// Rand returns the seeded random source shared with the loop.
func (s *Sim) Rand() *rand.Rand { return s.rand }

// Tick returns the number of the last processed tick.
func (s *Sim) Tick() game.Tick { return s.loop.Tick() }

// Now returns the fake clock time.
func (s *Sim) Now() time.Time { return s.clock.Now() }

// Elapsed returns the game time simulated so far.
func (s *Sim) Elapsed() time.Duration { return s.loop.Tick().Duration() }

// LastStats returns the stats of the last processed tick.
func (s *Sim) LastStats() game.TickStats { return s.last }

// Command enqueues cmd for the next tick, failing the test if the queue is full.
func (s *Sim) Command(cmd game.Command) {
	s.t.Helper()
	if err := s.loop.Enqueue(cmd); err != nil {
		s.t.Fatalf("sim: enqueue at tick %d: %v", s.Tick(), err)
	}
}

// Schedule schedules fn delay ticks after the current tick (at least one).
func (s *Sim) Schedule(delay game.Tick, fn game.EventFunc) game.EventID {
	return s.loop.Scheduler().After(delay, fn)
}

// Step processes one tick and then advances the clock by game.TickDuration, so every
// tick starts exactly one TickDuration after the previous one.
func (s *Sim) Step() game.TickStats {
	start := s.clock.Now()
	s.last = s.loop.Step()
	s.clock.Set(start.Add(game.TickDuration)) // no-op if the tick itself ran longer
	return s.last
}

// RunTicks processes n ticks.
func (s *Sim) RunTicks(n int) {
	for range n {
		s.Step()
	}
}

// RunFor processes the ticks that fit in d of game time (rounded up).
func (s *Sim) RunFor(d time.Duration) {
	s.RunTicks(int(game.TicksFor(d)))
}

// Limit bounds RunUntil.
type Limit struct{ ticks game.Tick }

// MaxTicks limits RunUntil to n ticks.
func MaxTicks(n int) Limit { return Limit{ticks: game.Tick(max(n, 0))} }

// MaxSeconds limits RunUntil to n seconds of game time.
func MaxSeconds(n float64) Limit {
	return Limit{ticks: game.TicksFor(time.Duration(n * float64(time.Second)))}
}

// RunUntil steps until cond returns true and returns how many ticks it took. cond is
// checked before each tick, so a condition that already holds takes zero ticks. It fails
// the test if the limit is reached first.
func (s *Sim) RunUntil(cond func() bool, limit Limit) int {
	s.t.Helper()
	for n := 0; ; n++ {
		if cond() {
			return n
		}
		if game.Tick(n) >= limit.ticks {
			s.t.Fatalf("sim: condition not met after %d ticks (%v of game time)",
				n, game.Tick(n).Duration())
			return n
		}
		s.Step()
	}
}
