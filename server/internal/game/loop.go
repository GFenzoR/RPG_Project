package game

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"runtime/debug"
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
	// Panics counts commands, events and systems that panicked and were dropped.
	Panics int
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
	panics   int
	// Method values bound once in New so Step does not allocate them every tick.
	execCmd   func(Command)
	execEvent func(EventFunc)
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
	l.execCmd = l.runCommand
	l.execEvent = l.runEvent
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
// calls every TickDuration, and what the sim harness calls directly. Never call it from
// another goroutine while Run is active.
//
// A command, event or system that panics is logged with its stack and dropped; the rest
// of the tick goes on. One buggy handler must not take every player offline.
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

	l.panics = 0
	stats := TickStats{Tick: l.tick}
	stats.Commands = l.queue.drain(l.maxCmds, l.execCmd)
	stats.Events = l.sched.runDue(l.tick, l.execEvent)
	for _, sys := range l.systems {
		l.runSystem(sys)
	}

	stats.Panics = l.panics
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

func (l *Loop) runCommand(cmd Command) {
	defer func() {
		if r := recover(); r != nil {
			l.reportPanic(r, "command", cmd)
		}
	}()
	cmd.Execute(&l.ctx)
}

func (l *Loop) runEvent(fn EventFunc) {
	defer func() {
		if r := recover(); r != nil {
			l.reportPanic(r, "event", nil)
		}
	}()
	fn(&l.ctx)
}

func (l *Loop) runSystem(sys System) {
	defer func() {
		if r := recover(); r != nil {
			l.reportPanic(r, "system", sys)
		}
	}()
	sys.Update(&l.ctx)
}

// reportPanic logs a recovered panic of one unit of work. unit, if not nil, is the
// command or system that panicked; its type is logged to identify it.
func (l *Loop) reportPanic(r any, kind string, unit any) {
	l.panics++
	attrs := []any{"kind", kind, "tick", uint64(l.tick), "panic", fmt.Sprint(r)}
	if unit != nil {
		attrs = append(attrs, "type", fmt.Sprintf("%T", unit))
	}
	attrs = append(attrs, "stack", string(debug.Stack()))
	l.logger.Error("game: recovered panic, unit dropped", attrs...)
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
