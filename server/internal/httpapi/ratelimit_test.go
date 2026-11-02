package httpapi

import (
	"strconv"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

func newTestLimiter(t *testing.T, rl RateLimit) (*limiter, *clock.Fake) {
	t.Helper()
	clk := clock.NewFake(time.Unix(0, 0))
	l, err := newLimiter(rl, clk)
	if err != nil {
		t.Fatal(err)
	}
	return l, clk
}

func TestLimiterBurstAndRefill(t *testing.T) {
	l, clk := newTestLimiter(t, RateLimit{Burst: 2, Every: time.Second})
	for i, want := range []bool{true, true, false} {
		if got := l.allow("a"); got != want {
			t.Fatalf("request %d: allow = %v, want %v", i, got, want)
		}
	}
	clk.Advance(time.Second)
	if !l.allow("a") || l.allow("a") {
		t.Fatal("one token per Every")
	}
}

// TestDrainedBucketSurvivesKeySpray: a flood of new keys (many IPs or emails) can never
// reset or evict a drained bucket.
func TestDrainedBucketSurvivesKeySpray(t *testing.T) {
	l, _ := newTestLimiter(t, RateLimit{Burst: 3, Every: time.Hour})
	for range 3 {
		l.allow("victim@example.org")
	}
	for i := range 4 * limiterSlots {
		l.allow("junk" + strconv.Itoa(i))
	}
	if l.ready("victim@example.org") || l.allow("victim@example.org") {
		t.Fatal("drained bucket was restored by spraying keys")
	}
	if len(l.slots) != limiterSlots {
		t.Fatalf("table grew to %d", len(l.slots))
	}
}

func TestLimiterReadyAndTake(t *testing.T) {
	l, _ := newTestLimiter(t, RateLimit{Burst: 1, Every: time.Hour})
	for range 2 {
		if !l.ready("k") {
			t.Fatal("ready must not consume")
		}
	}
	l.take("k")
	if l.ready("k") {
		t.Fatal("take must consume")
	}
	l.take("k") // no tokens: no-op, never negative
	if l.ready("k") {
		t.Fatal("still drained")
	}
}

func TestLimiterSecretsDiffer(t *testing.T) {
	a, _ := newTestLimiter(t, DefaultAuthRateLimit)
	b, _ := newTestLimiter(t, DefaultAuthRateLimit)
	if a.secret == b.secret {
		t.Fatal("each limiter needs its own random secret")
	}
}
