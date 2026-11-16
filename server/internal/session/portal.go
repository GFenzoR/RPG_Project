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
//     (the ones who see it get the step, then the CreatureDisappear: their client drops
//     the player at once, without drawing the step) and the player lands on the other
//     end. Only players: monsters never step onto such a tile (monsterCanEnter), and a
//     walk path or a search for a free tile goes around it.
//   - A ladder is used: UseItem on its tile, from at most inventory.reach tiles away and
//     in line of sight (like gathering: no ladder across a wall when the reach is above 1).
//   - A rope spot needs a rope: UseItemOn of a tool with tool.use rope on its tile, from
//     the same reach and in sight. Using it bare says a rope is needed.
//   - A boat portal does nothing: boat travel is the captain's (travel.go).
// The player lands on the portal's destination or, if it is taken, on the nearest free
// tile within travel.arrival_radius (freeAround: only in the area of the destination, never
// on a tile a portal leaves from on step) that is no house tile. With no free tile the
// move is refused (portal.blocked) and nothing changes. An attacker under its PvP lock
// cannot reach a protection zone through a portal from outside one, like on foot: from
// the tile it takes the portal on (the stairs it steps onto, or where it stands to climb
// a ladder or a rope).
//
// What is dropped (MoveItem) onto stairs, a hole or a teleport falls through to the other
// end (fallTo): it lands on the destination or, if that has no room for it, on the closest
// tile around it with room, by the rules of a player's arrival (its area, no house tile,
// no entrance of stairs, a hole or a teleport). Everything else about the move is a drop
// on that tile: the hold of a transfer (heldDrop), the reservations of hold.go, what
// leaves a house (leftHouse), the economy ledger.
//
// Every portal (but a boat) stands under an item that shows it (content.PortalLook,
// docs/03): make validate and mapcompile refuse a map without it; the server warns again
// at startup (initPortals), for a world.bin compiled before data/items changed.

// i18n keys of the portal messages (i18n/*/client.yaml).
const (
	msgPortalBlocked  = "portal.blocked"
	msgPortalNotReady = "portal.not_ready"
	msgPortalNeedRope = "portal.need_rope"
	msgPortalNoRoom   = "portal.no_room"
)

// initPortals warns about every portal (but a boat) whose entrance holds no item that
// shows it (content.PortalLook). make validate and mapcompile (compile.checkPortalLooks)
// refuse such a map, so only a world.bin compiled before data/items changed gets here;
// world.NewMap cannot check it (world.bin keeps item numbers, not what they are). It warns
// rather than stops: a portal without its item still works, it only looks like plain
// ground (the client keeps its paths off it all the same, from portals.yaml), and the
// maps of the tests (world.NewMap, no data/items) put portals on bare tiles.
func (w *World) initPortals() {
	for _, pt := range w.m.Portals() {
		if pt.Kind != world.PortalBoat && !w.portalShown(pt) {
			w.log.Warn("session: portal without the item that shows it on its entrance",
				"portal", pt.ID, "kind", pt.Kind.String(), "pos", pt.From)
		}
	}
}

// portalShown reports whether the entrance of pt holds an item whose portal block shows
// it: its kind and, if the item says one, the way it leads.
func (w *World) portalShown(pt *world.Portal) bool {
	shows := func(id uint16) bool {
		def := w.byNum[id]
		return def != nil && def.Portal.Shows(pt.Kind.String(), pt.From.Z, pt.To.Z)
	}
	ground, _, _ := w.m.Tile(pt.From)
	if shows(ground) {
		return true
	}
	for _, id := range w.m.Stack(pt.From) {
		if shows(id) {
			return true
		}
	}
	return false
}

// fallTo returns where count units of it, dropped by p onto the stairs, hole or teleport
// pt, land: its destination or, if that has no room for them, the closest tile within
// travel.arrival_radius in the area of the destination (searchRings: never a room behind
// a locked door nor a pocket sealed by walls) that is walkable, no house tile and no
// entrance of stairs, a hole or a teleport (nothing lands where it would fall again), with
// room for them: a pile they join (groundMerge, with leaving as in moveItem) or fewer than
// maxGroundItems items. Creatures do not matter: an item lies under them.
func (w *World) fallTo(p *Player, it *Item, count int, pt *world.Portal, leaving bool) (world.Pos, bool) {
	skip := world.FlagBlocksMovement | world.FlagPortalStep | world.FlagHouse
	return w.searchRings(pt.To, w.arrivalRadius, skip, func(q world.Pos) bool {
		return len(w.ground[q]) < maxGroundItems || w.groundMerge(p, it, count, q, leaving) != nil
	})
}

// ropeUse is the tool.use of a rope (data/items/tools.yaml): the tool that climbs a rope
// spot.
const ropeUse = "rope"

// stepPortal returns the portal that moves whoever steps onto to (stairs, hole,
// teleport), or nil.
func (w *World) stepPortal(to world.Pos) *world.Portal {
	if !w.m.MovesOnStep(to) { // the tile's flag: no index lookup on a plain step
		return nil
	}
	if pt := w.m.PortalAt(to); pt != nil && pt.Kind.OnStep() {
		return pt
	}
	return nil
}

// portalArrival returns where p lands through pt, taken on the tile from, or the message
// that refuses the move: no free tile around its destination, or an attacker under its
// PvP lock that would go from outside a protection zone into one. from is the tile of
// stairs, a hole or a teleport p steps onto (a step off a protection zone onto stairs
// outside it leaves the zone, as on foot), or p's own tile for a ladder or a rope spot.
func (w *World) portalArrival(ctx *game.TickContext, p *Player, pt *world.Portal, from world.Pos) (world.Pos, string) {
	to, ok := w.freeAround(pt.To, w.arrivalRadius, true)
	switch {
	case !ok:
		return world.Pos{}, msgPortalBlocked
	case ctx.Tick < p.lockUntil && w.inProtection(to) && !w.inProtection(from):
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
	case !w.m.LineOfSight(p.pos, pos):
		p.emit(systemMsg(msgNoSight)) // with inventory.reach above 1: not across a wall
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
	switch {
	case !w.near(p, pos):
		p.emit(systemMsg(msgTooFar))
	case !w.m.LineOfSight(p.pos, pos):
		p.emit(systemMsg(msgNoSight))
	default:
		w.climb(ctx, p, pt)
	}
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
	to, refuse := w.portalArrival(ctx, p, pt, p.pos)
	if refuse != "" {
		p.emit(systemMsg(refuse))
		return
	}
	p.activePaced(ctx.Tick, antibot.KindOther, p.readyAt)
	ground, _, _ := w.m.Tile(to)
	p.readyAt = ctx.Tick + w.StepTicks(ground, p.speed, false)
	w.Teleport(p, to)
}
