package world

import "fmt"

// PortalKind is how a portal of portals.yaml moves a player (docs/02-game-design.md
// "Cambiar de piso", docs/03-world-and-maps.md). Its numbers are those of world.bin.
type PortalKind uint8

// Portal kinds. Stairs, holes and teleports move whoever steps onto their tile; a ladder
// is used (UseItem on its tile); a rope spot needs a rope used on it. A boat portal moves
// nobody: boat travel is the captain's (data/boat_routes.yaml, docs/02 "Viajes en barco").
const (
	PortalStairs PortalKind = iota + 1
	PortalLadder
	PortalHole
	PortalRopeSpot
	PortalTeleport
	PortalBoat
)

var portalKindNames = [...]string{
	PortalStairs:   "stairs",
	PortalLadder:   "ladder",
	PortalHole:     "hole",
	PortalRopeSpot: "rope_spot",
	PortalTeleport: "teleport",
	PortalBoat:     "boat",
}

// ParsePortalKind returns the kind named s in portals.yaml.
func ParsePortalKind(s string) (PortalKind, bool) {
	for k, name := range portalKindNames {
		if name != "" && name == s {
			return PortalKind(k), true
		}
	}
	return 0, false
}

func (k PortalKind) String() string {
	if k.valid() {
		return portalKindNames[k]
	}
	return fmt.Sprintf("portal kind %d", uint8(k))
}

func (k PortalKind) valid() bool { return k >= PortalStairs && k <= PortalBoat }

// OnStep reports whether stepping onto the portal's tile moves the player: stairs, holes
// and teleports. Nobody else stands on such a tile: monsters and walking paths keep off
// it, and a search for a free tile skips it.
func (k PortalKind) OnStep() bool {
	return k == PortalStairs || k == PortalHole || k == PortalTeleport
}

// Portal is an entry of world/islands/<id>/portals.yaml: it leads from the tile From (on
// its island) to the tile To (on any island).
type Portal struct {
	ID   string
	Kind PortalKind
	From Pos
	To   Pos
}

// MaxPortals bounds the portals of one island (world.bin keeps a u16 count).
const MaxPortals = 0xFFFF

// indexPortals checks the portals of every island and indexes them by their From tile:
// ids unique in the world (validHouseID's format, the id of the map schemas), a known
// kind, From a walkable tile of its island on a floor it lists, To a walkable tile of an
// island, the two ends apart, the floor rules of the kinds (stairs, ladders, holes and
// rope spots change floor; a hole leads down and a rope spot up), one portal per tile, no
// end inside a house (of any island), and nobody standing for good on the entrance of a
// stairs, hole or teleport: no NPC there (it would block it) and no spawn of radius 0
// there (monsters keep off it: it would stay empty). Those entrances get FlagPortalStep.
// packages/map-format (make validate) checks all of this too, and more (the way back of
// stairs and ladders, what the temple reaches on foot).
func (m *Map) indexPortals() error {
	for _, is := range m.islands { // NewMap owns the bit: a decoded world.bin carries it
		for _, s := range is.sectors {
			if s != nil {
				for i := range s.Flags {
					s.Flags[i] &^= FlagPortalStep
				}
			}
		}
	}
	ids := map[string]bool{}
	for _, is := range m.islands {
		if len(is.Portals) > MaxPortals {
			return fmt.Errorf("island %q: %d portals, at most %d", is.ID, len(is.Portals), MaxPortals)
		}
		for i := range is.Portals {
			pt := &is.Portals[i]
			if !validHouseID(pt.ID) || ids[pt.ID] {
				return fmt.Errorf("island %q: portal %q needs a unique id", is.ID, pt.ID)
			}
			ids[pt.ID] = true
			if !pt.Kind.valid() {
				return fmt.Errorf("island %q: portal %q: unknown %v", is.ID, pt.ID, pt.Kind)
			}
			f, t := pt.From, pt.To
			if !is.Rect.Contains(int(f.X), int(f.Y)) || !is.hasFloor(f.Z) || !m.Walkable(f) {
				return fmt.Errorf("island %q: portal %q: entrance %v is not a walkable tile of the island", is.ID, pt.ID, f)
			}
			if !m.Walkable(t) {
				return fmt.Errorf("island %q: portal %q: destination %v is not a walkable tile of an island", is.ID, pt.ID, t)
			}
			switch {
			case f == t:
				return fmt.Errorf("island %q: portal %q leads to its own tile %v", is.ID, pt.ID, f)
			case f.Z == t.Z && pt.Kind != PortalTeleport && pt.Kind != PortalBoat:
				return fmt.Errorf("island %q: portal %q: %v must change floor", is.ID, pt.ID, pt.Kind)
			case pt.Kind == PortalHole && t.Z <= f.Z:
				return fmt.Errorf("island %q: portal %q: a hole leads down", is.ID, pt.ID)
			case pt.Kind == PortalRopeSpot && t.Z >= f.Z:
				return fmt.Errorf("island %q: portal %q: a rope spot leads up", is.ID, pt.ID)
			}
			if o := m.portalAt[f]; o != nil {
				return fmt.Errorf("island %q: portals %q and %q leave from the same tile %v", is.ID, o.ID, pt.ID, f)
			}
			for _, end := range []Pos{f, t} {
				if h := m.houseAt[end]; h != nil {
					return fmt.Errorf("island %q: portal %q: %v lies in house %q", is.ID, pt.ID, end, h.ID)
				}
			}
			m.portalAt[f] = pt
			m.portals = append(m.portals, pt)
			if pt.Kind.OnStep() {
				s, i := m.sectorAt(int(f.X), int(f.Y), int(f.Z))
				s.Flags[i] |= FlagPortalStep // f is walkable: its sector exists
			}
		}
	}
	for _, is := range m.islands {
		for _, n := range is.NPCs {
			if pt := m.stepPortalAt(n.Pos); pt != nil {
				return fmt.Errorf("island %q: NPC %q stands on the entrance of portal %q, which nobody could take", is.ID, n.NPC, pt.ID)
			}
		}
		for _, sp := range is.Spawns {
			if pt := m.stepPortalAt(sp.Center); pt != nil && sp.Radius == 0 {
				return fmt.Errorf("island %q: spawn %q of radius 0 lies on the entrance of portal %q, where no monster appears", is.ID, sp.ID, pt.ID)
			}
		}
	}
	return nil
}

// stepPortalAt returns the stairs, hole or teleport that leaves from p, or nil.
func (m *Map) stepPortalAt(p Pos) *Portal {
	if pt := m.PortalAt(p); pt != nil && pt.Kind.OnStep() {
		return pt
	}
	return nil
}

// PortalAt returns the portal that leaves from p, or nil.
func (m *Map) PortalAt(p Pos) *Portal {
	if len(m.portalAt) == 0 {
		return nil
	}
	return m.portalAt[p]
}

// MovesOnStep reports whether stepping onto p moves a player elsewhere (a stairs, hole
// or teleport portal leaves from p). It reads FlagPortalStep: path searches call it for
// every tile they expand.
func (m *Map) MovesOnStep(p Pos) bool {
	return m.Flags(p)&FlagPortalStep != 0
}

// Portals returns every portal of the map, island by island in file order.
func (m *Map) Portals() []*Portal { return m.portals }
