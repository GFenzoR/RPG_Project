package game

import (
	"errors"
	"testing"
)

// One producer floods the queue; another's single command still runs on the next tick
// (audit lote 16: one connection must not fill the shared queue).
func TestQuotaKeepsOneProducerFromFillingTheQueue(t *testing.T) {
	l, _ := newTestLoop(t, Config{})
	flood := NewQuota(16)
	noop := CommandFunc(func(*TickContext) {})
	accepted := 0
	for range 10000 {
		if err := flood.Enqueue(l, noop); err == nil {
			accepted++
		} else if !errors.Is(err, ErrQuotaExceeded) {
			t.Fatalf("flood: %v", err)
		}
	}
	if accepted != 16 || flood.Pending() != 16 {
		t.Fatalf("flood accepted %d, pending %d; want 16", accepted, flood.Pending())
	}
	honest := NewQuota(16)
	ran := false
	if err := honest.Enqueue(l, CommandFunc(func(*TickContext) { ran = true })); err != nil {
		t.Fatalf("honest producer refused: %v", err)
	}
	l.Step()
	if !ran {
		t.Fatal("the honest command did not run on the next tick")
	}
	if flood.Pending() != 0 || honest.Pending() != 0 {
		t.Fatalf("quota not given back: %d, %d", flood.Pending(), honest.Pending())
	}
	// The flood's quota is free again once its commands ran.
	if err := flood.Enqueue(l, noop); err != nil {
		t.Fatalf("after the tick: %v", err)
	}
}

func TestQuotaGivesBackWhenTheQueueRefuses(t *testing.T) {
	l, _ := newTestLoop(t, Config{QueueCapacity: 1})
	q := NewQuota(4)
	noop := CommandFunc(func(*TickContext) {})
	if err := q.Enqueue(l, noop); err != nil {
		t.Fatal(err)
	}
	if err := q.Enqueue(l, noop); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("full queue: %v", err)
	}
	if q.Pending() != 1 {
		t.Fatalf("pending %d, want 1", q.Pending())
	}
}

func TestQuotaPanickingCommandFreesItsPlace(t *testing.T) {
	l, _ := newTestLoop(t, Config{})
	q := NewQuota(1)
	if err := q.Enqueue(l, CommandFunc(crash)); err != nil {
		t.Fatal(err)
	}
	if s := l.Step(); s.Panics != 1 {
		t.Fatalf("panics %d", s.Panics)
	}
	if q.Pending() != 0 {
		t.Fatalf("pending %d after a panic", q.Pending())
	}
}

// A login is accepted and runs while the shared queue is full, before the queued flood.
func TestLifecycleLaneWhileTheQueueIsFlooded(t *testing.T) {
	l, _ := newTestLoop(t, Config{QueueCapacity: 8, MaxCommandsPerTick: 4})
	var order []string
	flood := CommandFunc(func(*TickContext) { order = append(order, "flood") })
	for {
		if err := l.Enqueue(flood); err != nil {
			break
		}
	}
	join := LifecycleFunc(func(*TickContext) { order = append(order, "join") })
	if err := l.Enqueue(join); err != nil {
		t.Fatalf("join refused on a full queue: %v", err)
	}
	s := l.Step()
	if len(order) == 0 || order[0] != "join" {
		t.Fatalf("order %v: the join must run first", order)
	}
	if s.Commands != 5 || s.Pending != 4 {
		t.Fatalf("stats %+v", s)
	}
}

func TestLifecycleLaneHasItsOwnCapacity(t *testing.T) {
	l, _ := newTestLoop(t, Config{LifecycleCapacity: 2})
	noop := LifecycleFunc(func(*TickContext) {})
	for range 2 {
		if err := l.Enqueue(noop); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.Enqueue(noop); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("third lifecycle command: %v", err)
	}
	if _, err := New(Config{Clock: l.clock, Rand: l.rand, LifecycleCapacity: -1}); err == nil {
		t.Fatal("negative lifecycle capacity accepted")
	}
}
