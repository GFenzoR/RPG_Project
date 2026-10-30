package game

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sync/atomic"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// Default queue sizes. They are generous for 100–300 players at the rate limits planned
// for the network layer.
const (
	DefaultQueueCapacity      = 8192
	DefaultMaxCommandsPerTick = 2048
)

// Config configures a Loop. Clock and Rand are required.
type Config struct {
	// Clock paces Run and timestamps ticks.
	Clock clock.Clock
	// Rand is the seeded random source handed to commands, events and systems.
	Rand *rand.Rand
	// Systems run in order every tick after commands and scheduled events.
	Systems []System
	// QueueCapacity bounds the command queue (default DefaultQueueCapacity).
	QueueCapacity int
	// MaxCommandsPerTick caps how many commands one tick executes
	// (default DefaultMaxCommandsPerTick). The rest wait for the next tick.
	MaxCommandsPerTick int
	// Logger receives overrun warnings. Nil discards them.
	Logger *slog.Logger
	// OnTick, if set, is called on the loop goroutine at the end of every tick.
	// It is the hook for the tick_duration_ms metric.
	OnTick func(TickStats)
}

// TickStats describes one processed tick.
type TickStats struct {
	Tick Tick
	// Duration is the clock time the tick took to process.
	Duration time.Duration
	// Commands and Events count what the tick executed.
	Commands int
	Events   int
	// Pending is the number of commands left in the queue after the tick.
	Pending int
	// Overrun reports that the tick took longer than TickDuration.
	Overrun bool
}

// Loop is the game loop. Enqueue may be called from any goroutine; Step and Run must be
// called from a single goroutine, which becomes the owner of the game state.
type Loop struct {
	clock    clock.Clock
	rand     *rand.Rand
	systems  []System
	queue    *commandQueue
	sched    *Scheduler
	maxCmds  int
	logger   *slog.Logger
	onTick   func(TickStats)
	tick     Tick
	ctx      TickContext
	running  atomic.Bool
	stepping bool
}

// New validates cfg and returns a Loop positioned before tick 1.
func New(cfg Config) (*Loop, error) {
	if cfg.Clock == nil {
		return nil, errors.New("game: Config.Clock is required")
	}
	if cfg.Rand == nil {
		return nil, errors.New("game: Config.Rand is required")
	}
	if cfg.QueueCapacity < 0 || cfg.MaxCommandsPerTick < 0 {
		return nil, fmt.Errorf("game: negative queue limits (capacity %d, per tick %d)",
			cfg.QueueCapacity, cfg.MaxCommandsPerTick)
	}
	for i, sys := range cfg.Systems {
		if sys == nil {
			return nil, fmt.Errorf("game: Config.Systems[%d] is nil", i)
		}
	}
	if cfg.QueueCapacity == 0 {
		cfg.QueueCapacity = DefaultQueueCapacity
	}
	if cfg.MaxCommandsPerTick == 0 {
		cfg.MaxCommandsPerTick = DefaultMaxCommandsPerTick
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	l := &Loop{
		clock:   cfg.Clock,
		rand:    cfg.Rand,
		systems: append([]System(nil), cfg.Systems...),
		queue:   newCommandQueue(cfg.QueueCapacity),
		sched:   NewScheduler(),
		maxCmds: cfg.MaxCommandsPerTick,
		logger:  cfg.Logger,
		onTick:  cfg.OnTick,
	}
	return l, nil
}

// Enqueue queues a command for the next tick without blocking. It is safe for concurrent
// use and returns ErrQueueFull when the queue has no room.
func (l *Loop) Enqueue(cmd Command) error {
	if cmd == nil {
		return errors.New("game: nil command")
	}
	return l.queue.enqueue(cmd)
}

// Tick returns the number of the last processed tick. Only the loop goroutine may call it
// while Run is active.
func (l *Loop) Tick() Tick { return l.tick }

// Scheduler returns the loop's scheduler. Only the loop goroutine may use it while Run is
// active; before that it can be used to seed initial events.
func (l *Loop) Scheduler() *Scheduler { return l.sched }

// Step processes exactly one tick synchronously and returns its stats. It is what Run
// calls every TickDuration, and what the sim harness calls directly.
func (l *Loop) Step() TickStats {
	if l.stepping {
		// Step was called from inside a command, event or system: refuse instead of
		// corrupting the tick in progress.
		l.logger.Error("game: reentrant Step ignored", "tick", l.tick)
		return TickStats{Tick: l.tick}
	}
	l.stepping = true
	defer func() { l.stepping = false }()

	start := l.clock.Now()
	l.tick++
	l.sched.now = l.tick // commands may schedule events; they must land after this tick
	l.ctx = TickContext{Tick: l.tick, Now: start, Rand: l.rand, Sched: l.sched}
	ctx := &l.ctx

	stats := TickStats{Tick: l.tick}
	stats.Commands = l.queue.drain(ctx, l.maxCmds)
	stats.Events = l.sched.runDue(ctx)
	for _, sys := range l.systems {
		sys.Update(ctx)
	}

	stats.Pending = l.queue.len()
	stats.Duration = l.clock.Now().Sub(start)
	stats.Overrun = stats.Duration > TickDuration
	if stats.Overrun {
		l.logger.Warn("game: tick overrun",
			"tick", uint64(stats.Tick),
			"duration_ms", stats.Duration.Milliseconds(),
			"commands", stats.Commands,
			"events", stats.Events)
	}
	if l.onTick != nil {
		l.onTick(stats)
	}
	return stats
}

// ErrAlreadyRunning is returned by Run when the loop is already running.
var ErrAlreadyRunning = errors.New("game: loop already running")

// Run steps the loop every TickDuration of clock time until ctx is cancelled, then
// returns nil. Ticks are scheduled on a fixed grid so short ticks do not drift; a tick
// that overruns is logged and the next one starts immediately, without accumulating debt.
func (l *Loop) Run(ctx context.Context) error {
	if !l.running.CompareAndSwap(false, true) {
		return ErrAlreadyRunning
	}
	defer l.running.Store(false)

	next := l.clock.Now()
	for {
		if ctx.Err() != nil {
			return nil
		}
		l.Step()

		next = next.Add(TickDuration)
		wait := next.Sub(l.clock.Now())
		if wait <= 0 {
			// Behind schedule: restart the grid from now instead of catching up.
			next = l.clock.Now()
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-l.clock.After(wait):
		}
	}
}
