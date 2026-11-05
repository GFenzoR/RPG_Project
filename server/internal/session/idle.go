package session

import (
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Idle disconnect (T4.1, docs/02-game-design.md "Anti-bot y anti-AFK"). A player
// without a real action for balance idle.kick_after_ms is disconnected with IDLE, after
// a warning idle.warn_before_ms before. Pings, turning, looking, fight stances and
// closing windows are not real actions: they are what a keepalive would send. A player
// in combat (travel.combat_block_ms) or on a no-logout tile is never disconnected; it
// is checked again until it can be.

const (
	msgIdleWarning = "idle.warning"
	// idleCheckEvery is how often the idle times are checked (1 s).
	idleCheckEvery = game.Tick(1000 / 50)
)

func (w *World) initIdle() {
	i := w.cfg.Balance.Idle
	w.idleKickFor = game.TicksFor(time.Duration(i.KickAfterMs) * time.Millisecond)
	w.idleWarnFor = game.TicksFor(time.Duration(i.WarnBeforeMs) * time.Millisecond)
}

// realAction reports whether msg is something a player does (it resets the idle time).
func realAction(msg *pb.ClientMessage) bool {
	switch msg.GetMessage().(type) {
	case *pb.ClientMessage_Walk, *pb.ClientMessage_WalkPath, *pb.ClientMessage_SetTarget,
		*pb.ClientMessage_CastSpell, *pb.ClientMessage_UseItem, *pb.ClientMessage_UseItemOn,
		*pb.ClientMessage_MoveItem, *pb.ClientMessage_Say, *pb.ClientMessage_NpcTalk,
		*pb.ClientMessage_DialogChoose, *pb.ClientMessage_ShopBuy, *pb.ClientMessage_ShopSell,
		*pb.ClientMessage_PartyCommand, *pb.ClientMessage_Craft:
		return true
	}
	return false
}

// checkIdle warns and disconnects idle players, once a second.
func (w *World) checkIdle(ctx *game.TickContext) {
	if w.idleKickFor == 0 || ctx.Tick%idleCheckEvery != 0 {
		return
	}
	w.idleBuf = w.idleBuf[:0]
	for _, p := range w.players {
		since := max(p.lastAction, p.joinedAt)
		idle := ctx.Tick - since
		if w.idleWarnFor > 0 && !p.idleWarned && idle+w.idleWarnFor >= w.idleKickFor {
			p.idleWarned = true
			left := (w.idleKickFor - min(idle, w.idleKickFor)).Duration()
			p.emit(systemMsg(msgIdleWarning, num("seconds", int(left.Round(time.Second).Seconds()))))
		}
		if idle >= w.idleKickFor && !w.inCombat(ctx.Tick, p) && w.m.Flags(p.pos)&world.FlagNoLogout == 0 {
			w.idleBuf = append(w.idleBuf, p)
		}
	}
	for _, p := range w.idleBuf {
		w.log.Info("session: idle player disconnected", "character", p.charID, "idle", (ctx.Tick - max(p.lastAction, p.joinedAt)).Duration().String())
		w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_IDLE, false)
	}
}
