package presence

import (
	"math"
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

// Lote 16 review: the swatch is the only cue of the question, so a player with protanopia
// or deuteranopia (about 8% of men) must tell every color from every other. Each swatch is
// simulated as such a player sees it (Viénot, Brettel and Mollon 1999, in linear RGB) and
// any two swatches of different colors must stay clearly apart; red and green did not.
func TestSwatchesApartForColorBlindPlayers(t *testing.T) {
	sims := map[string][3][3]float64{
		"protanopia":   {{0.11238, 0.88762, 0}, {0.11238, 0.88762, 0}, {0.00401, -0.00401, 1}},
		"deuteranopia": {{0.29275, 0.70725, 0}, {0.29275, 0.70725, 0}, {-0.02234, 0.02234, 1}},
	}
	r := rand.New(rand.NewPCG(3, 4))
	var shades [len(Colors)][]uint32
	for c := range Colors {
		for range 200 {
			shades[c] = append(shades[c], Swatch(c, r.Float64(), r.Float64(), r.Float64()))
		}
	}
	for name, m := range sims {
		if d := minApart(shades[:], m); d < minCVDDistance {
			t.Errorf("%s: two colors come within %.3f of each other, want at least %.2f", name, d, minCVDDistance)
		}
	}
}

// minCVDDistance is the least distance (sRGB, 0..1 per channel) between two swatches of
// different colors as a color-blind player sees them.
const minCVDDistance = 0.2

// minApart is the least distance between simulated swatches of two different colors.
func minApart(shades [][]uint32, m [3][3]float64) float64 {
	sim := make([][][3]float64, len(shades))
	for c, ss := range shades {
		for _, s := range ss {
			sim[c] = append(sim[c], simulate(s, m))
		}
	}
	best := math.Inf(1)
	for a := range sim {
		for b := a + 1; b < len(sim); b++ {
			for _, x := range sim[a] {
				for _, y := range sim[b] {
					best = min(best, math.Sqrt((x[0]-y[0])*(x[0]-y[0])+(x[1]-y[1])*(x[1]-y[1])+(x[2]-y[2])*(x[2]-y[2])))
				}
			}
		}
	}
	return best
}

// simulate is rgb as seen through m (a matrix on linear RGB), back in sRGB 0..1.
func simulate(rgb uint32, m [3][3]float64) [3]float64 {
	lin := func(v uint32) float64 {
		c := float64(v) / 255
		if c <= 0.04045 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	enc := func(c float64) float64 {
		c = min(max(c, 0), 1)
		if c <= 0.0031308 {
			return c * 12.92
		}
		return 1.055*math.Pow(c, 1/2.4) - 0.055
	}
	in := [3]float64{lin(rgb >> 16 & 0xff), lin(rgb >> 8 & 0xff), lin(rgb & 0xff)}
	var out [3]float64
	for i := range out {
		out[i] = enc(m[i][0]*in[0] + m[i][1]*in[1] + m[i][2]*in[2])
	}
	return out
}
