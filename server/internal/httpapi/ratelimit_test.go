package httpapi

import (
	"strconv"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

func TestLimiterPrunesIdleBuckets(t *testing.T) {
	clk := clock.NewFake(time.Unix(0, 0))
	l := newLimiter(RateLimit{Burst: 2, Every: time.Second}, clk)
	for i := range maxLimiterKeys {
		l.allow(strconv.Itoa(i))
	}
	for i, want := range []bool{true, true, false} {
		if got := l.allow("busy"); got != want {
			t.Fatalf("busy request %d: allow = %v, want %v", i, got, want)
		}
	}
	clk.Advance(2 * time.Second) // every bucket but "busy" refills completely
	l.allow("new")
	if len(l.buckets) > 2 {
		t.Fatalf("expected idle buckets pruned, have %d", len(l.buckets))
	}
}
