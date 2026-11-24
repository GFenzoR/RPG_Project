//go:build integration

package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// The trail wear's row (migration 00027): nothing at first, then the last write wins.
func TestTrailWearRoundTrip(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_trail_wear", true)
	if _, _, ok, err := st.LoadTrailWear(ctx); err != nil || ok {
		t.Fatalf("empty table: ok %v, err %v", ok, err)
	}
	at := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	for i, data := range [][]byte{{'T', 'W', 1, 7}, {'T', 'W', 1}} {
		if err := st.SaveTrailWear(ctx, data, at.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatal(err)
		}
		got, savedAt, ok, err := st.LoadTrailWear(ctx)
		if err != nil || !ok || string(got) != string(data) || !savedAt.Equal(at.Add(time.Duration(i)*time.Minute)) {
			t.Fatalf("write %d: read %v at %v (ok %v, err %v)", i, got, savedAt, ok, err)
		}
	}
}
