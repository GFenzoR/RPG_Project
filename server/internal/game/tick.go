// Package game holds the game loop: the single goroutine that owns and mutates the world.
//
// Each tick (TickDuration) the loop:
//  1. drains the command queue (up to Config.MaxCommandsPerTick),
//  2. runs the scheduled events that are due (min-heap Scheduler),
//  3. runs every registered System in order.
//
// Network goroutines only call Loop.Enqueue; everything else runs on the loop goroutine,
// so game state needs no locks. Time comes from an injected clock.Clock and randomness from
// an injected *rand.Rand, which keeps simulations deterministic.
package game

import (
	"math/rand/v2"
	"time"
)

// TickDuration is the fixed length of a game tick.
const TickDuration = 50 * time.Millisecond

// Tick is a tick number. The first processed tick is 1; 0 means "before the first tick".
type Tick uint64

// TicksFor converts a duration to a whole number of ticks, rounding up so that an
// event never happens earlier than requested. Non-positive durations return 0.
func TicksFor(d time.Duration) Tick {
	if d <= 0 {
		return 0
	}
	return Tick((d + TickDuration - 1) / TickDuration)
}

// Duration returns the game time spanned by n ticks.
func (n Tick) Duration() time.Duration { return time.Duration(n) * TickDuration }

// TickContext is what commands, events and systems receive while a tick runs. It is only
// valid during that call, on the loop goroutine.
type TickContext struct {
	// Tick is the number of the tick being processed.
	Tick Tick
	// Now is the clock time at which the tick started.
	Now time.Time
	// Rand is the loop's seeded random source. Use it for every random decision.
	Rand *rand.Rand
	// Sched schedules and cancels future events.
	Sched *Scheduler
}

// Command is a player or system intention that the loop executes. Network goroutines
// build commands and enqueue them; Execute runs on the loop goroutine and must validate
// everything against the authoritative state.
type Command interface {
	Execute(ctx *TickContext)
}

// CommandFunc adapts a function to the Command interface.
type CommandFunc func(ctx *TickContext)

// Execute calls f(ctx).
func (f CommandFunc) Execute(ctx *TickContext) { f(ctx) }

// System is a per-tick step of the game loop (movement, AI, combat, conditions...).
// Systems run in registration order after commands and scheduled events.
type System interface {
	Update(ctx *TickContext)
}

// SystemFunc adapts a function to the System interface.
type SystemFunc func(ctx *TickContext)

// Update calls f(ctx).
func (f SystemFunc) Update(ctx *TickContext) { f(ctx) }
