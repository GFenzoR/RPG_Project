package session

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Gathering (T1.12): a tool used on a tile whose ground or stack item has a resource
// block for that tool (fishing rod on water with fish, pickaxe on a vein). Every attempt
// trains the resource's skill; the chance grows with it. A tile runs out after its
// charges and refills regen_ms after its last harvest, through one scheduler event per
// tile: only harvested tiles hold state and nothing walks the map
// (docs/02-game-design.md, "Oficios").

// Effect ids added by T1.12 (protocol constants until data/effects.yaml).
const (
	// EffectGather: a harvest succeeded on the tile.
	EffectGather = 5
	// EffectGatherMiss: an attempt got nothing (the tile is still there).
	EffectGatherMiss = 6
)

// i18n keys of the gathering messages (i18n/*/client.yaml).
const (
	msgGatherNothing  = "gather.nothing"
	msgGatherDepleted = "gather.depleted"
	msgGatherFailed   = "gather.failed"
	msgGatherGot      = "gather.got"
	msgGatherNotReady = "gather.not_ready"
)

// resourceTile is a harvested tile: the charges it has left and its refill event.
type resourceTile struct {
	left   int
	refill game.EventID
}

// initGathering reads balance.yaml gathering and checks every resource block against
// the items and skills.
func (w *World) initGathering() error {
	g := w.cfg.Balance.Gathering
	w.gatherFor = ticksFor(max(g.UseIntervalMs, 1))
	if g.AFK.AfterMs > 0 {
		w.gatherAFKAfter = ticksFor(g.AFK.AfterMs)
	}
	w.resources = map[world.Pos]*resourceTile{}
	for _, it := range w.cfg.Items {
		r := it.Resource
		if r == nil {
			continue
		}
		if err := r.Check(w.cfg.Items); err != nil {
			return fmt.Errorf("session: item %q: %w", it.ID, err)
		}
		if _, ok := w.skillIdx[r.Skill]; !ok {
			return fmt.Errorf("session: item %q: resource skill %q is not in balance.yaml", it.ID, r.Skill)
		}
	}
	return nil
}

// resourceAt returns the topmost map item of pos with a resource block (stack from the
// top, then the ground), or nil.
func (w *World) resourceAt(pos world.Pos) *content.Item {
	stack := w.m.Stack(pos)
	for i := len(stack) - 1; i >= 0; i-- {
		if def := w.byNum[stack[i]]; def != nil && def.Resource != nil {
			return def
		}
	}
	if g, _, ok := w.m.Tile(pos); ok {
		if def := w.byNum[g]; def != nil && def.Resource != nil {
			return def
		}
	}
	return nil
}

// gather runs a UseItemOn of a tool p carries on a tile.
func (w *World) gather(ctx *game.TickContext, p *Player, tool *Item, target *pb.ActionTarget) {
	tp, ok := target.GetTarget().(*pb.ActionTarget_Pos)
	if !ok {
		p.emit(systemMsg(msgCannotUse))
		return
	}
	pos, ok := posFromMsg(tp.Pos)
	if !ok {
		p.emit(systemMsg(msgNotPossible))
		return
	}
	def := w.resourceAt(pos)
	if def == nil && pos.Z == p.pos.Z && w.near(p, pos) {
		// A tool used on a crafting station (a hammer on the anvil) opens it (T3.4).
		for i := w.staticCount(pos) - 1; i >= 0; i-- {
			if id := w.staticAt(pos, i); w.stations[id] != nil {
				w.sendStation(p, pos, id)
				return
			}
		}
	}
	if def == nil || def.Resource.Tool != tool.def.Tool.Use {
		p.emit(systemMsg(msgGatherNothing))
		return
	}
	res := def.Resource
	reach := res.Reach
	if reach == 0 {
		reach = w.reach
	}
	if pos.Z != p.pos.Z || chebyshev(p.pos, pos) > reach {
		p.emit(systemMsg(msgTooFar))
		return
	}
	if !w.m.LineOfSight(p.pos, pos) {
		p.emit(systemMsg(msgNoSight))
		return
	}
	if ctx.Tick < p.nextGather {
		p.emit(systemMsg(msgGatherNotReady))
		return
	}
	p.nextGather = ctx.Tick + w.gatherFor
	rt := w.resources[pos]
	if rt != nil && rt.left == 0 {
		p.emit(systemMsg(msgGatherDepleted))
		return
	}

	// The chance uses the level before this attempt's try.
	level := w.skillLevel(p, res.Skill)
	chance := res.SuccessChance(level, w.cfg.Balance.Skills.Base[res.Skill].StartLevel)
	factor := 1.0
	if w.gatherAFK(ctx, p) {
		factor = w.cfg.Balance.Gathering.AFK.Factor
	}
	w.trainBy(p, res.Skill, factor)
	drop := pickDrop(ctx, res, level)
	if drop == nil || ctx.Rand.Float64() >= chance {
		w.gatherEffect(pos, EffectGatherMiss)
		p.emit(systemMsg(msgGatherFailed))
		return
	}

	if rt == nil {
		rt = &resourceTile{left: res.Charges}
		w.resources[pos] = rt
	}
	rt.left--
	ctx.Sched.Cancel(rt.refill)
	rt.refill = ctx.Sched.After(ticksFor(res.RegenMs), func(*game.TickContext) {
		if w.resources[pos] == rt {
			delete(w.resources, pos)
		}
	})
	lo, hi := drop.CountRange()
	n := lo + ctx.Rand.IntN(hi-lo+1)
	item := w.cfg.Items[drop.Item]
	w.gatherEffect(pos, EffectGather)
	p.emit(systemMsg(msgGatherGot, itemParam(item, n)))
	w.giveItem(p, item, n)
}

// pickDrop picks one of res's drops by weight among those level reaches (nil if none).
func pickDrop(ctx *game.TickContext, res *content.Resource, level int) *content.ResourceDrop {
	total := 0
	for _, d := range res.Drops {
		if level >= d.MinLevel {
			total += d.Weight
		}
	}
	if total == 0 {
		return nil
	}
	r := ctx.Rand.IntN(total)
	for i := range res.Drops {
		d := &res.Drops[i]
		if level < d.MinLevel {
			continue
		}
		if r < d.Weight {
			return d
		}
		r -= d.Weight
	}
	return nil
}

// gatherAFK reports whether p's gathering earns reduced tries: it has kept gathering
// from the same tile for gathering.afk.after_ms. A step, or a pause longer than two
// use intervals, starts the count again.
func (w *World) gatherAFK(ctx *game.TickContext, p *Player) bool {
	if p.gatherSince == 0 || p.gatherPos != p.pos || ctx.Tick-p.gatherLast > 2*w.gatherFor {
		p.gatherPos, p.gatherSince = p.pos, max(ctx.Tick, 1)
	}
	p.gatherLast = ctx.Tick
	return w.gatherAFKAfter > 0 && ctx.Tick-p.gatherSince >= w.gatherAFKAfter
}

func (w *World) gatherEffect(pos world.Pos, id uint32) {
	msg := &pb.ServerMessage{Message: &pb.ServerMessage_Effect{Effect: &pb.Effect{Pos: posMsg(pos), EffectId: id}}}
	w.eachObserver(nil, pos, func(o *Player) { o.emit(msg) })
}

// ResourceLeft returns the charges left on a tile's resource (tests): -1 when the tile
// is untouched (full).
func (w *World) ResourceLeft(pos world.Pos) int {
	if rt := w.resources[pos]; rt != nil {
		return rt.left
	}
	return -1
}
