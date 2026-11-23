// Package presence holds the presence check's colors (T4.1, lote 16): the swatch the
// server draws for a question and how a person (or the load-test bot) reads it back. It
// is pure (no clock, no randomness: the caller passes its random numbers) and depends on
// nothing, so the bot client of server/pkg/bot can use it.
package presence

import "math"

// The presence check's question (T4.1, lote 16). It used to name its color in its key
// (presence.question.red asked for presence.option.red), so a script answered it by
// matching key suffixes without reading anything. Now the question is one generic key
// (presence.question) and the color to pick is a swatch: a 0xRRGGBB number drawn at
// random inside the band of the color, different on every check. The options keep
// their names (presence.option.<color>). A script can still classify the hue (nothing a
// client can render is secret, and a right answer never clears a suspicion), but it has
// to look at the color: no text of the question matches any option.

// Colors are the colors a presence check asks for; option keys are
// presence.option.<color>. Lote 16 review: the swatch is the only cue, so the colors must
// not hinge on telling hues apart that a color-blind player cannot (red and green look
// alike with protanopia or deuteranopia, about 8% of men, and a wrong answer adds anti-bot
// points). Blue and yellow differ on the axis those players keep and in lightness, and
// white and black differ from everything in lightness alone: no pair depends on hue only.
var Colors = [...]string{"blue", "yellow", "white", "black"}

// bands are the hue center and half-width (degrees), the saturation range and the
// lightness range of each color of Colors. White and black are near-gray (any hue, a faint
// tint) and told apart from the others by lightness: ColorOf reads lightness first.
var bands = [len(Colors)]struct{ hue, spread, smin, smax, lmin, lmax float64 }{
	{220, 12, 0.65, 0.90, 0.42, 0.55}, // blue
	{52, 6, 0.65, 0.90, 0.50, 0.58},   // yellow
	{180, 180, 0, 0.15, 0.88, 0.97},   // white
	{180, 180, 0, 0.15, 0.04, 0.14},   // black
}

// The lightness thresholds of ColorOf: above lightOver it is white, below darkUnder black,
// between them the hue decides between blue and yellow.
const (
	lightOver = 0.75
	darkUnder = 0.25
)

// Swatch returns a random shade of Colors[c] as 0xRRGGBB; u1, u2 and u3 are
// uniform in [0, 1) (the caller's random source: this package has none).
func Swatch(c int, u1, u2, u3 float64) uint32 {
	b := bands[c]
	h := math.Mod(b.hue+(u1*2-1)*b.spread+360, 360)
	s := b.smin + u2*(b.smax-b.smin)
	l := b.lmin + u3*(b.lmax-b.lmin)
	return hslToRGB(h, s, l)
}

// ColorOf returns the index in Colors of the color swatch rgb shows (what a person sees):
// white or black by its lightness, otherwise the nearer hue of blue and yellow.
func ColorOf(rgb uint32) int {
	switch l := lightnessOf(rgb); {
	case l > lightOver:
		return 2
	case l < darkUnder:
		return 3
	}
	h := hueOf(rgb)
	best, bestD := 0, math.Inf(1)
	for i, b := range bands[:2] {
		d := math.Abs(h - b.hue)
		d = min(d, 360-d)
		if d < bestD {
			best, bestD = i, d
		}
	}
	return best
}

func lightnessOf(rgb uint32) float64 {
	r, g, b := float64(rgb>>16&0xff)/255, float64(rgb>>8&0xff)/255, float64(rgb&0xff)/255
	return (max(r, g, b) + min(r, g, b)) / 2
}

func hslToRGB(h, s, l float64) uint32 {
	c := (1 - math.Abs(2*l-1)) * s
	x := c * (1 - math.Abs(math.Mod(h/60, 2)-1))
	m := l - c/2
	var r, g, b float64
	switch {
	case h < 60:
		r, g = c, x
	case h < 120:
		r, g = x, c
	case h < 180:
		g, b = c, x
	case h < 240:
		g, b = x, c
	case h < 300:
		r, b = x, c
	default:
		r, b = c, x
	}
	to := func(v float64) uint32 { return uint32(math.Round((v + m) * 255)) }
	return to(r)<<16 | to(g)<<8 | to(b)
}

func hueOf(rgb uint32) float64 {
	r, g, b := float64(rgb>>16&0xff)/255, float64(rgb>>8&0xff)/255, float64(rgb&0xff)/255
	hi, lo := max(r, g, b), min(r, g, b)
	d := hi - lo
	if d == 0 {
		return 0
	}
	var h float64
	switch hi {
	case r:
		h = math.Mod((g-b)/d, 6)
	case g:
		h = (b-r)/d + 2
	default:
		h = (r-g)/d + 4
	}
	h *= 60
	if h < 0 {
		h += 360
	}
	return h
}
