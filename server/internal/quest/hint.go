package quest

import (
	"hash/fnv"
	"math"
)

// Objective hints (docs/02 "Minimapa"): the minimap of a player tracking a quest shows an
// estimate of where its current step happens, a circle around a point near the target,
// never the target itself. The estimate is deterministic for a character, quest and step
// (it does not move every time it is sent, which would let a player average it away), and
// the target's own area always lies inside the circle.

// Hint limits, in tiles.
const (
	// MinHintRadius is the smallest circle sent: a target of one tile still gets one.
	MinHintRadius = 6
	// MaxHintRadius bounds the circle (a wide zone is shown as wide as it can be).
	MaxHintRadius = 24
)

// Hint is a fuzzed objective area: a centre and a radius (Euclidean, in tiles).
type Hint struct {
	X, Y   int
	Radius int
}

// FuzzHint returns the hint of a target at x, y whose own area reaches targetRadius tiles
// around it (0: one tile), for the given seed (HintSeed). The circle's radius is twice the
// target's area (at least MinHintRadius, at most MaxHintRadius) and its centre is moved
// away from the target by between a quarter and a half of it, in a direction the seed
// picks: never 0 tiles, and the whole target area (up to targetRadius tiles around x, y)
// stays inside the circle when targetRadius is at most MaxHintRadius/2.
func FuzzHint(x, y, targetRadius int, seed uint64) Hint {
	tr := max(targetRadius, 0)
	r := min(max(2*tr+2, MinHintRadius), MaxHintRadius)
	// The offset leaves room for the target's area: d + tr*√2 <= r (a square area's corner).
	room := float64(r) - float64(tr)*math.Sqrt2
	lo, hi := float64(r)/4, min(float64(r)/2, room)
	if hi < 1 {
		hi = 1
	}
	if lo > hi {
		lo = hi
	}
	f1 := float64(seed&0xFFFF) / 0xFFFF
	f2 := float64(seed>>16&0xFFFF) / 0xFFFF
	d := lo + (hi-lo)*f1
	a := 2 * math.Pi * f2
	dx, dy := int(math.Round(d*math.Cos(a))), int(math.Round(d*math.Sin(a)))
	if dx == 0 && dy == 0 {
		dx = 1
		if seed>>32&1 == 1 {
			dx = -1
		}
	}
	// Rounding may push the corner of the area out by a fraction: grow the circle to hold it.
	for float64(r) < math.Hypot(math.Abs(float64(dx))+float64(tr), math.Abs(float64(dy))+float64(tr)) && r < MaxHintRadius+tr*2 {
		r++
	}
	return Hint{X: x + dx, Y: y + dy, Radius: r}
}

// HintSeed is the seed of a character's hint for one step of a quest.
func HintSeed(character int64, questID, stepID string) uint64 {
	h := fnv.New64a()
	var b [8]byte
	for i := range b {
		b[i] = byte(character >> (8 * i))
	}
	_, _ = h.Write(b[:])
	_, _ = h.Write([]byte(questID))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(stepID))
	return h.Sum64()
}
