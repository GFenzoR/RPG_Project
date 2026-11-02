// Package clock provides the injectable time source used by the game server.
//
// Game logic never reads the wall clock directly: it receives a Clock. Production code
// uses Real; tests and the sim harness use Fake, which only moves when told to, so runs
// are deterministic. This is the only package allowed to call time.Now and friends.
package clock

import "time"

// Clock is a source of time and timers.
type Clock interface {
	// Now returns the current time.
	Now() time.Time
	// After returns a channel that receives the current time once d has elapsed.
	// A non-positive d fires immediately.
	After(d time.Duration) <-chan time.Time
}

// Real is a Clock backed by the operating system's wall clock.
type Real struct{}

// Now returns time.Now().
func (Real) Now() time.Time { return time.Now() }

// After returns time.After(d).
func (Real) After(d time.Duration) <-chan time.Time { return time.After(d) }
