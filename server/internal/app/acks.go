package app

import (
	"maps"
	"slices"
	"sync"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
)

// ackRetry holds the snapshot acks the loop's full queue refused (T5.3, World.Saved):
// only the highest seq per character, because an ack stands for every earlier one of its
// character (the Saver writes in order). One goroutine at a time delivers them, a tick
// apart, so a full queue under load costs one goroutine and one entry per character, not
// one goroutine per ack all competing for the queue every tick.
type ackRetry struct {
	mu      sync.Mutex
	pending map[int64]uint64
	running bool
	// idle is closed when the delivering goroutine stops: everything was delivered, or
	// the loop stopped (tests wait on it).
	idle chan struct{}
}

// snapshotSaved acks every stored snapshot to the loop: a final one lets it forget the
// unsaved state, and any one ends the character's transfer hold (T5.3, World.Saved).
// With the queue full the ack is kept for the retry goroutine (the persistence goroutine
// never waits for the loop): a lost one would keep the character from dropping anything
// on the public ground, and its reservations on the ground, until its next save, minutes
// later, and under load is when queues fill up. A late ack is harmless (World.Saved
// compares sequence numbers).
func (a *App) snapshotSaved(s session.Snapshot) {
	if a.Loop.Enqueue(a.World.Saved(s.CharacterID, s.Seq)) == nil {
		return
	}
	r := &a.acks
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.pending == nil {
		r.pending = map[int64]uint64{}
	}
	r.pending[s.CharacterID] = max(r.pending[s.CharacterID], s.Seq)
	if !r.running {
		r.running = true
		r.idle = make(chan struct{})
		go a.retryAcks(r.idle)
	}
}

// retryAcks delivers the pending acks every tick until none is left or the loop stops.
func (a *App) retryAcks(idle chan struct{}) {
	defer close(idle)
	for {
		select {
		case <-a.loopDone:
			return // nothing runs commands any more; later refused acks just wait here
		case <-a.cfg.Clock.After(game.TickDuration):
		}
		if a.deliverAcks() {
			return
		}
	}
}

// deliverAcks enqueues the pending acks, lowest character id first, until the queue is
// full again. It reports whether none is left; then the goroutine stops, and the next
// refused ack starts another.
func (a *App) deliverAcks() bool {
	r := &a.acks
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, id := range slices.Sorted(maps.Keys(r.pending)) {
		if a.Loop.Enqueue(a.World.Saved(id, r.pending[id])) != nil {
			return false
		}
		delete(r.pending, id)
	}
	r.running = false
	return true
}
