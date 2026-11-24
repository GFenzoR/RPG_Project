package quest

import (
	"math"
	"testing"
)

func TestFuzzHintNeverExactAndHoldsTheTarget(t *testing.T) {
	for _, tr := range []int{0, 1, 3, 5, 8, 12, 16, 30} {
		for ch := int64(1); ch <= 400; ch++ {
			seed := HintSeed(ch, "ch1_shipwreck", "clear_wolves")
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
			if tr <= MaxHintRadius/2-2 && h.Radius > MaxHintRadius {
				t.Fatalf("tr %d: radius %d over the maximum", tr, h.Radius)
			}
		}
	}
}

func TestFuzzHintIsDeterministicAndVaries(t *testing.T) {
	a := FuzzHint(50, 60, 2, HintSeed(7, "q", "s"))
	b := FuzzHint(50, 60, 2, HintSeed(7, "q", "s"))
	if a != b {
		t.Fatalf("same seed, different hints: %+v %+v", a, b)
	}
	seen := map[Hint]bool{}
	for ch := int64(1); ch <= 50; ch++ {
		seen[FuzzHint(50, 60, 2, HintSeed(ch, "q", "s"))] = true
	}
	if len(seen) < 10 {
		t.Fatalf("hints of 50 characters take only %d places: the fuzz is too weak to hide the target", len(seen))
	}
	if HintSeed(1, "q", "s") == HintSeed(1, "q", "t") || HintSeed(1, "qs", "") == HintSeed(1, "q", "s") {
		t.Fatal("the seed must depend on the step and keep the quest and step apart")
	}
}
