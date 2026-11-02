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
		if got := allowOK(l, "a"); got != want {
			t.Fatalf("request %d: allow = %v, want %v", i, got, want)
		}
	}
	_, res := l.allow("a")
	l.refund(res) // nothing was taken: no-op
	if allowOK(l, "a") {
		t.Fatal("refund of a failed allow must not add tokens")
	}
	clk.Advance(time.Second)
	_, res = l.allow("a")
	l.refund(res)
	if got := []bool{allowOK(l, "a"), allowOK(l, "a")}; !got[0] || got[1] {
		t.Fatal("refund gives back exactly one token")
	}
	clk.Advance(time.Second)
	if got := []bool{allowOK(l, "a"), allowOK(l, "a")}; !got[0] || got[1] {
		t.Fatal("one token per Every")
	}
	for range 5 {
		_, res := l.allow("b")
		l.refund(res)
		l.refund(res) // double refund: still never above Burst
	}
	if got := []bool{allowOK(l, "b"), allowOK(l, "b"), allowOK(l, "b")}; !got[0] || !got[1] || got[2] {
		t.Fatal("refund must cap at Burst")
	}
}

// TestDrainedBucketSurvivesKeySpray: for both policies, a flood of new keys (many IPs
// or emails) can never reset or evict a drained bucket.
func TestDrainedBucketSurvivesKeySpray(t *testing.T) {
	for _, p := range []collisionPolicy{failOpen, failClosed} {
		l, _ := newTestLimiter(t, RateLimit{Burst: 3, Every: time.Hour}, p)
		for range 3 {
			allowOK(l, "victim@example.org")
		}
		for i := range 4 * limiterSlots {
			allowOK(l, "junk"+strconv.Itoa(i))
		}
		if allowOK(l, "victim@example.org") {
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
		allowOK(l, "attacker"+strconv.Itoa(i)) // claims and drains slots
	}
	allowed := 0
	for i := range 1000 {
		if allowOK(l, "user"+strconv.Itoa(i)) {
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
		allowOK(l, "attacker"+strconv.Itoa(i))
	}
	denied := 0
	for i := range 1000 {
		if !allowOK(l, "user"+strconv.Itoa(i)) {
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

func allowOK(l *limiter, key string) bool {
	ok, _ := l.allow(key)
	return ok
}

// stepClock is a clock.Clock whose wall time can also go backwards.
type stepClock struct{ t time.Time }

func (c *stepClock) Now() time.Time                       { return c.t }
func (c *stepClock) After(time.Duration) <-chan time.Time { return nil }

func TestLimiterSurvivesClockGoingBack(t *testing.T) {
	clk := &stepClock{t: time.Unix(1_000_000, 0)}
	l, err := newLimiter(RateLimit{Burst: 1, Every: time.Minute}, failClosed, clk)
	if err != nil {
		t.Fatal(err)
	}
	if !allowOK(l, "k") || allowOK(l, "k") {
		t.Fatal("burst of 1")
	}
	clk.t = clk.t.Add(-time.Hour) // wall clock jumps back an hour
	if allowOK(l, "k") {
		t.Fatal("a backward jump must not grant tokens")
	}
	clk.t = clk.t.Add(time.Minute) // one Every after the jump, not an hour
	if !allowOK(l, "k") {
		t.Fatal("bucket frozen after the clock went back")
	}
}

func TestLimiterOffsetFromStart(t *testing.T) {
	l, clk := newTestLimiter(t, RateLimit{Burst: 1, Every: time.Minute}, failClosed)
	if l.now() != 0 {
		t.Fatalf("now() at start = %d", l.now())
	}
	clk.Advance(90 * time.Second)
	if l.now() != int64(90*time.Second) {
		t.Fatalf("now() = %d", l.now())
	}
}

// keysInSet returns n keys (with distinct tags) that map to the same set as target.
func keysInSet(t *testing.T, l *limiter, target string, n int) []string {
	t.Helper()
	want := l.locate(target)
	var out []string
	for i := 0; len(out) < n; i++ {
		if i > 50_000_000 {
			t.Fatal("no colliding keys found")
		}
		k := "blocker" + strconv.Itoa(i)
		if r := l.locate(k); r.set == want.set && r.tag != want.tag {
			out = append(out, k)
		}
	}
	return out
}

// TestGapSecondSlotNoReset: a drained key is recognized by its tag even when an earlier
// slot of its set becomes reclaimable, so it never gets a fresh bucket.
func TestGapSecondSlotNoReset(t *testing.T) {
	for _, p := range []collisionPolicy{failOpen, failClosed} {
		l, clk := newTestLimiter(t, RateLimit{Burst: 2, Every: time.Minute}, p)
		blockers := keysInSet(t, l, "victim", limiterWays-1)
		for _, b := range blockers { // occupy the first slots of the set: 1 of 2 tokens left
			allowOK(l, b)
		}
		clk.Advance(50 * time.Second) // blockers nearly full (1.83), not reclaimable yet
		for range 2 {                 // the victim lands in the last slot and drains it
			allowOK(l, "victim")
		}
		if got, want := l.slotFor(l.locate("victim")), l.locate("victim").set+limiterWays-1; got != want {
			t.Fatalf("victim in slot %d, want the last slot %d", got, want)
		}
		clk.Advance(11 * time.Second) // blockers full (reclaimable); victim has ~0.18
		l.mu.Lock()
		l.slotFor(l.locate(blockers[0])) // refills the set
		blockerFull := l.slots[l.locate("victim").set].tokens >= 2
		l.mu.Unlock()
		if !blockerFull {
			t.Fatal("setup: the first blocker slot should be full (reclaimable)")
		}
		if allowOK(l, "victim") {
			t.Fatalf("policy %d: victim got a fresh bucket by reclaiming an earlier slot", p)
		}
	}
}

// TestGapFullBucketsAreReclaimed: once a saturated fail-open table refills, new keys get
// tracked buckets again instead of being let through untracked forever.
func TestGapFullBucketsAreReclaimed(t *testing.T) {
	l, clk := newTestLimiter(t, RateLimit{Burst: 1, Every: time.Minute}, failOpen)
	for i := range l.slots { // every slot owned by some other key and drained
		l.slots[i] = bucket{tag: uint64(i)<<1 | 1, tokens: 0, last: 0}
	}
	if got := []bool{allowOK(l, "new"), allowOK(l, "new")}; !got[0] || !got[1] {
		t.Fatal("saturated fail-open table should let a new key through untracked")
	}
	clk.Advance(time.Minute) // every bucket full again
	for i := range 100 {
		k := "fresh" + strconv.Itoa(i)
		if !allowOK(l, k) || allowOK(l, k) {
			t.Fatalf("%s not tracked after the table refilled", k)
		}
	}
}

// TestRefundToSharedSlot: in a fail-closed set full of other keys, the victim is charged
// on the fullest slot; after that slot stops being the fullest, refund still goes back
// to it and only to it.
func TestRefundToSharedSlot(t *testing.T) {
	l, _ := newTestLimiter(t, RateLimit{Burst: 10, Every: time.Hour}, failClosed)
	blockers := keysInSet(t, l, "victim", limiterWays)
	for i, b := range blockers { // distinct counts: blocker i keeps 9-2i... tokens
		for range 1 + 2*i {
			allowOK(l, b)
		}
	}
	set := l.locate("victim").set
	ok, res := l.allow("victim") // shares the fullest: blocker 0 (9 -> 8)
	if !ok || res.slot != set {
		t.Fatalf("charged slot %d, want %d", res.slot, set)
	}
	for range 3 { // blocker 0 drops to 5: slot set+1 (7 tokens) is now the fullest
		allowOK(l, blockers[0])
	}
	before := make([]float64, limiterWays)
	for i := range before {
		before[i] = l.slots[set+i].tokens
	}
	l.refund(res)
	for i := range before {
		want := before[i]
		if set+i == res.slot {
			want++
		}
		if l.slots[set+i].tokens != want {
			t.Fatalf("slot %d: %v -> %v, want %v", i, before[i], l.slots[set+i].tokens, want)
		}
	}
}

// TestRefundDroppedIfSlotChangedOwner: a refund never credits another key.
func TestRefundDroppedIfSlotChangedOwner(t *testing.T) {
	l, _ := newTestLimiter(t, RateLimit{Burst: 2, Every: time.Hour}, failClosed)
	_, res := l.allow("a")
	l.slots[res.slot] = bucket{tag: 12345, tokens: 0} // reclaimed by another key meanwhile
	l.refund(res)
	if l.slots[res.slot].tokens != 0 {
		t.Fatal("refund credited the new owner")
	}
}
