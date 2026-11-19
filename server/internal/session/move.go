package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
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
		if p == nil || p.linkDead {
			return // gone, or link-dead: a command its closed connection sent before
		}
		w.playerCommand(p, func() { w.input(ctx, p, msg) })
	})
}

// playerCommand runs run, one command of p that may change a house's items.
func (w *World) playerCommand(p *Player, run func()) {
	// T5.3: a give-away still waiting for its snapshot (one the server made in a command
	// that is not an Input, as a Join's tutorial reward, or in one that panicked) takes
	// it now, before this command changes a house: that snapshot never holds what this
	// command takes out of a house (hold.go settleGivers).
	w.settleGivers()
	w.cmdPlayer = p // T5.4: whose command changes a house's items (flushHouses)
	defer func() { w.cmdPlayer = nil }()
	run()
	// T5.4: what this command did to a house is written now, with p's snapshot: a
	// later command never adds a half-done operation to that batch.
	w.flushHouses()
	// T5.3: the state after what this command gave away, whole (hold.go gaveAway).
	w.settleGivers()
}

func (w *World) input(ctx *game.TickContext, p *Player, msg *pb.ClientMessage) {
	switch m := msg.GetMessage().(type) {
	case *pb.ClientMessage_Walk:
		d, ok := dirFromMsg(m.Walk.GetDir())
		if !ok {
			return
		}
		w.walk(p, d, m.Walk.GetWalkEpoch(), m.Walk.GetSeq())
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
		w.setTarget(ctx, p, m.SetTarget.GetCreatureId())
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
	case *pb.ClientMessage_Craft:
		w.craft(ctx, p, m.Craft)
	case *pb.ClientMessage_Refine:
		w.refine(ctx, p, m.Refine)
	case *pb.ClientMessage_UseItemOn:
		w.useItemOn(ctx, p, m.UseItemOn)
	case *pb.ClientMessage_CastSpell:
		w.castSpell(ctx, p, m.CastSpell)
	case *pb.ClientMessage_Say:
		w.say(ctx, p, m.Say)
	case *pb.ClientMessage_LookAt:
		if id := m.LookAt.GetCreatureId(); id != 0 {
			w.lookCreature(p, id)
			return
		}
		w.lookAt(p, m.LookAt)
		if pos, ok := posFromMsg(m.LookAt.GetFrom().GetPos()); ok && pos.Z == p.pos.Z && Sees(p.pos, pos) {
			w.lookHouse(p, pos) // T5.4: whose house a door belongs to
		}
	case *pb.ClientMessage_NpcTalk:
		w.npcTalk(p, m.NpcTalk.GetCreatureId())
	case *pb.ClientMessage_DialogChoose:
		w.dialogChoose(ctx, p, m.DialogChoose.GetDialogId(), m.DialogChoose.GetOptionId())
	case *pb.ClientMessage_ShopBuy:
		w.shopBuy(p, m.ShopBuy.GetDialogId(), m.ShopBuy.GetItemId(), m.ShopBuy.GetCount())
	case *pb.ClientMessage_ShopSell:
		w.shopSell(p, m.ShopSell.GetDialogId(), m.ShopSell.GetItemId(), m.ShopSell.GetCount())
	case *pb.ClientMessage_PartyCommand:
		w.partyCommand(ctx, p, m.PartyCommand)
	case *pb.ClientMessage_GuildCommand:
		w.guildCommand(ctx, p, m.GuildCommand)
	case *pb.ClientMessage_CloseContainer:
		w.closeContainer(p, m.CloseContainer.GetContainerId())
	case *pb.ClientMessage_PresenceAnswer:
		w.presenceAnswer(ctx, p, m.PresenceAnswer.GetCheckId(), m.PresenceAnswer.GetOptionId())
	case *pb.ClientMessage_ReportPlayer:
		w.reportPlayer(ctx, p, m.ReportPlayer.GetCreatureId(), m.ReportPlayer.GetReason())
	case *pb.ClientMessage_TutorialSkip:
		w.tutorialSkip(p)
	case *pb.ClientMessage_SetSafeMode:
		w.setSafeMode(p, m.SetSafeMode.GetEnabled())
	case *pb.ClientMessage_TradeRequest:
		w.tradeRequest(ctx, p, m.TradeRequest)
	case *pb.ClientMessage_TradeOffer:
		w.tradeOffer(ctx, p, m.TradeOffer)
	case *pb.ClientMessage_TradeAccept:
		w.tradeAccept(ctx, p)
	case *pb.ClientMessage_TradeCancel:
		w.tradeCancel(p)
	case *pb.ClientMessage_MarketCommand:
		w.marketCommand(ctx, p, m.MarketCommand)
	case *pb.ClientMessage_HouseCommand:
		w.houseCommand(ctx, p, m.HouseCommand)
	case *pb.ClientMessage_EquipCosmetic:
		w.equipCosmetic(ctx, p, m.EquipCosmetic.GetCosmeticId())
	case *pb.ClientMessage_UnequipCosmetic:
		w.unequipCosmetic(ctx, p, m.UnequipCosmetic.GetKind())
	case *pb.ClientMessage_Logout:
		// No logout in the middle of a fight (linkdead.go): the PvP lock (T5.2) or
		// travel.combat_block_ms since p fought a monster or took damage. Closing the
		// connection leaves the character link-dead until the fight is over (docs/02
		// "Bloqueo de logout en combate").
		if key := w.logoutBlock(ctx.Tick, p); key != "" {
			p.emit(systemMsg(key))
			return
		}
		w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT, false)
	default:
		// Hello after the handshake, and messages of later milestones: ignored.
	}
}

// walk queues one keyboard step (docs/05 "Caminar"). The client predicts a few steps
// ahead and sends each one before the step it draws ends, so a held key walks with no
// stop between tiles: the step waits here until the one before ends (the server, not the
// client, decides the pace). It goes after the keyboard steps already queued; a path or a
// chase step is dropped. A Walk of another epoch was sent before the client heard of the
// last reset and was already forgotten there: it is dropped without an answer. A step
// over max_queued_steps (more than an honest client predicts) resets the walk. seq is
// only carried back in the step's CreatureMove (walk_seq): the server decides nothing
// with it.
func (w *World) walk(p *Player, d world.Direction, epoch, seq uint32) {
	if epoch != 0 && epoch != p.walkEpoch {
		return
	}
	if !p.keyWalk {
		p.stopWalk()
	}
	if p.queued() >= w.mv.MaxQueuedSteps {
		// No step of the client's is refused: the client must not take this direction
		// for a blocked one (WalkRejected.dir would make it keep off that step).
		w.reject(p, pb.Direction_DIRECTION_UNSPECIFIED)
		return
	}
	if p.qhead > 0 {
		// A held key may never let the queue empty: drop the steps taken (at most
		// MaxQueuedSteps left to move) so it does not grow for as long as the key is held.
		n := copy(p.queue, p.queue[p.qhead:])
		copy(p.qseq, p.qseq[p.qhead:])
		p.queue, p.qseq, p.qhead = p.queue[:n], p.qseq[:n], 0
	}
	p.queue = append(p.queue, d)
	p.qseq = append(p.qseq, seq)
	p.keyWalk = true
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
			w.reject(p, pb.Direction_DIRECTION_UNSPECIFIED)
			return
		}
		next, ok := dest.Step(d)
		if !ok {
			w.reject(p, dirMsg(d))
			return
		}
		dest = next
		p.queue = append(p.queue, d)
	}
	p.dest, p.hasDest = dest, true
}

// reject empties the step queue, starts a new walk epoch and tells the client its
// predicted walk failed and where the player really is. d is the refused step, or
// UNSPECIFIED when the whole request was invalid.
func (w *World) reject(p *Player, d pb.Direction) {
	p.resetWalk()
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_WalkRejected{WalkRejected: &pb.WalkRejected{
		Pos:       posMsg(p.pos),
		Dir:       d,
		WalkEpoch: p.walkEpoch,
	}}})
}

func (w *World) turn(p *Player, d world.Direction) {
	if p.dir == d {
		return
	}
	p.dir = d
	// One message for p and every observer that knows it, never changed after emit.
	msg := &pb.ServerMessage{Message: &pb.ServerMessage_CreatureTurn{CreatureTurn: &pb.CreatureTurn{Id: p.id, Dir: dirMsg(d)}}}
	p.emit(msg)
	w.eachObserver(p, p.pos, func(o *Player) {
		if o.Knows(p.id) {
			o.emit(msg)
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
		w.reject(p, dirMsg(d))
		return
	}
	if w.occupied(to) {
		if p.hasDest && w.pathBudget < w.searchCost() {
			return // out of pathfinding quota this tick: try again on the next one
		}
		if !p.hasDest || !w.reroute(p) {
			w.reject(p, dirMsg(d))
			return
		}
		d = p.queue[p.qhead]
		to, _ = p.pos.Step(d) // the new path starts on a free walkable tile
	}
	if !w.mayEnter(p, to) {
		// T5.4: a house door only lets its owner, guests and (if allowed) guild in.
		w.reject(p, dirMsg(d))
		p.emit(systemMsg(msgHouseNoAccess))
		return
	}
	if ctx.Tick < p.lockUntil && w.inProtection(to) && !w.inProtection(p.pos) {
		// T5.2: an attacker cannot hide in a protection zone while its PvP lock lasts.
		w.reject(p, dirMsg(d))
		p.emit(systemMsg(msgPvPProtLocked))
		return
	}
	// Stairs, a hole or a teleport (portal.go): the step happens only if the other end
	// takes p, and then p lands there.
	var dest world.Pos
	pt := w.stepPortal(to)
	if pt != nil {
		var refuse string
		if dest, refuse = w.portalArrival(ctx, p, pt, to); refuse != "" {
			w.reject(p, dirMsg(d))
			p.emit(systemMsg(refuse))
			return
		}
	}

	var seq uint32 // the Walk this step executes (keyboard steps only)
	if p.keyWalk && p.qhead < len(p.qseq) {
		seq = p.qseq[p.qhead]
	}
	p.qhead++
	if p.qhead == len(p.queue) {
		p.stopWalk()
	}
	ground, _, _ := w.m.Tile(to)
	ticks := w.StepTicks(ground, p.speed, d.Diagonal())
	p.readyAt = ctx.Tick + ticks
	w.move(p, to, d, ticks, pt != nil, seq)
	// A step resets the idle time but is not a timed action for the bot detection: its
	// pace is the server's (a held key walks as evenly as a script).
	p.lastAction, p.idleWarned = ctx.Tick, false
	w.abStep(ctx.Tick, p, d)
	if pt != nil {
		// relocate, not Teleport: p walks, so it is in the world, and the step skipped the
		// view of this floor (through): p must land, whatever Teleport would check.
		w.relocate(p, dest, goneTeleport)
	}
}

// searchCost is the worst case of one reroute search, in expanded tiles: Find may run
// two passes of RerouteMaxNodes.
func (w *World) searchCost() int { return 2 * w.cfg.RerouteMaxNodes }

// reroute replaces p's remaining path with one to p.dest around creatures (and around
// the tiles of stairs, holes and teleports but its end) and charges the search to the
// tick's pathfinding quota. It reports whether p has a new path.
func (w *World) reroute(p *Player) bool {
	dest := p.dest
	path, ok := w.pf.FindAvoiding(p.pos, dest, w.pathBuf, func(q world.Pos) bool {
		return w.occupied(q) || q != dest && w.m.MovesOnStep(q)
	})
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
// every client that sees either end. With through (a step onto stairs, a hole or a
// teleport, which Teleport follows in the same tick) p's own client gets only the step:
// the FullMapView of the other end replaces its view, so the edge of this floor and the
// creatures that leave it would be bytes it throws away. seq is the Walk.seq of a
// keyboard step (0 otherwise): only p's own CreatureMove carries it.
func (w *World) move(p *Player, to world.Pos, d world.Direction, ticks game.Tick, through bool, seq uint32) {
	from := p.pos
	durMs := uint32(ticks.Duration().Milliseconds())
	w.unindex(p)
	p.pos, p.dir = to, d
	w.index(p)

	mv := &pb.CreatureMove{Id: p.id, From: posMsg(from), To: posMsg(to), DurationMs: durMs, WalkSeq: seq}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_CreatureMove{CreatureMove: mv}})

	// Other clients: those around either end of the step.
	w.observeMove(p, nil, from, to, mv.From, mv.To, durMs)
	w.checkContainers(p)
	w.checkDialog(p)
	w.checkMarket(p)
	w.checkHouseView(p)
	if !through {
		w.stepView(p, to, d)
	}
	w.tutorialEvent(p, content.TriggerWalk, "")
}

// stepView tells p's own client what its step to `to` in d changed: creatures out of view
// disappear, the new edge arrives.
func (w *World) stepView(p *Player, to world.Pos, d world.Direction) {
	kept := p.known[:0]
	for _, id := range p.known {
		if c, ok := w.creaturePos(id); !ok || id == p.id || Sees(to, c) {
			if ok {
				kept = append(kept, id)
			}
			continue
		}
		p.emit(disappearMsg(id, goneOutOfView))
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
// check the destination: callers (portals, boats, GM commands) must pass a walkable,
// free tile. Landing on it does not trigger a portal there.
func (w *World) Teleport(p *Player, to world.Pos) {
	if w.byClient[p.client] != p {
		return
	}
	w.relocate(p, to, goneTeleport)
}

// relocate is Teleport for a player known to be in the world; the ones who saw it get
// why it left (a teleport, or a death that wakes it up at its temple). The walk starts a
// new epoch (sent with the FullMapView): a Walk on its way was meant for the old place.
func (w *World) relocate(p *Player, to world.Pos, why pb.DisappearReason) {
	p.resetWalk()
	w.disappearFromObservers(p, why)
	w.unindex(p)
	p.pos = to
	w.index(p)
	w.checkContainers(p)
	w.checkDialog(p)
	w.checkMarket(p)
	w.checkHouseView(p)
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
	if n := int32(len(w.retry)); n != w.publishedRetry.Load() {
		w.publishedRetry.Store(n)
	}
	if len(w.adminRetry) > 0 {
		w.retryAdmin()
	}
	w.checkRoles(ctx)
	w.flushParties(ctx.Tick)
	w.checkLinkDead(ctx) // the link-dead players whose fight is over leave
	w.checkPvP(ctx)      // T5.2: before the guilds, so an ended war is in this tick's update
	w.checkTrades(ctx)
	w.checkMarketExpiry(ctx)
	w.checkHouses(ctx) // T5.4: also flushes this tick's house item changes
	w.flushMarket(ctx) // after everything above that changes offers or mailboxes
	w.flushGuilds(ctx.Now)
	w.checkEconomy(ctx.Tick)
	w.checkIdle(ctx)
	w.checkAntiBot(ctx)
	w.flushMapNotices(ctx.Tick)
	w.pruneShopPending(ctx.Tick)
	w.flushEconomy(ctx)
	w.slow = w.slow[:0]
	for _, p := range w.players {
		w.questRecheck(p)
		w.sendConditions(p)
		if !w.flushPlayer(ctx.Tick, p) {
			w.slow = append(w.slow, p)
		}
	}
	// T5.4: what questRecheck put on a house floor (a reward that did not fit, after
	// checkHouses flushed) is written in this tick, not with whatever command comes next:
	// that command's player did not change the house.
	w.flushHouses()
	for _, p := range w.slow {
		w.log.Warn("session: slow client dropped", "character", p.charID, "creature", p.id)
		// In combat it stays link-dead (a full queue is no way out of a fight, linkdead.go).
		w.disconnect(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_SLOW_CLIENT, true)
	}
	// T5.3: what the server gave away for players outside their commands this tick (a
	// quest reward of a kill, a gift of questRecheck above), now that their state is whole.
	w.settleGivers()
	// Removing slow players may have queued CreatureDisappear for others: they go out
	// with the next tick's batch.
}

func (w *World) flushPlayer(tick game.Tick, p *Player) bool {
	if len(p.out) == 0 {
		return true
	}
	if p.linkDead {
		clear(p.out)
		p.out = p.out[:0] // no connection: nobody to tell (linkdead.go)
		return true
	}
	b := &pb.ServerBatch{Tick: uint64(tick), Events: p.out}
	p.out = make([]*pb.ServerMessage, 0, cap(p.out)) // the batch now belongs to the client
	return p.client.Send(b)
}
