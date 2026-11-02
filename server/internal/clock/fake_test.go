package clock

import (
	"testing"
	"time"
)

func TestFakeStartsAtEpoch(t *testing.T) {
	if got := NewFake(time.Time{}).Now(); !got.Equal(Epoch) {
		t.Fatalf("Now() = %v, want %v", got, Epoch)
	}
	start := time.Date(2030, 5, 6, 7, 8, 9, 0, time.UTC)
	if got := NewFake(start).Now(); !got.Equal(start) {
		t.Fatalf("Now() = %v, want %v", got, start)
	}
}

func TestFakeAdvanceFiresDueTimersInOrder(t *testing.T) {
	f := NewFake(time.Time{})
	late := f.After(100 * time.Millisecond)
	early := f.After(30 * time.Millisecond)

	f.Advance(29 * time.Millisecond)
	select {
	case <-early:
		t.Fatal("timer fired before its deadline")
	default:
	}

	f.Advance(time.Millisecond)
	select {
	case got := <-early:
		if want := Epoch.Add(30 * time.Millisecond); !got.Equal(want) {
			t.Fatalf("early fired with %v, want %v", got, want)
		}
	default:
		t.Fatal("timer did not fire at its deadline")
	}
	if f.Waiters() != 1 {
		t.Fatalf("Waiters() = %d, want 1", f.Waiters())
	}

	f.Advance(time.Hour)
	select {
	case <-late:
	default:
		t.Fatal("late timer did not fire")
	}
	if f.Waiters() != 0 {
		t.Fatalf("Waiters() = %d, want 0", f.Waiters())
	}
}

func TestFakeNonPositiveAfterFiresImmediately(t *testing.T) {
	f := NewFake(time.Time{})
	select {
	case <-f.After(0):
	default:
		t.Fatal("After(0) did not fire immediately")
	}
	if f.Waiters() != 0 {
		t.Fatalf("Waiters() = %d, want 0", f.Waiters())
	}
}

func TestFakeIsMonotonic(t *testing.T) {
	f := NewFake(time.Time{})
	f.Advance(-time.Second)
	f.Set(Epoch.Add(-time.Second))
	if !f.Now().Equal(Epoch) {
		t.Fatalf("time moved backwards to %v", f.Now())
	}
	f.Set(Epoch.Add(time.Second))
	if want := Epoch.Add(time.Second); !f.Now().Equal(want) {
		t.Fatalf("Now() = %v, want %v", f.Now(), want)
	}
}

func TestFakeBlockUntil(t *testing.T) {
	f := NewFake(time.Time{})
	fired := make(chan struct{})
	go func() {
		<-f.After(time.Second)
		close(fired)
	}()
	f.BlockUntil(1)
	f.Advance(time.Second)
	<-fired
}

func TestRealClock(t *testing.T) {
	var c Clock = Real{}
	before := c.Now()
	<-c.After(time.Millisecond)
	if !c.Now().After(before) {
		t.Fatal("real clock did not move")
	}
}

func TestFakeSetForwardFiresTimers(t *testing.T) {
	f := NewFake(time.Time{})
	ch := f.After(time.Minute)
	f.Set(Epoch.Add(2 * time.Minute))
	select {
	case got := <-ch:
		if want := Epoch.Add(2 * time.Minute); !got.Equal(want) {
			t.Fatalf("fired with %v, want %v", got, want)
		}
	default:
		t.Fatal("Set forward did not fire the due timer")
	}
}
