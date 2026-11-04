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
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

type recordClient struct{ reason chan pb.DisconnectReason }

func (c *recordClient) Send(*pb.ServerBatch) bool   { return true }
func (c *recordClient) Close(r pb.DisconnectReason) { c.reason <- r }

// A ban result is never lost: with the loop's queue full, adminDone waits for room
// instead of dropping it, and the banned player is disconnected.
func TestAdminDoneSurvivesFullQueue(t *testing.T) {
	clk := clock.NewFake(time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC))
	bal, err := content.LoadBalance(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	items, err := content.LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	jobs := make(chan session.AdminJob, 4)
	w, err := session.New(session.Config{
		Map: worldtest.Map(t, 0, 0, 7, "....", "....", ".T.."), Balance: bal, Items: items,
		Vocations: content.Vocations{"guardian": {ID: "guardian", Start: content.VocationStats{Health: 100, Speed: 200}}},
		Save:      func(session.Snapshot) bool { return true },
		Admin:     func(j session.AdminJob) bool { jobs <- j; return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _, flush := w.Systems()
	loop, err := game.New(game.Config{Clock: clk, Rand: rand.New(rand.NewPCG(1, 1)), Systems: []game.System{flush}, QueueCapacity: 4})
	if err != nil {
		t.Fatal(err)
	}
	a := &App{cfg: Config{Clock: clk}, Loop: loop, World: w, loopDone: make(chan struct{})}

	gm := &recordClient{reason: make(chan pb.DisconnectReason, 1)}
	pl := &recordClient{reason: make(chan pb.DisconnectReason, 1)}
	mustEnqueue := func(c game.Command) {
		if err := loop.Enqueue(c); err != nil {
			t.Fatal(err)
		}
	}
	mustEnqueue(w.Join(session.Character{ID: 1, AccountID: 1, Name: "Warden", Vocation: "guardian", Level: 1, Health: 100, Role: session.RoleGM}, gm))
	mustEnqueue(w.Join(session.Character{ID: 2, AccountID: 2, Name: "Cheater", Vocation: "guardian", Level: 1, Health: 100}, pl))
	mustEnqueue(w.Input(gm, &pb.ClientMessage{Message: &pb.ClientMessage_Say{Say: &pb.Say{Channel: pb.ChatChannel_CHAT_CHANNEL_SAY, Text: "/ban Cheater 1d cheating"}}}))
	loop.Step()
	job := <-jobs

	for loop.Enqueue(game.CommandFunc(func(*game.TickContext) {})) == nil { // fill the queue
	}
	done := make(chan struct{})
	go func() {
		a.adminDone(session.AdminResult{ID: job.ID, Result: session.AdminOK, AccountID: 2, Name: "Cheater"})
		close(done)
	}()
	for {
		select {
		case <-done:
			loop.Step()
			select {
			case r := <-pl.reason:
				if r != pb.DisconnectReason_DISCONNECT_REASON_BANNED {
					t.Fatalf("player closed with %v", r)
				}
			default:
				t.Fatal("the ban result was lost: the player is still online")
			}
			return
		default:
			time.Sleep(5 * time.Millisecond) //nolint:forbidigo // let adminDone hit the full queue first
			loop.Step()                      // drains the queue
			clk.Advance(game.TickDuration)   // wakes adminDone's retry
		}
	}
}
