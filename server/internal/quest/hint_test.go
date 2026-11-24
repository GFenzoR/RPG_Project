package quest

import (
	"math"
	"testing"
)

func TestFuzzHintNeverExactAndHoldsTheTarget(t *testing.T) {
	for _, tr := range []int{0, 1, 3, 5, 8, 12, 16, 30} {
		for ch := int64(1); ch <= 400; ch++ {
			seed := HintSeed(ch, "ch1_shipwreck", "clear_wolves", 1000, 2000, 7)
			h := FuzzHint(1000, 2000, tr, seed)
			if h.X == 1000 && h.Y == 2000 {
				t.Fatalf("tr %d character %d: the hint is centred on the target", tr, ch)
			}
			if h.Radius < MinHintRadius {
				t.Fatalf("tr %d: radius %d under the minimum", tr, h.Radius)
			}
			// Every corner of the target's area is inside the circle.
			for _, c := range [][2]int{{-tr, -tr}, {tr, -tr}, {-tr, tr}, {tr, tr}} {
				dx, dy := float64(1000+c[0]-h.X), float64(2000+c[1]-h.Y)
				if math.Hypot(dx, dy) > float64(h.Radius)+1e-9 {
					t.Fatalf("tr %d character %d: corner %v outside the hint %+v", tr, ch, c, h)
				}
			}
			// The circle is never wider than it must be: the maximum (and one of rounding) while the area fits
			// in it with the offset, else just what holds the area's corners.
			if limit := max(MaxHintRadius+1, int(math.Ceil(float64(tr+1)*math.Sqrt2))); h.Radius > limit {
				t.Fatalf("tr %d: radius %d over %d", tr, h.Radius, limit)
			}
		}
	}
}

func TestFuzzHintIsDeterministicAndVaries(t *testing.T) {
	a := FuzzHint(50, 60, 2, HintSeed(7, "q", "s", 50, 60, 7))
	b := FuzzHint(50, 60, 2, HintSeed(7, "q", "s", 50, 60, 7))
	if a != b {
		t.Fatalf("same seed, different hints: %+v %+v", a, b)
	}
	seen := map[Hint]bool{}
	for ch := int64(1); ch <= 50; ch++ {
		seen[FuzzHint(50, 60, 2, HintSeed(ch, "q", "s", 50, 60, 7))] = true
	}
	if len(seen) < 10 {
		t.Fatalf("hints of 50 characters take only %d places: the fuzz is too weak to hide the target", len(seen))
	}
	if HintSeed(1, "q", "s", 5, 6, 7) == HintSeed(1, "q", "t", 5, 6, 7) || HintSeed(1, "qs", "", 5, 6, 7) == HintSeed(1, "q", "s", 5, 6, 7) {
		t.Fatal("the seed must depend on the step and keep the quest and step apart")
	}
}

// Two targets of the same step (two spawns of the monster of a kill) are moved different
// ways: a player who knows one spawn cannot subtract the offset and find the other.
func TestFuzzHintOffsetDependsOnTheTarget(t *testing.T) {
	same := 0
	for ch := int64(1); ch <= 200; ch++ {
		a := FuzzHint(100, 100, 3, HintSeed(ch, "q", "s", 100, 100, 7))
		b := FuzzHint(300, 140, 3, HintSeed(ch, "q", "s", 300, 140, 7))
		if a.X-100 == b.X-300 && a.Y-100 == b.Y-140 {
			same++
		}
	}
	if same > 20 {
		t.Fatalf("%d of 200 characters get the same offset for two targets of a step", same)
	}
	for _, o := range [][3]int{{101, 100, 7}, {100, 101, 7}, {100, 100, 8}, {356, 100, 7}} {
		if HintSeed(1, "q", "s", 100, 100, 7) == HintSeed(1, "q", "s", o[0], o[1], o[2]) {
			t.Fatalf("the seed of target %v is the one of 100,100,7", o)
		}
	}
}
