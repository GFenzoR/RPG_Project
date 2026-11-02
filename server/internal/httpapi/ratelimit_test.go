package httpapi

import (
	"strconv"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

func newTestLimiter(t *testing.T, rl RateLimit, p collisionPolicy) (*limiter, *clock.Fake) {
	t.Helper()
	clk := clock.NewFake(time.Unix(0, 0))
	l, err := newLimiter(rl, p, clk)
	if err != nil {
		t.Fatal(err)
	}
	return l, clk
}

func TestLimiterBurstRefillAndRefund(t *testing.T) {
	l, clk := newTestLimiter(t, RateLimit{Burst: 2, Every: time.Second}, failClosed)
	for i, want := range []bool{true, true, false} {
		if got := l.allow("a"); got != want {
			t.Fatalf("request %d: allow = %v, want %v", i, got, want)
		}
	}
	l.refund("a")
	if got := []bool{l.allow("a"), l.allow("a")}; !got[0] || got[1] {
		t.Fatal("refund gives back exactly one token")
	}
	clk.Advance(time.Second)
	if got := []bool{l.allow("a"), l.allow("a")}; !got[0] || got[1] {
		t.Fatal("one token per Every")
	}
	for range 5 {
		l.refund("b") // never above Burst
	}
	if got := []bool{l.allow("b"), l.allow("b"), l.allow("b")}; !got[0] || !got[1] || got[2] {
		t.Fatal("refund must cap at Burst")
	}
}

// TestDrainedBucketSurvivesKeySpray: for both policies, a flood of new keys (many IPs
// or emails) can never reset or evict a drained bucket.
func TestDrainedBucketSurvivesKeySpray(t *testing.T) {
	for _, p := range []collisionPolicy{failOpen, failClosed} {
		l, _ := newTestLimiter(t, RateLimit{Burst: 3, Every: time.Hour}, p)
		for range 3 {
			l.allow("victim@example.org")
		}
		for i := range 4 * limiterSlots {
			l.allow("junk" + strconv.Itoa(i))
		}
		if l.allow("victim@example.org") {
			t.Fatalf("policy %d: drained bucket was restored by spraying keys", p)
		}
		if len(l.slots) != limiterSlots {
			t.Fatalf("table grew to %d", len(l.slots))
		}
	}
}

// TestFailOpenTableCannotBeSaturated: when an attacker drains every slot, keys that
// find no slot are let through (per-IP limit) instead of locking out everyone.
func TestFailOpenTableCannotBeSaturated(t *testing.T) {
	l, _ := newTestLimiter(t, RateLimit{Burst: 1, Every: time.Hour}, failOpen)
	for i := range 4 * limiterSlots {
		l.allow("attacker" + strconv.Itoa(i)) // claims and drains slots
	}
	allowed := 0
	for i := range 1000 {
		if l.allow("user" + strconv.Itoa(i)) {
			allowed++
		}
	}
	if allowed != 1000 {
		t.Fatalf("only %d/1000 fresh users allowed on a saturated table", allowed)
	}
}

// TestFailClosedSharesBucket: per-account limits never let an untracked key through.
func TestFailClosedSharesBucket(t *testing.T) {
	l, _ := newTestLimiter(t, RateLimit{Burst: 1, Every: time.Hour}, failClosed)
	for i := range 4 * limiterSlots {
		l.allow("attacker" + strconv.Itoa(i))
	}
	denied := 0
	for i := range 1000 {
		if !l.allow("user" + strconv.Itoa(i)) {
			denied++
		}
	}
	if denied == 0 {
		t.Fatal("a saturated fail-closed table must not let new keys through for free")
	}
}

func TestLimiterSecretsDiffer(t *testing.T) {
	a, _ := newTestLimiter(t, DefaultAuthRateLimit, failOpen)
	b, _ := newTestLimiter(t, DefaultAuthRateLimit, failOpen)
	if a.secret == b.secret {
		t.Fatal("each limiter needs its own random secret")
	}
}
