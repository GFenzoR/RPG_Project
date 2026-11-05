package main

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

type purgeCalls chan time.Time

func (p purgeCalls) PurgeMapPatches(_ context.Context, before time.Time) (int64, error) {
	p <- before
	return 1, nil
}

// The retention job runs every sessionPurgeEvery with the cutoff "now - retention".
func TestPurgeMapPatchesCutoff(t *testing.T) {
	start := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(start)
	calls := make(purgeCalls, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go purgeMapPatches(ctx, slog.New(slog.DiscardHandler), clk, calls, 30*24*time.Hour)
	for i := 1; i <= 2; i++ {
		clk.BlockUntil(1)
		clk.Advance(sessionPurgeEvery)
		got := <-calls
		want := start.Add(time.Duration(i) * sessionPurgeEvery).Add(-30 * 24 * time.Hour)
		if !got.Equal(want) {
			t.Fatalf("cutoff %d = %v, want %v", i, got, want)
		}
	}
}
