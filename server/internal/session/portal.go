package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Portals (docs/02-game-design.md "Cambiar de piso"): the stairs, ladders, holes, rope
// spots and teleports of world/islands/<id>/portals.yaml, which mapcompile writes to
// world.bin (world.Map.PortalAt). The server moves the player; the client only sees a
// teleport (FullMapView), as with a boat or a staff /tp.
//   - Stairs, holes and teleports move whoever steps onto their tile: the step happens
//     (the ones who see it watch the player walk onto the stairs) and the player lands on
//     the other end. Only players: monsters never step onto such a tile (monsterCanEnter),
//     and a walk path or a search for a free tile goes around it.
//   - A ladder is used: UseItem on its tile, from at most inventory.reach tiles away.
//   - A rope spot needs a rope: UseItemOn of a tool with tool.use rope on its tile, from
//     the same reach. Using it bare says a rope is needed.
//   - A boat portal does nothing: boat travel is the captain's (travel.go).
// The player lands on the portal's destination or, if it is taken, on the nearest free
// tile within travel.arrival_radius (freeNear: never in the room behind a locked door, never
// on a tile a portal leaves from on step) that is no house tile. With no free tile the
// move is refused (portal.blocked) and nothing changes. An attacker under its PvP lock
// cannot reach a protection zone through a portal from outside one, like on foot.

// i18n keys of the portal messages (i18n/*/client.yaml).
const (
	msgPortalBlocked  = "portal.blocked"
	msgPortalNotReady = "portal.not_ready"
	msgPortalNeedRope = "portal.need_rope"
)

// ropeUse is the tool.use of a rope (data/items/tools.yaml): the tool that climbs a rope
// spot.
const ropeUse = "rope"

// stepPortal returns the portal that moves whoever steps onto to (stairs, hole,
// teleport), or nil.
func (w *World) stepPortal(to world.Pos) *world.Portal {
	if pt := w.m.PortalAt(to); pt != nil && pt.Kind.OnStep() {
		return pt
	}
	return nil
}

// portalArrival returns where p lands through pt, or the message that refuses the move:
// no free tile around its destination, or an attacker under its PvP lock that would go
// from outside a protection zone into one.
func (w *World) portalArrival(ctx *game.TickContext, p *Player, pt *world.Portal) (world.Pos, string) {
	to, ok := w.freeAround(pt.To, w.arrivalRadius, true)
	switch {
	case !ok:
		return world.Pos{}, msgPortalBlocked
	case ctx.Tick < p.lockUntil && w.inProtection(to) && !w.inProtection(p.pos):
		return world.Pos{}, msgPvPProtLocked
	}
	return to, ""
}

// usePortal answers a UseItem on the tile of a ladder (climb it) or of a rope spot (it
// needs a rope). It reports whether the UseItem was about such a tile p sees; an item
// lying on it (a dropped bag) is used as usual.
func (w *World) usePortal(ctx *game.TickContext, p *Player, m *pb.UseItem) bool {
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	if !ok || pos.Z != p.pos.Z || !Sees(p.pos, pos) {
		return false
	}
	pt := w.m.PortalAt(pos)
	i := int(m.GetStackIndex())
	if pt == nil || pt.Kind != world.PortalLadder && pt.Kind != world.PortalRopeSpot || i >= w.staticCount(pos) {
		return false
	}
	switch {
	case uint32(w.staticAt(pos, i)) != m.GetItemId():
		p.emit(systemMsg(msgNotPossible)) // a stale view
	case pt.Kind == world.PortalRopeSpot:
		p.emit(systemMsg(msgPortalNeedRope))
	case !w.near(p, pos):
		p.emit(systemMsg(msgTooFar))
	default:
		w.climb(ctx, p, pt)
	}
	return true
}

// useRope answers a UseItemOn of the rope tool (carried by p) on a rope spot p sees. It
// reports whether it was about one: on any other tile the rope goes on to gathering.
func (w *World) useRope(ctx *game.TickContext, p *Player, tool *Item, target *pb.ActionTarget) bool {
	tp, ok := target.GetTarget().(*pb.ActionTarget_Pos)
	if !ok || tool.def.Tool == nil || tool.def.Tool.Use != ropeUse {
		return false
	}
	pos, ok := posFromMsg(tp.Pos)
	if !ok || pos.Z != p.pos.Z || !Sees(p.pos, pos) {
		return false
	}
	pt := w.m.PortalAt(pos)
	if pt == nil || pt.Kind != world.PortalRopeSpot {
		return false
	}
	if !w.near(p, pos) {
		p.emit(systemMsg(msgTooFar))
		return true
	}
	w.climb(ctx, p, pt)
	return true
}

// climb takes p up or down a ladder or a rope spot. It takes as long as a step onto the
// destination, and not while a step lasts: a climb is a move, at the pace of walking.
func (w *World) climb(ctx *game.TickContext, p *Player, pt *world.Portal) {
	if ctx.Tick < p.readyAt {
		p.tooEarly(ctx.Tick, antibot.KindOther)
		p.emit(systemMsg(msgPortalNotReady))
		return
	}
	to, refuse := w.portalArrival(ctx, p, pt)
	if refuse != "" {
		p.emit(systemMsg(refuse))
		return
	}
	p.activePaced(ctx.Tick, antibot.KindOther, p.readyAt)
	ground, _, _ := w.m.Tile(to)
	p.readyAt = ctx.Tick + w.StepTicks(ground, p.speed, false)
	w.Teleport(p, to)
}
