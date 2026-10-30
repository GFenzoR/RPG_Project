package game

// EventID identifies a scheduled event so it can be cancelled. IDs are never reused.
type EventID uint64

// EventFunc is the work of a scheduled event. It runs on the loop goroutine.
type EventFunc func(ctx *TickContext)

type scheduledEvent struct {
	at Tick
	id EventID
	fn EventFunc
}

// Scheduler is a min-heap of events keyed by (tick, id). Events due on the same tick run
// in the order they were scheduled, so runs are deterministic. It is owned by the loop
// goroutine and is not safe for concurrent use.
//
// An event never runs in the tick it was scheduled in: a due tick at or before the current
// one is moved to the next tick. This keeps every tick bounded.
type Scheduler struct {
	now    Tick
	nextID EventID
	heap   []scheduledEvent
	pos    map[EventID]int // heap index of each pending event
}

// NewScheduler returns an empty scheduler positioned at tick 0.
func NewScheduler() *Scheduler {
	return &Scheduler{pos: make(map[EventID]int)}
}

// Now returns the tick the scheduler is positioned at.
func (s *Scheduler) Now() Tick { return s.now }

// Len returns the number of pending events.
func (s *Scheduler) Len() int { return len(s.heap) }

// At schedules fn to run on tick at (or on the next tick if at is not in the future).
func (s *Scheduler) At(at Tick, fn EventFunc) EventID {
	if at <= s.now {
		at = s.now + 1
	}
	s.nextID++
	id := s.nextID
	s.heap = append(s.heap, scheduledEvent{at: at, id: id, fn: fn})
	i := len(s.heap) - 1
	s.pos[id] = i
	s.up(i)
	return id
}

// After schedules fn to run delay ticks from now (at least one tick). A delay that would
// overflow saturates to the last representable tick.
func (s *Scheduler) After(delay Tick, fn EventFunc) EventID {
	at := s.now + delay
	if at < s.now {
		at = ^Tick(0)
	}
	return s.At(at, fn)
}

// Cancel removes a pending event. It reports whether the event was still pending.
func (s *Scheduler) Cancel(id EventID) bool {
	i, ok := s.pos[id]
	if !ok {
		return false
	}
	s.removeAt(i)
	return true
}

// NextDue returns the tick of the earliest pending event.
func (s *Scheduler) NextDue() (Tick, bool) {
	if len(s.heap) == 0 {
		return 0, false
	}
	return s.heap[0].at, true
}

// runDue positions the scheduler at tick and passes every event due at or before it to
// exec. Events scheduled while running land on later ticks, so this always terminates.
func (s *Scheduler) runDue(tick Tick, exec func(EventFunc)) int {
	s.now = tick
	n := 0
	for len(s.heap) > 0 && s.heap[0].at <= s.now {
		fn := s.heap[0].fn
		s.removeAt(0)
		exec(fn)
		n++
	}
	return n
}

func (s *Scheduler) removeAt(i int) {
	last := len(s.heap) - 1
	delete(s.pos, s.heap[i].id)
	if i != last {
		s.heap[i] = s.heap[last]
		s.pos[s.heap[i].id] = i
	}
	s.heap[last] = scheduledEvent{} // drop the closure reference
	s.heap = s.heap[:last]
	if i != last {
		if !s.down(i) {
			s.up(i)
		}
	}
}

func (s *Scheduler) less(i, j int) bool {
	a, b := &s.heap[i], &s.heap[j]
	if a.at != b.at {
		return a.at < b.at
	}
	return a.id < b.id
}

func (s *Scheduler) swap(i, j int) {
	s.heap[i], s.heap[j] = s.heap[j], s.heap[i]
	s.pos[s.heap[i].id] = i
	s.pos[s.heap[j].id] = j
}

func (s *Scheduler) up(i int) {
	for i > 0 {
		parent := (i - 1) / 2
		if !s.less(i, parent) {
			return
		}
		s.swap(i, parent)
		i = parent
	}
}

// down sifts i towards the leaves and reports whether it moved.
func (s *Scheduler) down(i int) bool {
	start := i
	n := len(s.heap)
	for {
		left := 2*i + 1
		if left >= n {
			break
		}
		smallest := left
		if right := left + 1; right < n && s.less(right, left) {
			smallest = right
		}
		if !s.less(smallest, i) {
			break
		}
		s.swap(i, smallest)
		i = smallest
	}
	return i != start
}
