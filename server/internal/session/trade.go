package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Trade window (T5.3, docs/02-game-design.md "Economía"). Two adjacent players each
// offer items from their containers (tradeable, a whole stack or an empty container, up
// to trade.max_items); both confirm, and the loop swaps the instances in one tick (no
// copy: an item is never in two places). Any change to an offer, or a step of either
// player, clears both confirmations. Walking away, dying, a PvP fight, leaving the world
// or a staff role cancels it. The swap leaves as one Transfer with both snapshots, so a
// crash either keeps the trade on both sides or on neither.

// i18n keys of the trade messages and cancel reasons (i18n/*/client.yaml).
const (
	msgTradeOff       = "trade.unavailable"
	msgTradeBusy      = "trade.busy"
	msgTradeTooFar    = "trade.too_far"
	msgTradeBadItem   = "trade.bad_item"
	msgTradeFull      = "trade.offer_full"
	msgTradeStaff     = "trade.staff"
	msgTradeCombat    = "trade.combat"
	msgTradeCompleted = "trade.completed"

	tradeCancelFar      = "trade.cancel.too_far"
	tradeCancelDied     = "trade.cancel.died"
	tradeCancelCombat   = "trade.cancel.combat"
	tradeCancelLeft     = "trade.cancel.left"
	tradeCancelExpired  = "trade.cancel.expired"
	tradeCancelNoRoom   = "trade.cancel.no_room"
	tradeCancelStaff    = "trade.cancel.staff"
	tradeCancelReadOnly = "trade.cancel.read_only"
	msgTradeReadOnly    = "trade.read_only"
	msgTradeEmpty       = "trade.empty"
	msgTradeTooFast     = "trade.too_fast"
)

// trade is a trade between two players: p[0] invited p[1]. Loop goroutine only.
type trade struct {
	p        [2]*Player
	started  bool      // p[1] accepted the invitation
	expires  game.Tick // the invitation's end (until started)
	offer    [2][]tradeItem
	accepted [2]bool
	// pos are the players' positions when the offers last changed: a step clears the
	// confirmations.
	pos [2]world.Pos
}

// tradeItem is one offered item and the stack size it had when offered.
type tradeItem struct {
	it    *Item
	count int
}

func (t *trade) side(p *Player) int {
	if t.p[1] == p {
		return 1
	}
	return 0
}

func (w *World) initTrade() {
	t := w.cfg.Balance.Trade
	if !t.Enabled || w.cfg.Transfer == nil {
		return
	}
	w.tradeOn, w.trade = true, t
	w.tradeFor = max(game.Tick(t.RequestMs/int(game.TickDuration.Milliseconds())), 1)
	w.tradeRefill = max(game.Tick(t.ActionRefillMs/int(game.TickDuration.Milliseconds())), 1)
	w.tradeBurst = w.tradeRefill * game.Tick(max(t.ActionBurst-1, 0))
}

// tradeFlood counts one trade action against the trade anti-flood limit (GCRA): every
// completed trade is a write of two whole characters.
func (w *World) tradeFlood(ctx *game.TickContext, p *Player) bool {
	tat := max(p.tradeTAT, ctx.Tick)
	if tat-ctx.Tick > w.tradeBurst {
		p.emit(systemMsg(msgTradeTooFast))
		return false
	}
	p.tradeTAT = tat + w.tradeRefill
	return true
}

// adjacent reports whether a and b stand on the same floor at most one tile apart.
func adjacent(a, b world.Pos) bool {
	return a.Z == b.Z && max(absInt(int(a.X)-int(b.X)), absInt(int(a.Y)-int(b.Y))) <= 1
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// tradeRequest is TradeRequest: invite target, or accept its invitation.
func (w *World) tradeRequest(ctx *game.TickContext, p *Player, m *pb.TradeRequest) {
	if !w.tradeOn {
		p.emit(systemMsg(msgTradeOff))
		return
	}
	if w.readOnly {
		p.emit(systemMsg(msgTradeReadOnly))
		return
	}
	if !w.tradeFlood(ctx, p) {
		return
	}
	o := w.playerByID(m.GetCreatureId())
	switch {
	case o == nil || o == p || o.linkDead || !Sees(p.pos, o.pos):
		p.emit(systemMsg(msgNotPossible))
		return
	case p.role > RolePlayer || o.role > RolePlayer:
		p.emit(systemMsg(msgTradeStaff))
		return
	case !adjacent(p.pos, o.pos):
		p.emit(systemMsg(msgTradeTooFar))
		return
	case w.pvpLocked(ctx.Tick, p) || w.pvpLocked(ctx.Tick, o):
		p.emit(systemMsg(msgTradeCombat))
		return
	}
	if t := p.trade; t != nil {
		if t.started || t.p[1] != p || t.p[0] != o {
			p.emit(systemMsg(msgTradeBusy))
			return
		}
		t.started = true // p accepts o's invitation
		t.pos = [2]world.Pos{t.p[0].pos, t.p[1].pos}
	} else {
		if o.trade != nil {
			p.emit(systemMsg(msgTradeBusy, textParam("name", o.name)))
			return
		}
		t = &trade{p: [2]*Player{p, o}, expires: ctx.Tick + w.tradeFor, pos: [2]world.Pos{p.pos, o.pos}}
		p.trade, o.trade = t, t
		w.trades = append(w.trades, t)
	}
	p.active(ctx.Tick, antibot.KindOther)
	if m.GetItemId() != 0 {
		w.tradeAdd(p, m.GetItem(), m.GetItemId(), m.GetStackIndex())
	}
	w.sendTrade(p.trade, "")
}

// tradeOffer is TradeOffer: add an item to p's offer or take one out.
func (w *World) tradeOffer(ctx *game.TickContext, p *Player, m *pb.TradeOffer) {
	t := p.trade
	if t == nil || (!t.started && t.side(p) == 1) || !w.tradeFlood(ctx, p) {
		return
	}
	p.active(ctx.Tick, antibot.KindOther)
	if m.GetRemove() {
		s := t.side(p)
		i := int(m.GetIndex())
		if i >= len(t.offer[s]) {
			return
		}
		t.offer[s] = slices.Delete(t.offer[s], i, i+1)
		t.accepted = [2]bool{}
		w.sendTrade(t, "")
		return
	}
	if w.tradeAdd(p, m.GetItem(), m.GetItemId(), m.GetStackIndex()) {
		w.sendTrade(t, "")
	}
}

// tradeAdd adds the item at loc to p's offer, or tells p why not.
func (w *World) tradeAdd(p *Player, loc *pb.ItemLocation, itemID, index uint32) bool {
	t := p.trade
	s := t.side(p)
	it, from := w.itemAt(p, loc, itemID, index)
	switch {
	case it == nil || from.kind != locContainer || it.carriedBy() != p:
		p.emit(systemMsg(msgTradeBadItem))
		return false
	case !tradeableItem(it) || slices.ContainsFunc(t.offer[s], func(x tradeItem) bool { return x.it == it }):
		p.emit(systemMsg(msgTradeBadItem))
		return false
	case len(t.offer[s]) >= w.trade.MaxItems:
		p.emit(systemMsg(msgTradeFull, num("max", w.trade.MaxItems)))
		return false
	}
	t.offer[s] = append(t.offer[s], tradeItem{it: it, count: it.count})
	t.accepted = [2]bool{}
	return true
}

// tradeableItem: a tradeable item, and a container only when empty.
func tradeableItem(it *Item) bool {
	return it.def.Tradeable && len(it.items) == 0
}

// tradeAccept is TradeAccept: p confirms; the second confirmation swaps the items.
func (w *World) tradeAccept(ctx *game.TickContext, p *Player) {
	t := p.trade
	if t == nil || !t.started || !w.tradeFlood(ctx, p) || !w.checkTrade(ctx, t) {
		return
	}
	if len(t.offer[0]) == 0 && len(t.offer[1]) == 0 {
		// Nothing to swap: confirming would only write two snapshots for nothing.
		p.emit(systemMsg(msgTradeEmpty))
		return
	}
	p.active(ctx.Tick, antibot.KindOther)
	t.accepted[t.side(p)] = true
	if t.accepted[0] && t.accepted[1] {
		w.completeTrade(ctx, t)
		return
	}
	w.sendTrade(t, "")
}

// tradeCancel is TradeCancel.
func (w *World) tradeCancel(p *Player) {
	if t := p.trade; t != nil {
		w.endTrade(t, pb.TradeState_TRADE_STATE_CANCELLED, "")
	}
}

// cancelTrade cancels p's trade, if any, telling both why (death, leaving the world).
func (w *World) cancelTrade(p *Player, reason string) {
	if t := p.trade; t != nil {
		w.endTrade(t, pb.TradeState_TRADE_STATE_CANCELLED, reason)
	}
}

func (w *World) endTrade(t *trade, state pb.TradeState, reason string) {
	w.sendTradeState(t, state, reason)
	t.p[0].trade, t.p[1].trade = nil, nil
	if i := slices.Index(w.trades, t); i >= 0 {
		w.trades = slices.Delete(w.trades, i, i+1)
	}
}

// checkTrade validates t now: it cancels t (false) when the players are no longer
// adjacent, in a PvP fight, staff, or the invitation expired; it drops offered items that
// left their owner or changed, and clears the confirmations when anything changed.
func (w *World) checkTrade(ctx *game.TickContext, t *trade) bool {
	a, b := t.p[0], t.p[1]
	reason := ""
	switch {
	case !t.started && ctx.Tick >= t.expires:
		reason = tradeCancelExpired
	case !adjacent(a.pos, b.pos):
		reason = tradeCancelFar
	case w.pvpLocked(ctx.Tick, a) || w.pvpLocked(ctx.Tick, b):
		reason = tradeCancelCombat
	case a.role > RolePlayer || b.role > RolePlayer:
		reason = tradeCancelStaff
	}
	if reason != "" {
		w.endTrade(t, pb.TradeState_TRADE_STATE_CANCELLED, reason)
		return false
	}
	changed := t.pos != [2]world.Pos{a.pos, b.pos}
	for s := range t.offer {
		kept := t.offer[s][:0]
		for _, x := range t.offer[s] {
			if x.it.carriedBy() == t.p[s] && x.it.parent != nil && x.it.count == x.count && tradeableItem(x.it) {
				kept = append(kept, x)
			} else {
				changed = true
			}
		}
		t.offer[s] = kept
	}
	if changed {
		t.pos = [2]world.Pos{a.pos, b.pos}
		if t.accepted != [2]bool{} || len(t.offer[0])+len(t.offer[1]) > 0 {
			t.accepted = [2]bool{}
			w.sendTrade(t, "")
		}
	}
	return true
}

// checkTrades validates every open trade once per tick (there are few, each bounded by
// max_items per side).
func (w *World) checkTrades(ctx *game.TickContext) {
	for i := len(w.trades) - 1; i >= 0; i-- {
		if i < len(w.trades) {
			w.checkTrade(ctx, w.trades[i])
		}
	}
}

// completeTrade swaps the offers: all or nothing. Each side must have room in its
// backpack and capacity for what it gets, counting what it gives away.
func (w *World) completeTrade(ctx *game.TickContext, t *trade) {
	for s := range 2 {
		if !w.tradeFits(t.p[s], t.offer[1-s], t.offer[s]) {
			w.endTrade(t, pb.TradeState_TRADE_STATE_CANCELLED, tradeCancelNoRoom)
			return
		}
	}
	for s := range 2 {
		giver, taker := t.p[s], t.p[1-s]
		for _, x := range t.offer[s] {
			w.econItemWith(giver, EconTrade, "trade", taker.charID, x.it.def, -units(x.it))
			w.removeItem(x.it)
		}
	}
	for s := range 2 {
		giver, taker := t.p[s], t.p[1-s]
		bp := taker.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]
		if len(t.offer[s]) == 0 || bp == nil { // tradeFits: nil only when nothing comes
			continue
		}
		for _, x := range t.offer[s] {
			w.attach(taker, x.it, place{kind: locContainer, cont: bp})
			w.econItemWith(taker, EconTrade, "trade", giver.charID, x.it.def, units(x.it))
		}
		w.containerChanged(bp)
	}
	for _, p := range t.p {
		p.questDirty = true
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_PlayerStats{PlayerStats: w.stats(p)}})
		p.emit(systemMsg(msgTradeCompleted))
	}
	w.transfer(t.p[:])
	w.log.Info("trade: completed", "a", t.p[0].charID, "b", t.p[1].charID, "a_items", len(t.offer[0]), "b_items", len(t.offer[1]))
	w.endTrade(t, pb.TradeState_TRADE_STATE_COMPLETED, "")
}

// tradeFits reports whether p can take in (into its backpack's top level) while giving
// out away.
func (w *World) tradeFits(p *Player, in, out []tradeItem) bool {
	bp := p.equip[pb.EquipmentSlot_EQUIPMENT_SLOT_BACKPACK]
	if len(in) == 0 {
		return true
	}
	if bp == nil || bp.def.Container == nil {
		return false
	}
	used, weight := len(bp.items), p.carried()
	for _, x := range out {
		if x.it.parent == bp {
			used--
		}
		weight -= x.it.weight()
	}
	for _, x := range in {
		weight += x.it.weight()
	}
	return used+len(in) <= bp.def.Slots() && weight <= p.capacity
}

func (w *World) sendTrade(t *trade, reason string) {
	state := pb.TradeState_TRADE_STATE_REQUESTED
	if t.started {
		state = pb.TradeState_TRADE_STATE_NEGOTIATING
	}
	w.sendTradeState(t, state, reason)
}

func (w *World) sendTradeState(t *trade, state pb.TradeState, reason string) {
	for s, p := range t.p {
		o := t.p[1-s]
		u := &pb.TradeUpdate{
			State: state, PartnerCreatureId: o.id, PartnerName: o.name,
			OwnAccepted: t.accepted[s], PartnerAccepted: t.accepted[1-s],
			Invited: s == 1 && !t.started, Reason: reason, MaxItems: uint32(w.trade.MaxItems),
		}
		if state == pb.TradeState_TRADE_STATE_REQUESTED || state == pb.TradeState_TRADE_STATE_NEGOTIATING {
			u.OwnOffer = tradeStacks(t.offer[s])
			u.PartnerOffer = tradeStacks(t.offer[1-s])
		}
		p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_TradeUpdate{TradeUpdate: u}})
	}
}

func tradeStacks(list []tradeItem) []*pb.ItemStack {
	out := make([]*pb.ItemStack, len(list))
	for i, x := range list {
		out[i] = x.it.stack()
	}
	return out
}

// TradeItems returns the item definitions p offers in its open trade (tests).
func (w *World) TradeItems(p *Player) []*content.Item {
	if p.trade == nil {
		return nil
	}
	var out []*content.Item
	for _, x := range p.trade.offer[p.trade.side(p)] {
		out = append(out, x.it.def)
	}
	return out
}
