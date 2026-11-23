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
// random inside the hue band of the color, different on every check. The options keep
// their names (presence.option.<color>). A script can still classify the hue (nothing a
// client can render is secret, and a right answer never clears a suspicion), but it has
// to look at the color: no text of the question matches any option.

// Colors are the colors a presence check asks for; option keys are
// presence.option.<color>.
var Colors = [...]string{"red", "blue", "green", "yellow"}

// bands are the hue center and half-width (degrees) and the lightness range of
// each color of Colors: far apart, so no swatch is ambiguous.
var bands = [len(Colors)]struct{ hue, spread, lmin, lmax float64 }{
	{0, 10, 0.42, 0.52},   // red
	{220, 12, 0.42, 0.55}, // blue
	{125, 12, 0.35, 0.48}, // green
	{52, 6, 0.50, 0.58},   // yellow
}

// Swatch returns a random shade of Colors[c] as 0xRRGGBB; u1, u2 and u3 are
// uniform in [0, 1) (the caller's random source: this package has none).
func Swatch(c int, u1, u2, u3 float64) uint32 {
	b := bands[c]
	h := math.Mod(b.hue+(u1*2-1)*b.spread+360, 360)
	s := 0.65 + u2*0.25
	l := b.lmin + u3*(b.lmax-b.lmin)
	return hslToRGB(h, s, l)
}

// ColorOf returns the index in Colors of the color whose hue band is nearest
// to swatch rgb (what a person sees).
func ColorOf(rgb uint32) int {
	h := hueOf(rgb)
	best, bestD := 0, math.Inf(1)
	for i, b := range bands {
		d := math.Abs(h - b.hue)
		d = min(d, 360-d)
		if d < bestD {
			best, bestD = i, d
		}
	}
	return best
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
