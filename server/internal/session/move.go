package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Input returns the command that applies one client message to client's player. The
// gateway has already checked the message's shape and rate; everything that depends on
// the game state is validated here.
func (w *World) Input(client Client, msg *pb.ClientMessage) game.Command {
	return game.CommandFunc(func(ctx *game.TickContext) {
		p := w.byClient[client]
		if p == nil {
			return
		}
		w.input(ctx, p, msg)
	})
}

func (w *World) input(ctx *game.TickContext, p *Player, msg *pb.ClientMessage) {
	switch m := msg.GetMessage().(type) {
	case *pb.ClientMessage_Walk:
		d, ok := dirFromMsg(m.Walk.GetDir())
		if !ok {
			return
		}
		// Keyboard walking: the new step replaces whatever was queued, and starts as soon
		// as the current step ends (the server, not the client, decides the pace).
		p.stopWalk()
		p.queue = append(p.queue, d)
	case *pb.ClientMessage_WalkPath:
		w.walkPath(p, m.WalkPath.GetSteps())
	case *pb.ClientMessage_StopWalk:
		p.stopWalk()
	case *pb.ClientMessage_Turn:
		d, ok := dirFromMsg(m.Turn.GetDir())
		if !ok {
			return
		}
		w.turn(p, d)
	case *pb.ClientMessage_SetTarget:
		w.setTarget(p, m.SetTarget.GetCreatureId())
	case *pb.ClientMessage_SetFightMode:
		w.setFightMode(p, m.SetFightMode.GetStance(), m.SetFightMode.GetChase())
	case *pb.ClientMessage_Ping:
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_Pong{Pong: &pb.Pong{
			ClientTime: m.Ping.GetClientTime(),
			ServerTime: uint64(max(ctx.Now.UnixMilli(), 0)),
		}}})
	case *pb.ClientMessage_MoveItem:
		w.moveItem(ctx, p, m.MoveItem)
	case *pb.ClientMessage_UseItem:
		w.useItem(ctx, p, m.UseItem)
	case *pb.ClientMessage_UseItemOn:
		w.useItemOn(ctx, p, m.UseItemOn)
	case *pb.ClientMessage_CastSpell:
		w.castSpell(ctx, p, m.CastSpell)
	case *pb.ClientMessage_Say:
		w.say(ctx, p, m.Say)
	case *pb.ClientMessage_LookAt:
		w.lookAt(p, m.LookAt)
	case *pb.ClientMessage_NpcTalk:
		w.npcTalk(p, m.NpcTalk.GetCreatureId())
	case *pb.ClientMessage_DialogChoose:
		w.dialogChoose(p, m.DialogChoose.GetDialogId(), m.DialogChoose.GetOptionId())
	case *pb.ClientMessage_ShopBuy:
		w.shopBuy(p, m.ShopBuy.GetDialogId(), m.ShopBuy.GetItemId(), m.ShopBuy.GetCount())
	case *pb.ClientMessage_ShopSell:
		w.shopSell(p, m.ShopSell.GetDialogId(), m.ShopSell.GetItemId(), m.ShopSell.GetCount())
	case *pb.ClientMessage_CloseContainer:
		w.closeContainer(p, m.CloseContainer.GetContainerId())
	case *pb.ClientMessage_Logout:
		// No-logout zones and the combat lock arrive with death and PvP rules (T1.11).
		w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT, false)
	default:
		// Hello after the handshake, and messages of later milestones: ignored.
	}
}

func (w *World) walkPath(p *Player, steps []pb.Direction) {
	p.stopWalk()
	if len(steps) == 0 {
		return
	}
	if len(steps) > w.mv.MaxPathTiles {
		w.reject(p, pb.Direction_DIRECTION_UNSPECIFIED)
		return
	}
	dest := p.pos
	for _, s := range steps {
		d, ok := dirFromMsg(s)
		if !ok {
			p.stopWalk()
			w.reject(p, pb.Direction_DIRECTION_UNSPECIFIED)
			return
		}
		next, ok := dest.Step(d)
		if !ok {
			p.stopWalk()
			w.reject(p, dirMsg(d))
			return
		}
		dest = next
		p.queue = append(p.queue, d)
	}
	p.dest, p.hasDest = dest, true
}

// reject tells the client its predicted walk failed and where the player really is. d
// is the refused step, or UNSPECIFIED when the whole request was invalid.
func (w *World) reject(p *Player, d pb.Direction) {
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_WalkRejected{WalkRejected: &pb.WalkRejected{
		Pos: posMsg(p.pos),
		Dir: d,
	}}})
}

func (w *World) turn(p *Player, d world.Direction) {
	if p.dir == d {
		return
	}
	p.dir = d
	msg := &pb.CreatureTurn{Id: p.id, Dir: dirMsg(d)}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureTurn{CreatureTurn: msg}})
	w.eachObserver(p, p.pos, func(o *Player) {
		if o.Knows(p.id) {
			o.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureTurn{CreatureTurn: &pb.CreatureTurn{Id: p.id, Dir: msg.Dir}}})
		}
	})
}

// StepTicks returns how many ticks a step onto ground costs at speed:
// base_step_ms × terrain% / speed, × diagonal_cost for diagonals, rounded up to whole
// ticks (at least one). CreatureMove.duration_ms is this many ticks.
func (w *World) StepTicks(ground uint16, speed int, diagonal bool) game.Tick {
	terrain := int64(world.DefaultGroundSpeed)
	if gs := w.m.GroundSpeeds(); int(ground) < len(gs) && gs[ground] != 0 {
		terrain = int64(gs[ground])
	}
	num := int64(w.mv.BaseStepMs) * terrain * 1000 // thousandths of a ms × speed
	if diagonal {
		num = num * w.diag / 1000
	}
	den := int64(max(speed, 1)) * 1000
	ms := (num + den - 1) / den
	tickMs := game.TickDuration.Milliseconds()
	return game.Tick(max((ms+tickMs-1)/tickMs, 1))
}

// moveSystem advances every walking player whose previous step has finished.
func (w *World) moveSystem(ctx *game.TickContext) {
	if w.pathTick != ctx.Tick {
		w.pathTick, w.pathBudget = ctx.Tick, w.cfg.PathNodesPerTick
	}
	for _, p := range w.players {
		if !p.Walking() || ctx.Tick < p.readyAt {
			continue
		}
		w.stepPlayer(ctx, p)
	}
}

func (w *World) stepPlayer(ctx *game.TickContext, p *Player) {
	d := p.queue[p.qhead]
	to, ok := p.pos.Step(d)
	if !ok || !w.m.Walkable(to) {
		p.stopWalk()
		w.reject(p, dirMsg(d))
		return
	}
	if w.occupied(to) {
		if p.hasDest && w.pathBudget < w.searchCost() {
			return // out of pathfinding quota this tick: try again on the next one
		}
		if !p.hasDest || !w.reroute(p) {
			p.stopWalk()
			w.reject(p, dirMsg(d))
			return
		}
		d = p.queue[p.qhead]
		to, _ = p.pos.Step(d) // the new path starts on a free walkable tile
	}
	p.qhead++
	if p.qhead == len(p.queue) {
		p.stopWalk()
	}
	ground, _, _ := w.m.Tile(to)
	ticks := w.StepTicks(ground, p.speed, d.Diagonal())
	p.readyAt = ctx.Tick + ticks
	w.move(p, to, d, ticks)
}

// searchCost is the worst case of one reroute search, in expanded tiles: Find may run
// two passes of RerouteMaxNodes.
func (w *World) searchCost() int { return 2 * w.cfg.RerouteMaxNodes }

// reroute replaces p's remaining path with one to p.dest around creatures and charges
// the search to the tick's pathfinding quota. It reports whether p has a new path.
func (w *World) reroute(p *Player) bool {
	path, ok := w.pf.FindAvoiding(p.pos, p.dest, w.pathBuf, w.occupied)
	w.pathBudget -= w.pf.Expanded()
	w.pathBuf = path[:0]
	if !ok || len(path) == 0 {
		return false
	}
	p.queue = append(p.queue[:0], path...)
	p.qhead = 0
	return true
}

// move takes p one step from its position to `to` (adjacent, same floor) and tells
// every client that sees either end.
func (w *World) move(p *Player, to world.Pos, d world.Direction, ticks game.Tick) {
	from := p.pos
	durMs := uint32(ticks.Duration().Milliseconds())
	w.unindex(p)
	p.pos, p.dir = to, d
	w.index(p)

	mv := &pb.CreatureMove{Id: p.id, From: posMsg(from), To: posMsg(to), DurationMs: durMs}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureMove{CreatureMove: mv}})

	// Other clients: those around either end of the step.
	w.observeMove(p, nil, from, to, mv.From, mv.To, durMs)
	w.checkContainers(p)
	w.checkDialog(p)

	// The mover's own client: creatures out of view disappear, the new edge arrives.
	kept := p.known[:0]
	for _, id := range p.known {
		if c, ok := w.creaturePos(id); !ok || id == p.id || Sees(to, c) {
			if ok {
				kept = append(kept, id)
			}
			continue
		}
		p.emit(disappearMsg(id))
	}
	p.known = kept

	dx, dy := d.Delta()
	if dx != 0 { // new column, full height
		x := int(to.X) + dx*ViewHalfW
		w.sendSlice(p, x, int(to.Y)-ViewHalfH, 1, ViewH)
	}
	if dy != 0 { // new row; on a diagonal without the corner the column already has
		x0, wd := int(to.X)-ViewHalfW, ViewW
		if dx > 0 {
			wd--
		} else if dx < 0 {
			x0++
			wd--
		}
		w.sendSlice(p, x0, int(to.Y)+dy*ViewHalfH, wd, 1)
	}
}

// Teleport moves p anywhere (another floor included). Loop goroutine only. It does not
// check the destination: callers (stairs, spells, GM commands) must pass a walkable,
// free tile.
func (w *World) Teleport(p *Player, to world.Pos) {
	if w.byClient[p.client] != p {
		return
	}
	p.stopWalk()
	w.disappearFromObservers(p)
	w.unindex(p)
	p.pos = to
	w.index(p)
	w.checkContainers(p)
	w.checkDialog(p)
	w.sendFullView(p)
	w.appearToObservers(p)
}

// playerByID returns the online player with creature id, or nil.
func (w *World) playerByID(id uint32) *Player {
	lo, hi := 0, len(w.players)
	for lo < hi {
		mid := (lo + hi) / 2
		if w.players[mid].id < id {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(w.players) && w.players[lo].id == id {
		return w.players[lo]
	}
	return nil
}

// ---- flush ------------------------------------------------------------------------

// flushSystem sends every player its batch for this tick (one frame at most, none when
// there is nothing to say) and retries snapshots that persistence could not take.
func (w *World) flushSystem(ctx *game.TickContext) {
	w.retrySaves()
	if len(w.adminRetry) > 0 {
		w.retryAdmin()
	}
	w.slow = w.slow[:0]
	for _, p := range w.players {
		w.questRecheck(p)
		if !w.flushPlayer(ctx.Tick, p) {
			w.slow = append(w.slow, p)
		}
	}
	for _, p := range w.slow {
		w.log.Warn("session: slow client dropped", "character", p.charID, "creature", p.id)
		w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_SLOW_CLIENT, true)
	}
	// Removing slow players may have queued CreatureDisappear for others: they go out
	// with the next tick's batch.
}

func (w *World) flushPlayer(tick game.Tick, p *Player) bool {
	if len(p.out) == 0 {
		return true
	}
	b := &pb.ServerBatch{Tick: uint64(tick), Events: p.out}
	p.out = make([]*pb.ServerMessage, 0, cap(p.out)) // the batch now belongs to the client
	return p.client.Send(b)
}
