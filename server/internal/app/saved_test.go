package app

import (
	"math/rand/v2"
	"path/filepath"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// ackClient keeps what the loop sends to one player.
type ackClient struct{ msgs []*pb.ServerMessage }

func (c *ackClient) Send(b *pb.ServerBatch) bool {
	c.msgs = append(c.msgs, b.GetEvents()...)
	return true
}
func (c *ackClient) Close(pb.DisconnectReason) {}

// take returns and forgets what the player got.
func (c *ackClient) take() []*pb.ServerMessage {
	m := c.msgs
	c.msgs = nil
	return m
}

func hasSystemKey(msgs []*pb.ServerMessage, key string) bool {
	for _, m := range msgs {
		if m.GetChatMessage().GetLocalized().GetKey() == key {
			return true
		}
	}
	return false
}

// ackRig is a World with the repo's content and two adjacent players, Ana and Beto, run
// by a loop with a small queue on a fake clock, and the App that acks its snapshots.
type ackRig struct {
	t         *testing.T
	clk       *clock.Fake
	loop      *game.Loop
	w         *session.World
	a         *App
	transfers []session.Transfer
	num       map[string]uint32
}

func newAckRig(t *testing.T) *ackRig {
	t.Helper()
	data := filepath.Join("..", "..", "..", "data")
	bal, err := content.LoadBalance(data)
	if err != nil {
		t.Fatal(err)
	}
	items, err := content.LoadItems(data)
	if err != nil {
		t.Fatal(err)
	}
	vocs, err := content.LoadVocations(data)
	if err != nil {
		t.Fatal(err)
	}
	r := &ackRig{t: t, clk: clock.NewFake(time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)), num: map[string]uint32{}}
	for _, id := range []string{"backpack", "patched_tunic", "plank_shield"} {
		r.num[id] = uint32(items[id].Numeric)
	}
	r.w, err = session.New(session.Config{
		Map: worldtest.Map(t, 0, 0, 7, "....", ".T..", "...."), Balance: bal, Items: items, Vocations: vocs,
		Save:     func(session.Snapshot) bool { return true },
		Transfer: func(tr session.Transfer) bool { r.transfers = append(r.transfers, tr); return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _, flush := r.w.Systems()
	r.loop, err = game.New(game.Config{Clock: r.clk, Rand: rand.New(rand.NewPCG(1, 1)), Systems: []game.System{flush}, QueueCapacity: 4, LifecycleCapacity: 4})
	if err != nil {
		t.Fatal(err)
	}
	r.a = &App{cfg: Config{Clock: r.clk}, Loop: r.loop, World: r.w, loopDone: make(chan struct{})}
	t.Cleanup(func() { close(r.a.loopDone) })
	return r
}

// run runs cmd in a tick of its own.
func (r *ackRig) run(cmd game.Command) {
	r.t.Helper()
	if err := r.loop.Enqueue(cmd); err != nil {
		r.t.Fatal(err)
	}
	r.loop.Step()
}

// join puts a level-10 guardian at (x, 1) with a backpack holding pack and a plank
// shield in the left hand.
func (r *ackRig) join(id int64, name string, x uint16, pack ...session.ItemState) (*ackClient, *session.Player) {
	r.t.Helper()
	cl := &ackClient{}
	r.run(r.w.Join(session.Character{ID: id, AccountID: id, Name: name, Vocation: "guardian", Level: 10, Health: 1000,
		HasPos: true, Pos: world.Pos{X: x, Y: 1, Z: 7}, InventoryLoaded: true, Inventory: []session.ItemState{
			{ItemID: uint16(r.num["backpack"]), Count: 1, Slot: int(pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK), Items: pack},
			{ItemID: uint16(r.num["plank_shield"]), Count: 1, Slot: int(pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND)},
		}}, cl))
	p := r.w.PlayerByCharacter(id)
	if p == nil {
		r.t.Fatalf("%s did not join", name)
	}
	cl.take()
	return cl, p
}

func (r *ackRig) input(cl *ackClient, m *pb.ClientMessage) []*pb.ServerMessage {
	r.t.Helper()
	cl.take()
	r.run(r.w.Input(cl, m))
	return cl.take()
}

// drop moves the shield from the left hand to the tile below the player at x.
func (r *ackRig) drop(cl *ackClient, x uint32) []*pb.ServerMessage {
	r.t.Helper()
	return r.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_MoveItem{MoveItem: &pb.MoveItem{
		From:   &pb.ItemLocation{Location: &pb.ItemLocation_Slot{Slot: pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND}},
		ItemId: r.num["plank_shield"], Count: 1,
		To: &pb.ItemLocation{Location: &pb.ItemLocation_Pos{Pos: &pb.Position{X: x, Y: 2, Z: 7}}}}}})
}

// fill fills the loop's queue with no-ops: the next ack is refused.
func (r *ackRig) fill() {
	noop := game.LifecycleFunc(func(*game.TickContext) {}) // acks go through the lifecycle lane
	for r.loop.Enqueue(noop) == nil {
	}
}

// retried lets the retry goroutine deliver what the full queue refused: it waits for the
// goroutine to park on the fake clock, empties the queue, moves the clock one tick and
// waits for the goroutine to stop. Then one tick runs the delivered acks; it returns how
// many commands that tick ran.
func (r *ackRig) retried() int {
	r.t.Helper()
	r.a.acks.mu.Lock()
	idle := r.a.acks.idle
	r.a.acks.mu.Unlock()
	if idle == nil {
		r.t.Fatal("no ack waits for a retry")
	}
	r.clk.BlockUntil(1)
	if st := r.loop.Step(); st.Pending != 0 {
		r.t.Fatalf("%d commands still queued", st.Pending)
	}
	r.clk.Advance(game.TickDuration)
	select {
	case <-idle:
	case <-time.After(10 * time.Second): //nolint:forbidigo // bounds a wait on the retry goroutine
		r.t.Fatal("the retry goroutine did not deliver the acks")
	}
	return r.loop.Step().Commands
}

// Every stored snapshot is acked to the loop, not only a final one: the ack of a
// transfer's snapshot is what ends the character's transfer hold (T5.3, World.Saved).
// With the loop's queue full the ack is retried, not dropped (a lost one would keep the
// character from dropping anything on the public ground until its next save), and it
// still ends the hold. Driven by the fake clock: no sleeps.
func TestRetriedAckEndsTheHold(t *testing.T) {
	r := newAckRig(t)
	ca, ana := r.join(1, "Ana", 1, session.ItemState{ItemID: uint16(r.num["patched_tunic"]), Count: 1})
	cb, beto := r.join(2, "Beto", 2)

	// Ana gives Beto her tunic: a transfer with both snapshots holds both.
	opens := r.input(ca, &pb.ClientMessage{Message: &pb.ClientMessage_UseItem{UseItem: &pb.UseItem{
		From:   &pb.ItemLocation{Location: &pb.ItemLocation_Slot{Slot: pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK}},
		ItemId: r.num["backpack"]}}})
	var pack uint32
	for _, m := range opens {
		if o := m.GetContainerOpen(); o != nil {
			pack = o.GetContainerId()
		}
	}
	r.input(ca, &pb.ClientMessage{Message: &pb.ClientMessage_TradeRequest{TradeRequest: &pb.TradeRequest{
		CreatureId: beto.ID(), ItemId: r.num["patched_tunic"],
		Item: &pb.ItemLocation{Location: &pb.ItemLocation_Container{Container: &pb.ContainerSlot{ContainerId: pack}}}}}})
	r.input(cb, &pb.ClientMessage{Message: &pb.ClientMessage_TradeRequest{TradeRequest: &pb.TradeRequest{CreatureId: ana.ID()}}})
	accept := &pb.ClientMessage{Message: &pb.ClientMessage_TradeAccept{TradeAccept: &pb.TradeAccept{}}}
	r.input(ca, accept)
	r.input(cb, accept)
	if len(r.transfers) != 1 || len(r.transfers[0].Snapshots) != 2 {
		t.Fatalf("transfers %+v, want the trade with both snapshots", r.transfers)
	}
	snaps := r.transfers[0].Snapshots
	if !hasSystemKey(r.drop(ca, 1), "inventory.saving") || !hasSystemKey(r.drop(cb, 2), "inventory.saving") {
		t.Fatal("a player dropped before the database had the trade")
	}

	// Queue full: both acks are refused; Ana's comes twice (an older snapshot first).
	// The retry keeps the highest seq per character and delivers one ack each.
	r.fill()
	for _, s := range []session.Snapshot{{CharacterID: snaps[0].CharacterID, Seq: snaps[0].Seq - 1}, snaps[0], snaps[1]} {
		r.a.snapshotSaved(s)
	}
	if n := r.retried(); n != 2 {
		t.Fatalf("the retry delivered %d acks, want one per character", n)
	}
	if hasSystemKey(r.drop(ca, 1), "inventory.saving") || hasSystemKey(r.drop(cb, 2), "inventory.saving") {
		t.Fatal("the retried acks did not end the holds")
	}
	r.a.acks.mu.Lock()
	defer r.a.acks.mu.Unlock()
	if r.a.acks.running || len(r.a.acks.pending) != 0 {
		t.Fatalf("retry left running %v, pending %v", r.a.acks.running, r.a.acks.pending)
	}
}

// With the queue nearly full, each retry round starts past the last character it
// delivered: no character waits behind others that keep acking.
func TestAckRetryTakesTurns(t *testing.T) {
	r := newAckRig(t)
	r.a.acks.pending = map[int64]uint64{1: 5, 2: 5, 3: 5}
	r.a.acks.after = 1
	// Acks go through the lifecycle lane: fill it but for one free slot of four.
	noop := game.LifecycleFunc(func(*game.TickContext) {})
	for range 3 {
		if err := r.loop.Enqueue(noop); err != nil {
			t.Fatal(err)
		}
	}
	if r.a.deliverAcks() || r.a.acks.after != 2 || len(r.a.acks.pending) != 2 {
		t.Fatalf("first round: after %d, pending %v", r.a.acks.after, r.a.acks.pending)
	}
	r.loop.Step()
	for range 3 {
		if err := r.loop.Enqueue(noop); err != nil {
			t.Fatal(err)
		}
	}
	if r.a.deliverAcks() || r.a.acks.after != 3 || r.a.acks.pending[1] != 5 {
		t.Fatalf("second round: after %d, pending %v", r.a.acks.after, r.a.acks.pending)
	}
	r.loop.Step()
	if !r.a.deliverAcks() || r.a.acks.after != 1 || len(r.a.acks.pending) != 0 {
		t.Fatalf("third round: after %d, pending %v", r.a.acks.after, r.a.acks.pending)
	}
}

// An ack the queue takes at once needs no retry.
func TestSnapshotSavedAcksAtOnce(t *testing.T) {
	r := newAckRig(t)
	r.a.snapshotSaved(session.Snapshot{CharacterID: 7, Seq: 3})
	if st := r.loop.Step(); st.Commands != 1 {
		t.Fatalf("the ack ran %d commands, want 1", st.Commands)
	}
	r.a.acks.mu.Lock()
	defer r.a.acks.mu.Unlock()
	if r.a.acks.running || len(r.a.acks.pending) != 0 {
		t.Fatal("an ack the queue took waits for a retry")
	}
}
