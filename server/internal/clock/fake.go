package clock

import (
	"sort"
	"sync"
	"time"
)

// Fake is a manually driven Clock for tests. Time only moves with Advance or Set.
// It is safe for concurrent use.
type Fake struct {
	mu      sync.Mutex
	cond    *sync.Cond
	now     time.Time
	waiters []waiter
}

type waiter struct {
	deadline time.Time
	ch       chan time.Time
}

// Epoch is the default start time of a Fake clock. It is fixed so tests are reproducible.
var Epoch = time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)

// NewFake returns a Fake clock set to start. A zero start means Epoch.
func NewFake(start time.Time) *Fake {
	if start.IsZero() {
		start = Epoch
	}
	f := &Fake{now: start}
	f.cond = sync.NewCond(&f.mu)
	return f
}

// Now returns the fake current time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// After returns a channel that fires once the fake time reaches Now()+d.
func (f *Fake) After(d time.Duration) <-chan time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch := make(chan time.Time, 1)
	if d <= 0 {
		ch <- f.now
		return ch
	}
	f.waiters = append(f.waiters, waiter{deadline: f.now.Add(d), ch: ch})
	f.cond.Broadcast()
	return ch
}

// Advance moves the fake time forward by d and fires every timer that became due,
// in deadline order. A negative d is ignored.
func (f *Fake) Advance(d time.Duration) {
	if d < 0 {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.setLocked(f.now.Add(d))
}

// Set moves the fake time to t and fires every timer that became due. Moving backwards
// is ignored: time is monotonic.
func (f *Fake) Set(t time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if t.Before(f.now) {
		return
	}
	f.setLocked(t)
}

func (f *Fake) setLocked(t time.Time) {
	f.now = t
	sort.SliceStable(f.waiters, func(i, j int) bool {
		return f.waiters[i].deadline.Before(f.waiters[j].deadline)
	})
	n := 0
	for n < len(f.waiters) && !f.waiters[n].deadline.After(t) {
		f.waiters[n].ch <- t
		n++
	}
	f.waiters = append(f.waiters[:0], f.waiters[n:]...)
}

// Waiters returns how many timers are pending.
func (f *Fake) Waiters() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.waiters)
}

// BlockUntil blocks until at least n timers are pending. Tests use it to know that a
// goroutine is parked on After before advancing time.
func (f *Fake) BlockUntil(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for len(f.waiters) < n {
		f.cond.Wait()
	}
}
