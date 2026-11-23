package gateway

import (
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
)

// joinHoldLoop forwards commands to the real loop but holds back every lifecycle command
// after the first one (the LoginStarted): the Join waits until release.
type joinHoldLoop struct {
	inner Loop

	mu       sync.Mutex
	life     int
	held     []game.Command
	enqueued int // commands seen after the Join was held
	released bool
}

func (h *joinHoldLoop) Enqueue(cmd game.Command) error {
	h.mu.Lock()
	if _, ok := cmd.(game.LifecycleFunc); ok && !h.released {
		h.life++
		if h.life > 1 {
			h.held = append(h.held, cmd)
			h.mu.Unlock()
			return nil
		}
	}
	if len(h.held) > 0 {
		h.enqueued++
	}
	h.mu.Unlock()
	return h.inner.Enqueue(cmd)
}

func (h *joinHoldLoop) state() (held, after int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.held), h.enqueued
}

func (h *joinHoldLoop) release(t *testing.T) {
	h.mu.Lock()
	h.released = true
	held := h.held
	h.held = nil
	h.mu.Unlock()
	for _, cmd := range held {
		if err := h.inner.Enqueue(cmd); err != nil {
			t.Fatal(err)
		}
	}
}

// TestLeaveWaitsForJoin: a client that closes before its Join ran must not get its
// Leave enqueued first. The Join (lifecycle lane) could then run after the Leave
// (shared queue) and put in a ghost player bound to a closed connection.
func TestLeaveWaitsForJoin(t *testing.T) {
	var hold *joinHoldLoop
	s := newStack(t, func(c *Config) {
		hold = &joinHoldLoop{inner: c.Loop}
		c.Loop = hold
	})
	s.token("good", 7)
	c := s.dial()
	if err := c.send(hello("good", "0.1.0")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { held, _ := hold.state(); return held == 1 })
	_ = c.ws.CloseNow()
	<-wall.After(200 * time.Millisecond) // time for the gateway to see the close
	if _, after := hold.state(); after != 0 {
		t.Fatalf("%d commands enqueued before the Join ran", after)
	}
	hold.release(t)
	// The Join runs, then the Leave: the player is removed (its final save).
	waitFor(t, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.saves) == 1 && s.saves[0].Final && s.saves[0].CharacterID == 7
	})
	waitFor(t, func() bool { return s.gw.Connections() == 0 })
}
