package app

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/metrics"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Lote 16: a panic in a background writer (a bug) is logged with its stack and that job
// is dropped; the writer goes on with the next one instead of taking the server down.

// panicRoles panics on its first role read and answers the next ones.
type panicRoles struct {
	downStore
	calls int
}

func (s *panicRoles) AccountRoles(context.Context, []int64) (map[int64]string, error) {
	s.calls++
	if s.calls == 1 {
		panic("roles bug") //nolint:forbidigo // the bug the worker must survive
	}
	return map[int64]string{1: "gm"}, nil
}

func TestAdminWorkerSurvivesAPanic(t *testing.T) {
	var buf bytes.Buffer
	var mu sync.Mutex
	var got []map[int64]session.Role
	a := newAdminWorker(&panicRoles{}, clock.NewFake(time.Unix(0, 0)), slog.New(slog.NewJSONHandler(&buf, nil)),
		func(session.AdminResult) {}, func(m map[int64]session.Role) { mu.Lock(); got = append(got, m); mu.Unlock() })
	a.Start()
	a.Submit(session.AdminJob{Kind: session.AdminCheckRoles, Accounts: []int64{1}})
	a.Submit(session.AdminJob{Kind: session.AdminCheckRoles, Accounts: []int64{1}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := a.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0][1] != session.RoleGM {
		t.Fatalf("roles after the panic: %v", got)
	}
	if !strings.Contains(buf.String(), "roles bug") || !strings.Contains(buf.String(), "stack") {
		t.Fatalf("the panic was not logged: %s", buf.String())
	}
}

// panicEcon panics on its first batch and stores the next ones.
type panicEcon struct {
	econStore
	once bool
}

func (s *panicEcon) AppendEconomy(ctx context.Context, id string, es []store.EconomyEntry) error {
	if !s.once {
		s.once = true
		panic("economy bug") //nolint:forbidigo // the bug the writer must survive
	}
	return s.econStore.AppendEconomy(ctx, id, es)
}

func TestEconomyWriterSurvivesAPanic(t *testing.T) {
	var buf bytes.Buffer
	st := &panicEcon{}
	w := newEconomyWriter(st, clock.Real{}, slog.New(slog.NewJSONHandler(&buf, nil)), time.Hour, 1)
	w.metrics = metrics.New()
	w.Start()
	w.Submit(session.EconomyEntry{Kind: session.EconGather, CharacterID: 1, ItemID: 9, Count: 1})
	w.Submit(session.EconomyEntry{Kind: session.EconGather, CharacterID: 2, ItemID: 9, Count: 1})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := w.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if st.rows() != 1 || !strings.Contains(buf.String(), "economy bug") {
		t.Fatalf("rows after the panic %d, log %s", st.rows(), buf.String())
	}
}
