package world

// LineOfSight reports whether a projectile or a spell can travel from a to b: both on the
// same floor and no tile strictly between them with FlagBlocksSight. The endpoints
// themselves never block (a creature can shoot at a target standing next to a wall).
//
// The line is a Bresenham line traced from the endpoint with the lower (y, x), so the
// answer is symmetric: LineOfSight(a, b) == LineOfSight(b, a).
func (m *Map) LineOfSight(a, b Pos) bool {
	if a.Z != b.Z {
		return false
	}
	if b.Y < a.Y || (b.Y == a.Y && b.X < a.X) {
		a, b = b, a
	}
	x0, y0, x1, y1 := int(a.X), int(a.Y), int(b.X), int(b.Y)
	z := int(a.Z)
	dx, dy := x1-x0, y1-y0
	sx := 1
	if dx < 0 {
		dx, sx = -dx, -1
	}
	// dy >= 0 after the swap.
	errTerm := dx - dy
	x, y := x0, y0
	for {
		e2 := 2 * errTerm
		if e2 > -dy {
			errTerm -= dy
			x += sx
		}
		if e2 < dx {
			errTerm += dx
			y++
		}
		if x == x1 && y == y1 {
			return true
		}
		if _, f, _ := m.tile(x, y, z); f&FlagBlocksSight != 0 {
			return false
		}
	}
}
