package session

import (
	"fmt"
	"sort"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/dialog"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Boat travel (T3.5, docs/02-game-design.md "Viajes en barco"): a captain NPC offers the
// routes of data/boat_routes.yaml in its dialog nodes marked boat_routes: true.

// System messages of boat travel (i18n keys).
const (
	msgSailed       = "travel.sailed"
	msgInCombat     = "travel.in_combat"
	msgNeedLevel    = "travel.need_level"
	msgNeedQuest    = "travel.need_quest"
	msgNeedItem     = "travel.need_item"
	msgArrivalFull  = "travel.no_room"
	msgTravelNoGold = "dialog.no_money"
)

// routeOptionBase is added to a route's 1-based index to form its dialog option_id, so
// route options never collide with the node's own options (1..9).
const routeOptionBase = 100

// route is a boat route resolved against the map.
type route struct {
	def      *content.BoatRoute
	from, to world.Pos
	island   string // island of the arrival
}

// initTravel resolves the routes: each captain must be placed on the map at most
// content.MaxDockDistance from the dock, and the dock and the arrival must be walkable
// tiles of an island. A captain's node may not end up with more than 9 options.
func (w *World) initTravel() error {
	w.fightFor = ticksFor(w.cfg.Balance.Travel.CombatBlockMs)
	w.arrivalRadius = w.cfg.Balance.Travel.ArrivalRadius
	w.routes = map[string][]*route{}
	if len(w.cfg.BoatRoutes) == 0 {
		return nil
	}
	if err := w.cfg.BoatRoutes.Check(w.cfg.NPCs, w.cfg.Quests, w.cfg.Items); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	for _, r := range w.cfg.BoatRoutes {
		var captain *NPC
		for _, n := range w.npcs {
			if n.def.ID == r.Captain {
				captain = n
			}
		}
		from, okFrom := worldPos(r.From)
		to, okTo := worldPos(r.To)
		switch {
		case captain == nil:
			return fmt.Errorf("session: boat route %q: captain %q is not placed on the map", r.ID, r.Captain)
		case !okFrom || !w.m.Walkable(from):
			return fmt.Errorf("session: boat route %q: the dock is not a walkable tile", r.ID)
		case captain.pos.Z != from.Z || chebyshev(captain.pos, from) > content.MaxDockDistance:
			return fmt.Errorf("session: boat route %q: captain %q stands more than %d tiles from the dock", r.ID, r.Captain, content.MaxDockDistance)
		case !okTo || !w.m.Walkable(to):
			return fmt.Errorf("session: boat route %q: the arrival is not a walkable tile", r.ID)
		}
		rt := &route{def: r, from: from, to: to, island: w.islandAt(to)}
		if rt.island == "" {
			return fmt.Errorf("session: boat route %q: the arrival is outside every island", r.ID)
		}
		w.routes[r.Captain] = append(w.routes[r.Captain], rt)
	}
	for _, r := range w.cfg.BoatRoutes { // file order, so the reported error is stable
		rs := w.routes[r.Captain]
		def := w.cfg.NPCs[r.Captain]
		for _, id := range sortedKeys(def.Dialog.Nodes) {
			if n := def.Dialog.Nodes[id]; n.BoatRoutes && len(rs)+len(n.Options) > 9 {
				return fmt.Errorf("session: npc %q node %q: %d routes and %d options are more than 9", r.Captain, id, len(rs), len(n.Options))
			}
		}
	}
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func worldPos(p content.Position) (world.Pos, bool) {
	if p.X < 0 || p.Y < 0 || p.X > 0xFFFF || p.Y > 0xFFFF || p.Z < 0 || p.Z > world.MaxFloor {
		return world.Pos{}, false
	}
	return world.Pos{X: uint16(p.X), Y: uint16(p.Y), Z: uint8(p.Z)}, true
}

// checkArrivals refuses an arrival that would put a player where nobody may be put
// (docs/03 "Validación"; make validate refuses the same, packages/map-format
// validate.ts checkArrivals, with the cases of testdata/arrivals.json): a boat arrival
// or the destination of a dialog teleport on a house tile (an arrival puts nobody inside
// a house: the search would skip the house, but the destination itself is wrong) or on a
// locked door placed open (a door is no place to land: the destination would be its
// doorway, and the search could only put the player on its outside). A dialog teleport
// must also lead to a walkable tile of an island, as a boat arrival must (initTravel).
// world.NewMap refuses the same for the ends of portals. New runs it after initDoors,
// which finds the locked doors.
func (w *World) checkArrivals() error {
	for _, r := range w.cfg.BoatRoutes {
		if to, ok := worldPos(r.To); ok {
			if why := w.badArrival(to); why != "" {
				return fmt.Errorf("session: boat route %q arrives on %v (island %q), %s", r.ID, to, w.islandAt(to), why)
			}
		}
	}
	for _, id := range sortedKeys(w.cfg.NPCs) {
		nodes := w.cfg.NPCs[id].Dialog.Nodes
		for _, node := range sortedKeys(nodes) {
			for _, o := range nodes[node].Options {
				for _, a := range o.Action {
					if a.Teleport == nil {
						continue
					}
					to, ok := worldPos(*a.Teleport)
					if !ok || w.islandAt(to) == "" || !w.m.Walkable(to) {
						t := a.Teleport
						return fmt.Errorf("session: npc %q node %q teleports to %d,%d,%d: not a walkable tile of an island", id, node, t.X, t.Y, t.Z)
					}
					if why := w.badArrival(to); why != "" {
						return fmt.Errorf("session: npc %q node %q teleports to %v (island %q), %s", id, node, to, w.islandAt(to), why)
					}
				}
			}
		}
	}
	return nil
}

// badArrival says why nobody may arrive on the walkable tile p (checkArrivals), or "".
func (w *World) badArrival(p world.Pos) string {
	if h := w.m.HouseAt(p); h != nil {
		return fmt.Sprintf("in house %q: an arrival puts nobody inside a house", h.ID)
	}
	if w.lockedDoor(p) {
		return "on a locked door: a door is no place to land"
	}
	return ""
}

// routeOptions returns the dialog options of the routes n sells (all of them: a route
// whose requirements fail is refused with the reason when picked).
func (w *World) routeOptions(n *NPC) []*pb.DialogOption {
	rs := w.routes[n.def.ID]
	out := make([]*pb.DialogOption, 0, len(rs))
	for i, r := range rs {
		out = append(out, &pb.DialogOption{OptionId: uint32(routeOptionBase + i + 1), Text: &pb.LocalizedText{Key: r.def.Text}})
	}
	return out
}

// pickedRoute returns the route of optionID in d's node, or nil.
func (w *World) pickedRoute(d *openDialog, optionID uint32) *route {
	node := d.npc.def.Dialog.Nodes[d.node]
	rs := w.routes[d.npc.def.ID]
	if node == nil || !node.BoatRoutes || optionID <= routeOptionBase || int(optionID-routeOptionBase) > len(rs) {
		return nil
	}
	return rs[optionID-routeOptionBase-1]
}

// markFight records that p is in combat now (attacked, hurt or hitting a monster).
func (w *World) markFight(ctx *game.TickContext, p *Player) {
	if p != nil {
		p.fightAt = max(ctx.Tick, 1)
	}
}

// inCombat reports whether p fought within balance travel.combat_block_ms, or its PvP
// lock lasts (T5.2: no sailing, idle kick or presence check in the middle of a fight).
func (w *World) inCombat(now game.Tick, p *Player) bool {
	return p.fightAt > 0 && now-p.fightAt < w.fightFor || w.pvpLocked(now, p)
}

// sail runs a route for p, who is talking to its captain (talk range was checked).
// Everything is checked before anything changes: combat, requirements, money and a free
// arrival tile. Then p moves (Teleport updates the observers at both ends), the ticket
// is taken and the price paid, so any change falls at the arrival.
func (w *World) sail(ctx *game.TickContext, p *Player, r *route) {
	if w.byClient[p.client] != p {
		return // not in the world (Teleport would do nothing): charge nothing
	}
	req := r.def.Requires
	var ticket *content.Item
	if req.Item != nil {
		ticket = w.cfg.Items[req.Item.Item]
	}
	switch {
	case w.inCombat(ctx.Tick, p):
		p.emit(systemMsg(msgInCombat))
		return
	case p.level < req.Level:
		p.emit(systemMsg(msgNeedLevel, num("level", req.Level)))
		return
	case req.Quest != "":
		if s, _ := w.QuestState(p, req.Quest); s != quest.Completed {
			p.emit(systemMsg(msgNeedQuest, &pb.TextParam{Name: "quest", Value: &pb.TextParam_ContentId{ContentId: req.Quest}}))
			return
		}
	}
	if ticket != nil && w.countItem(p, ticket, true) < req.Item.N() {
		p.emit(systemMsg(msgNeedItem, itemParam(ticket, req.Item.N())))
		return
	}
	if w.money(p) < r.def.Price {
		p.emit(systemMsg(msgTravelNoGold))
		return
	}
	if !w.canPay(p, r.def.Price) {
		p.emit(systemMsg(dialog.MsgNoChangeRoom))
		return
	}
	to, ok := w.freeAround(r.to, w.arrivalRadius, true) // never into a house, like a portal
	if !ok {
		p.emit(systemMsg(msgArrivalFull))
		return
	}
	w.closeDialog(p)
	w.Teleport(p, to)
	if ticket != nil && req.Item.Consume {
		w.takeItem(p, ticket, req.Item.N(), true)
		w.econItem(p, EconTravel, r.def.ID, ticket, -req.Item.N())
		p.questDirty = true
	}
	if r.def.Price > 0 {
		w.pay(p, r.def.Price)
		w.econGold(p, EconTravel, r.def.ID, -r.def.Price)
		p.emit(systemMsg(msgPaid, num("amount", int(r.def.Price))))
		p.questDirty = true
	}
	w.log.Info("economy: boat travel", "character", p.charID, "route", r.def.ID, "amount", r.def.Price)
	p.emit(systemMsg(msgSailed, &pb.TextParam{Name: "island", Value: &pb.TextParam_ContentId{ContentId: r.island}}))
}
