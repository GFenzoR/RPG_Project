package app

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
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

type downStore struct{}

var errDown = errors.New("connection refused")

func (downStore) AppendAudit(context.Context, store.AuditEntry) error { return errDown }
func (downStore) Ban(context.Context, store.BanRequest) (store.BanResult, error) {
	return store.BanResult{}, errDown
}
func (downStore) Unban(context.Context, store.BanRequest) (store.BanResult, error) {
	return store.BanResult{}, errDown
}
func (downStore) AccountRoles(context.Context, []int64) (map[int64]string, error) {
	return nil, errDown
}
func (downStore) CreateReport(context.Context, store.Report, store.AuditEntry) (int64, error) {
	return 0, errDown
}
func (downStore) ListReportsAudited(context.Context, int, store.AuditEntry) ([]store.Report, error) {
	return nil, errDown
}
func (downStore) CloseReport(context.Context, int64, string, store.AuditEntry) (string, error) {
	return "", errDown
}

// At shutdown with the database down, every pending job stays in the structured log
// with its actor, action and arguments: the log is the last copy.
func TestWritePendingKeepsJobsInLog(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))
	a := newAdminWorker(downStore{}, clock.NewFake(time.Unix(0, 0)), log, func(session.AdminResult) {}, func(map[int64]session.Role) {})
	jobs := []session.AdminJob{
		{Kind: session.AdminAudit, Audit: session.AuditEntry{ActorAccountID: 7, ActorName: "Keeper", Action: "create_item",
			Args: map[string]string{"item": "gold_coin", "count": "100"}, Result: "ok"}},
		{Kind: session.AdminAudit, Audit: session.AuditEntry{ActorAccountID: 8, ActorName: "Warden", Action: "kick", TargetName: "Rude", Result: "ok"}},
		{Kind: session.AdminBan, TargetName: "Cheater", Reason: "botting", Audit: session.AuditEntry{ActorName: "Warden", Action: "ban"}},
	}
	if err := a.writePending(context.Background(), jobs); !errors.Is(err, errDown) {
		t.Fatalf("writePending = %v", err)
	}
	out := buf.String()
	for _, want := range []string{`"actor":"Keeper"`, `"action":"create_item"`, `"count":"100"`, `"actor":"Warden"`,
		`"action":"kick"`, `"target":"Rude"`, `"action":"ban"`, `"target":"Cheater"`, `"reason":"botting"`} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %s:\n%s", want, out)
		}
	}
	// An expired context: nothing is tried, everything is logged.
	buf.Reset()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_ = a.writePending(ctx, jobs[:1])
	if !strings.Contains(buf.String(), `"actor":"Keeper"`) {
		t.Fatalf("expired context: %s", buf.String())
	}
}
