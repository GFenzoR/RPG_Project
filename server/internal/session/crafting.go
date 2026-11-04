package session

import (
	"fmt"
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Crafting (T3.4): a recipe of data/recipes.yaml turns inputs from the player's
// containers into an output at a station item of the map (anvil, forge, stove...).
// Using a station within reach answers StationOpen; Craft is validated in full every
// time (docs/02-game-design.md, "Oficios"). An attempt shares the gathering rate limit
// and anti-AFK count: one trade action at a time.

// i18n keys of the crafting messages (i18n/*/client.yaml).
const (
	msgCraftDone      = "craft.done"
	msgCraftFailed    = "craft.failed"
	msgCraftNoStation = "craft.no_station"
	msgCraftLevel     = "craft.level"
	msgCraftNoTool    = "craft.no_tool"
	msgCraftMissing   = "craft.missing"
	msgCraftNoRoom    = "craft.no_room"
	msgCraftNotReady  = "craft.not_ready"
)

// initCrafting checks the recipes against the items and skills and indexes the station
// items.
func (w *World) initCrafting() error {
	if err := w.cfg.Recipes.Check(w.cfg.Items); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	w.stations = map[uint16][]*content.Item{}
	for _, id := range w.cfg.Recipes.IDs() {
		r := w.cfg.Recipes[id]
		if _, ok := w.skillIdx[r.Craft]; !ok {
			return fmt.Errorf("session: recipe %q: craft %q is not a skill of balance.yaml", id, r.Craft)
		}
		n := w.cfg.Items[r.Station].Numeric
		if w.stations[n] == nil {
			w.stations[n] = []*content.Item{}
		}
		for _, in := range r.Inputs {
			def := w.cfg.Items[in.Item]
			if !slices.Contains(w.stations[n], def) {
				w.stations[n] = append(w.stations[n], def)
			}
		}
	}
	return nil
}

// staticAt returns the numeric id of the map's own item at stack index i of pos
// (0 = ground), or 0.
func (w *World) staticAt(pos world.Pos, i int) uint16 {
	if i == 0 {
		g, _, _ := w.m.Tile(pos)
		return g
	}
	if stack := w.m.Stack(pos); i-1 < len(stack) {
		return stack[i-1]
	}
	return 0
}

// useStation answers a UseItem on a static map item: StationOpen if it is a crafting
// station within reach. It reports whether the UseItem was about a static item.
func (w *World) useStation(p *Player, m *pb.UseItem) bool {
	pos, ok := posFromMsg(m.GetFrom().GetPos())
	if !ok || int(m.GetStackIndex()) >= w.staticCount(pos) {
		return false
	}
	id := w.staticAt(pos, int(m.GetStackIndex()))
	switch {
	case id == 0 || uint32(id) != m.GetItemId():
		p.emit(systemMsg(msgNotPossible))
	case w.stations[id] == nil:
		p.emit(systemMsg(msgCannotUse))
	case !w.near(p, pos):
		p.emit(systemMsg(msgTooFar))
	default:
		w.sendStation(p, pos, id)
	}
	return true
}

// sendStation tells p what it carries for the recipes of the station item id at pos.
func (w *World) sendStation(p *Player, pos world.Pos, id uint16) {
	m := &pb.StationOpen{Pos: posMsg(pos), ItemId: uint32(id)}
	for _, def := range w.stations[id] {
		if n := w.countItem(p, def, false); n > 0 {
			m.Owned = append(m.Owned, &pb.ItemStack{ItemId: uint32(def.Numeric), Count: uint32(n)})
		}
	}
	p.eachCarried(true, func(it *Item) {
		if t := it.def.Tool; t != nil && !slices.Contains(m.Tools, t.Use) {
			m.Tools = append(m.Tools, t.Use)
		}
	})
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_StationOpen{StationOpen: m}})
}

// hasStation reports whether the map's own stack of pos holds the station item def.
func (w *World) hasStation(pos world.Pos, def *content.Item) bool {
	for _, n := range w.m.Stack(pos) {
		if n == def.Numeric {
			return true
		}
	}
	g, _, _ := w.m.Tile(pos)
	return g == def.Numeric
}

// carriesTool reports whether p carries (equipped or in a container) an item whose
// tool.use is use.
func (w *World) carriesTool(p *Player, use string) bool {
	found := false
	p.eachCarried(true, func(it *Item) {
		if t := it.def.Tool; t != nil && t.Use == use {
			found = true
		}
	})
	return found
}

// craft runs a Craft intent. Every check comes before anything changes, so the inputs
// are taken all at once or not at all; a failed attempt also spends them.
func (w *World) craft(ctx *game.TickContext, p *Player, m *pb.Craft) {
	r := w.cfg.Recipes[m.GetRecipeId()]
	pos, ok := posFromMsg(m.GetStation())
	if r == nil || !ok {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	station := w.cfg.Items[r.Station]
	if !w.hasStation(pos, station) {
		p.emit(systemMsg(msgCraftNoStation, itemParam(station, 1)))
		return
	}
	if !w.near(p, pos) {
		p.emit(systemMsg(msgTooFar))
		return
	}
	level := w.skillLevel(p, r.Craft)
	if level < r.Level {
		p.emit(systemMsg(msgCraftLevel,
			&pb.TextParam{Name: "skill", Value: &pb.TextParam_ContentId{ContentId: r.Craft}}, num("level", r.Level)))
		return
	}
	if r.Tool != "" && !w.carriesTool(p, r.Tool) {
		p.emit(systemMsg(msgCraftNoTool))
		return
	}
	freed := 0
	for _, in := range r.Inputs {
		def := w.cfg.Items[in.Item]
		if have := w.countItem(p, def, false); have < in.Count {
			p.emit(systemMsg(msgCraftMissing, itemParam(def, in.Count-have)))
			return
		}
		freed += def.Weight * in.Count
	}
	// Room is checked as if the inputs freed no backpack slot (they may be in another
	// container); their weight does count.
	out := w.cfg.Items[r.Output.Item]
	if out.Weight*r.Output.Count > p.capacity-p.carried()+freed || !w.room(p, out, r.Output.Count, 0) {
		p.emit(systemMsg(msgCraftNoRoom))
		return
	}
	if ctx.Tick < p.nextGather {
		p.emit(systemMsg(msgCraftNotReady))
		return
	}
	p.nextGather = ctx.Tick + max(w.gatherFor, ticksFor(r.TimeMs))

	chance := r.SuccessChance(level) // with the level before this attempt's tries
	factor := 1.0
	if w.gatherAFK(ctx, p) {
		factor = w.cfg.Balance.Gathering.AFK.Factor
	}
	if factor >= 1 {
		if i, ok := w.skillIdx[r.Craft]; ok && r.XP > 0 {
			w.addTries(p, i, int64(r.XP))
		}
	} else {
		for range r.XP {
			w.trainBy(p, r.Craft, factor)
		}
	}
	for _, in := range r.Inputs {
		w.takeItem(p, w.cfg.Items[in.Item], in.Count, false)
	}
	if ctx.Rand.Float64() >= chance {
		w.gatherEffect(pos, EffectGatherMiss)
		p.emit(systemMsg(msgCraftFailed))
	} else {
		w.gatherEffect(pos, EffectGather)
		p.emit(systemMsg(msgCraftDone, itemParam(out, r.Output.Count)))
		w.giveItem(p, out, r.Output.Count)
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
	w.sendStation(p, pos, station.Numeric)
}
