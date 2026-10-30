package game

import (
	"math/rand/v2"
	"slices"
	"testing"
)

// runTick positions s at tick and runs its due events, returning how many ran.
func runTick(s *Scheduler, tick Tick) int {
	ctx := &TickContext{Tick: tick, Sched: s}
	return s.runDue(tick, func(fn EventFunc) { fn(ctx) })
}

func TestSchedulerRunsInTickThenInsertionOrder(t *testing.T) {
	s := NewScheduler()
	var got []string
	rec := func(name string) EventFunc { return func(*TickContext) { got = append(got, name) } }

	s.At(3, rec("c1"))
	s.At(1, rec("a"))
	s.At(3, rec("c2"))
	s.At(2, rec("b"))
	s.At(3, rec("c3"))

	for tick := Tick(1); tick <= 3; tick++ {
		runTick(s, tick)
	}
	want := []string{"a", "b", "c1", "c2", "c3"}
	if !slices.Equal(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	if s.Len() != 0 {
		t.Fatalf("Len() = %d, want 0", s.Len())
	}
}

func TestSchedulerRunsOverdueEvents(t *testing.T) {
	s := NewScheduler()
	ran := 0
	s.At(2, func(*TickContext) { ran++ })
	s.At(5, func(*TickContext) { ran++ })
	if n := runTick(s, 10); n != 2 || ran != 2 {
		t.Fatalf("runDue ran %d (counted %d), want 2", n, ran)
	}
}

func TestSchedulerNeverRunsInSchedulingTick(t *testing.T) {
	s := NewScheduler()
	runTick(s, 5)

	var ranAt []Tick
	var chain EventFunc
	chain = func(ctx *TickContext) {
		ranAt = append(ranAt, ctx.Tick)
		if len(ranAt) < 3 {
			ctx.Sched.After(0, chain) // delay 0 must still wait for the next tick
		}
	}
	if id := s.At(2, chain); id == 0 {
		t.Fatal("At returned the zero EventID")
	}
	if due, _ := s.NextDue(); due != 6 {
		t.Fatalf("past due tick clamped to %d, want 6", due)
	}
	for tick := Tick(6); tick <= 9; tick++ {
		if n := runTick(s, tick); n > 1 {
			t.Fatalf("tick %d ran %d events, want at most 1", tick, n)
		}
	}
	if want := []Tick{6, 7, 8}; !slices.Equal(ranAt, want) {
		t.Fatalf("ran at %v, want %v", ranAt, want)
	}
}

func TestSchedulerCancel(t *testing.T) {
	s := NewScheduler()
	var got []int
	ids := make([]EventID, 10)
	for i := range ids {
		i := i
		ids[i] = s.At(Tick(10-i), func(*TickContext) { got = append(got, i) })
	}
	for _, i := range []int{0, 3, 9} {
		if !s.Cancel(ids[i]) {
			t.Fatalf("Cancel(%d) = false, want true", i)
		}
	}
	if s.Cancel(ids[3]) {
		t.Fatal("cancelling twice returned true")
	}
	if s.Cancel(EventID(999)) {
		t.Fatal("cancelling an unknown id returned true")
	}
	runTick(s, 100)
	if want := []int{8, 7, 6, 5, 4, 2, 1}; !slices.Equal(got, want) {
		t.Fatalf("ran %v, want %v", got, want)
	}
	if s.Cancel(ids[1]) {
		t.Fatal("cancelling an executed event returned true")
	}
}

func TestSchedulerCancelFromEvent(t *testing.T) {
	s := NewScheduler()
	ranB := false
	var idB EventID
	s.At(1, func(ctx *TickContext) { ctx.Sched.Cancel(idB) })
	idB = s.At(1, func(*TickContext) { ranB = true })
	runTick(s, 1)
	if ranB {
		t.Fatal("event cancelled by an earlier event of the same tick still ran")
	}
}

// TestSchedulerMatchesSortedOrder checks the heap invariant under random inserts and
// cancels against a naive reference.
func TestSchedulerMatchesSortedOrder(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	s := NewScheduler()
	type ref struct {
		at Tick
		id EventID
	}
	var pending []ref
	var got []EventID
	for range 2000 {
		if len(pending) > 0 && r.IntN(4) == 0 {
			k := r.IntN(len(pending))
			if !s.Cancel(pending[k].id) {
				t.Fatalf("Cancel(%d) = false", pending[k].id)
			}
			pending = slices.Delete(pending, k, k+1)
			continue
		}
		at := Tick(1 + r.IntN(200))
		var id EventID
		id = s.At(at, func(*TickContext) { got = append(got, id) })
		pending = append(pending, ref{at, id})
	}
	slices.SortFunc(pending, func(a, b ref) int {
		if a.at != b.at {
			return int(a.at) - int(b.at)
		}
		return int(a.id) - int(b.id)
	})
	for tick := Tick(1); tick <= 200; tick++ {
		runTick(s, tick)
	}
	if len(got) != len(pending) {
		t.Fatalf("ran %d events, want %d", len(got), len(pending))
	}
	for i := range got {
		if got[i] != pending[i].id {
			t.Fatalf("event %d: ran id %d, want %d", i, got[i], pending[i].id)
		}
	}
}

func TestSchedulerAfterSaturatesOnOverflow(t *testing.T) {
	s := NewScheduler()
	runTick(s, 10)
	s.After(^Tick(0), func(*TickContext) {})
	if due, _ := s.NextDue(); due != ^Tick(0) {
		t.Fatalf("overflowing delay scheduled at %d, want max tick", due)
	}
	if n := runTick(s, 1_000_000); n != 0 {
		t.Fatalf("saturated event ran early (%d events)", n)
	}
}
