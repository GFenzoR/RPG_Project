package presence

import (
	"math/rand/v2"
	"testing"
)

// Every swatch drawn for a color is classified back as that color (a person can always
// tell it), across the whole jitter range.
func TestSwatchRoundTrip(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for c := range Colors {
		for _, u := range [][3]float64{{0, 0, 0}, {0.999, 0.999, 0.999}, {0.5, 0.5, 0.5}} {
			if got := ColorOf(Swatch(c, u[0], u[1], u[2])); got != c {
				t.Fatalf("%s at %v read as %s", Colors[c], u, Colors[got])
			}
		}
		seen := map[uint32]bool{}
		for range 500 {
			s := Swatch(c, r.Float64(), r.Float64(), r.Float64())
			if got := ColorOf(s); got != c {
				t.Fatalf("%s swatch %06x read as %s", Colors[c], s, Colors[got])
			}
			seen[s] = true
		}
		if len(seen) < 100 {
			t.Fatalf("%s: only %d different swatches", Colors[c], len(seen))
		}
	}
}
