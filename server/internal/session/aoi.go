package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/world"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Area of interest (docs/01-architecture.md): a player sees 15x11 tiles plus a margin of
// one tile on every side, so the client can animate creatures walking in. The area is
// centred on the player.
const (
	ViewHalfW = 7 + 1 // tiles left and right of the player (margin included)
	ViewHalfH = 5 + 1 // tiles above and below
	ViewW     = 2*ViewHalfW + 1
	ViewH     = 2*ViewHalfH + 1
	// SeaLevel is the surface floor. From floor SeaLevel and above (z <= 7) a player
	// sees every floor from 0 to SeaLevel; underground only its own floor.
	SeaLevel = 7
)

// sameView reports whether floors a and b are seen together: both above ground, or the
// same underground floor. It is symmetric.
func sameView(a, b uint8) bool { return a == b || (a <= SeaLevel && b <= SeaLevel) }

// Sees reports whether a player standing at viewer sees tile p. It is symmetric, which
// keeps "o knows c" equal to "c knows o" for two players.
func Sees(viewer, p world.Pos) bool {
	dx, dy := int(p.X)-int(viewer.X), int(p.Y)-int(viewer.Y)
	return dx >= -ViewHalfW && dx <= ViewHalfW && dy >= -ViewHalfH && dy <= ViewHalfH && sameView(viewer.Z, p.Z)
}

// viewFloors returns the floors visible from floor z, top (lowest number) first.
func viewFloors(z uint8, dst []uint8) []uint8 {
	dst = dst[:0]
	if z > SeaLevel {
		return append(dst, z)
	}
	for f := uint8(0); f <= SeaLevel; f++ {
		dst = append(dst, f)
	}
	return dst
}

// ---- spatial index -----------------------------------------------------------------

func sectorKey(x, y int, z uint8) uint64 {
	return uint64(z)<<32 | uint64(x/world.SectorSize)<<16 | uint64(y/world.SectorSize)
}

func (w *World) index(p *Player) {
	k := sectorKey(int(p.pos.X), int(p.pos.Y), p.pos.Z)
	w.sectors[k] = append(w.sectors[k], p)
}

func (w *World) unindex(p *Player) {
	k := sectorKey(int(p.pos.X), int(p.pos.Y), p.pos.Z)
	list := w.sectors[k]
	for i, q := range list {
		if q == p {
			list = append(list[:i], list[i+1:]...) // keep order: deterministic
			break
		}
	}
	if len(list) == 0 {
		delete(w.sectors, k)
	} else {
		w.sectors[k] = list
	}
}

// eachInRect calls fn for every creature standing in [x0, x1] x [y0, y1] on a floor seen
// together with z. Iteration order is deterministic.
func (w *World) eachInRect(x0, y0, x1, y1 int, z uint8, fn func(*Player)) {
	x0, y0 = max(x0, 0), max(y0, 0)
	x1, y1 = min(x1, 0xFFFF), min(y1, 0xFFFF)
	if x0 > x1 || y0 > y1 {
		return
	}
	var floors [SeaLevel + 1]uint8
	for _, f := range viewFloors(z, floors[:0]) {
		for sy := y0 / world.SectorSize; sy <= y1/world.SectorSize; sy++ {
			for sx := x0 / world.SectorSize; sx <= x1/world.SectorSize; sx++ {
				for _, p := range w.sectors[uint64(f)<<32|uint64(sx)<<16|uint64(sy)] {
					x, y := int(p.pos.X), int(p.pos.Y)
					if x >= x0 && x <= x1 && y >= y0 && y <= y1 {
						fn(p)
					}
				}
			}
		}
	}
}

// eachObserver calls fn for every other player that sees p.
func (w *World) eachObserver(c *Player, p world.Pos, fn func(*Player)) {
	w.eachInRect(int(p.X)-ViewHalfW, int(p.Y)-ViewHalfH, int(p.X)+ViewHalfW, int(p.Y)+ViewHalfH, p.Z, func(o *Player) {
		if o != c {
			fn(o)
		}
	})
}

// creatureAt returns a player standing on p, or nil.
func (w *World) creatureAt(p world.Pos) *Player {
	for _, c := range w.sectors[sectorKey(int(p.X), int(p.Y), p.Z)] {
		if c.pos == p {
			return c
		}
	}
	return nil
}

// occupied reports whether a player or a monster stands on p.
func (w *World) occupied(p world.Pos) bool {
	return w.creatureAt(p) != nil || w.monsterAt(p) != nil
}

// creaturePos returns where the creature with id (player or monster) stands.
func (w *World) creaturePos(id uint32) (world.Pos, bool) {
	if p := w.playerByID(id); p != nil {
		return p.pos, true
	}
	if m := w.monByID[id]; m != nil {
		return m.pos, true
	}
	return world.Pos{}, false
}

// observeMove tells every client around either end of a step of a creature (the player
// pl or the monster mo) what it needs: CreatureMove if it keeps seeing it,
// CreatureDisappear if it stops, CreatureAppear if it starts. The mover's own client is
// the caller's job. fromMsg and toMsg are shared by every CreatureMove.
func (w *World) observeMove(pl *Player, mo *Monster, from, to world.Pos, fromMsg, toMsg *pb.Position, durMs uint32) {
	var id uint32
	if pl != nil {
		id = pl.id
	} else {
		id = mo.id
	}
	x0, x1 := int(min(from.X, to.X))-ViewHalfW, int(max(from.X, to.X))+ViewHalfW
	y0, y1 := int(min(from.Y, to.Y))-ViewHalfH, int(max(from.Y, to.Y))+ViewHalfH
	w.eachInRect(x0, y0, x1, y1, to.Z, func(o *Player) {
		if o == pl {
			return
		}
		sees := Sees(o.pos, to)
		switch knows := o.Knows(id); {
		case knows && sees:
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureMove{CreatureMove: &pb.CreatureMove{
				Id: id, From: fromMsg, To: toMsg, DurationMs: durMs,
			}}})
		case knows:
			o.forget(id)
			o.emit(disappearMsg(id))
		case sees:
			o.remember(id)
			c := (*pb.Creature)(nil)
			if pl != nil {
				c = w.creatureMsg(pl)
			} else {
				c = w.monsterMsg(mo)
			}
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureAppear{CreatureAppear: &pb.CreatureAppear{Creature: c}}})
		}
	})
}

// ---- appear and disappear ---------------------------------------------------------

func (w *World) appearToObservers(c *Player) {
	w.eachObserver(c, c.pos, func(o *Player) {
		if !o.Knows(c.id) {
			o.remember(c.id)
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureAppear{CreatureAppear: &pb.CreatureAppear{Creature: w.creatureMsg(c)}}})
		}
	})
}

func (w *World) disappearFromObservers(c *Player) {
	w.eachObserver(c, c.pos, func(o *Player) {
		if o.forget(c.id) {
			o.emit(disappearMsg(c.id))
		}
	})
}

func disappearMsg(id uint32) *pb.ServerMessage {
	return &pb.ServerMessage{Message: &pb.ServerMessage_CreatureDisappear{CreatureDisappear: &pb.CreatureDisappear{Id: id}}}
}

// ---- map areas --------------------------------------------------------------------

// sendFullView sends p the whole visible area and resets what its client knows to the
// creatures in it (on login and after a teleport).
func (w *World) sendFullView(p *Player) {
	for _, id := range p.known {
		if id != p.id {
			p.emit(disappearMsg(id))
		}
	}
	p.known = p.known[:0]
	x0, y0 := int(p.pos.X)-ViewHalfW, int(p.pos.Y)-ViewHalfH
	area := w.mapArea(p, x0, y0, ViewW, ViewH)
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_FullMapView{FullMapView: &pb.FullMapView{Area: area}}})
}

// sendSlice sends p the rectangle (x0, y0, wd, ht) that just came into view.
func (w *World) sendSlice(p *Player, x0, y0, wd, ht int) {
	area := w.mapArea(p, x0, y0, wd, ht)
	if area == nil {
		return
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_MapSlice{MapSlice: &pb.MapSlice{Area: area}}})
}

// mapArea builds the palette-compressed MapArea of the rectangle (clipped to the world)
// on every floor p sees, with the creatures in it that p's client does not know yet
// (which it then knows). It returns nil for an empty rectangle.
func (w *World) mapArea(p *Player, x0, y0, wd, ht int) *pb.MapArea {
	if x0 < 0 {
		wd += x0
		x0 = 0
	}
	if y0 < 0 {
		ht += y0
		y0 = 0
	}
	wd, ht = min(wd, 0x10000-x0), min(ht, 0x10000-y0)
	if wd <= 0 || ht <= 0 {
		return nil
	}
	area := &pb.MapArea{X: uint32(x0), Y: uint32(y0), Width: uint32(wd), Height: uint32(ht)}
	var floors [SeaLevel + 1]uint8
	var stack []uint16
	for _, z := range viewFloors(p.pos.Z, floors[:0]) {
		tiles := make([]int32, wd*ht)
		any := false
		for y := range ht {
			for x := range wd {
				pos := world.Pos{X: uint16(x0 + x), Y: uint16(y0 + y), Z: z}
				ground, _, ok := w.m.Tile(pos)
				idx := int32(-1)
				if ok {
					stack = append(stack[:0], ground)
					stack = append(stack, w.m.Stack(pos)...)
					stack = append(stack, w.ground[pos]...)
					idx = paletteIndex(area, stack)
					any = true
				}
				tiles[y*wd+x] = idx
			}
		}
		if any {
			area.Floors = append(area.Floors, &pb.MapFloor{Z: uint32(z), Tiles: tiles})
		}
	}
	w.eachInRect(x0, y0, x0+wd-1, y0+ht-1, p.pos.Z, func(c *Player) {
		if c == p || !p.Knows(c.id) {
			p.remember(c.id)
			area.Creatures = append(area.Creatures, w.creatureMsg(c))
		}
	})
	w.eachMonsterInRect(x0, y0, x0+wd-1, y0+ht-1, p.pos.Z, func(m *Monster) {
		if !p.Knows(m.id) {
			p.remember(m.id)
			area.Creatures = append(area.Creatures, w.monsterMsg(m))
		}
	})
	return area
}

// paletteIndex returns the index of stack in area's palette, adding it if new. Areas
// are small (a view has at most 221 tiles per floor), so a linear search is enough.
func paletteIndex(area *pb.MapArea, stack []uint16) int32 {
	for i, t := range area.Palette {
		if len(t.Items) != len(stack) {
			continue
		}
		same := true
		for j, it := range t.Items {
			if it.ItemId != uint32(stack[j]) {
				same = false
				break
			}
		}
		if same {
			return int32(i)
		}
	}
	t := &pb.Tile{Items: make([]*pb.ItemStack, len(stack))}
	for j, id := range stack {
		t.Items[j] = &pb.ItemStack{ItemId: uint32(id)}
	}
	area.Palette = append(area.Palette, t)
	return int32(len(area.Palette) - 1)
}
