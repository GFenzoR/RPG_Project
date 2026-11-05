package session

import (
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Idle disconnect (T4.1, docs/02-game-design.md "Anti-bot y anti-AFK"). A player
// without a real action for balance idle.kick_after_ms is disconnected with IDLE, after
// a warning idle.warn_before_ms before. Pings, turning, looking, fight stances, closing
// windows and refused intents are not real actions: they are what a keepalive sends. A player
// in combat (travel.combat_block_ms) or on a no-logout tile is never disconnected; it
// is checked again until it can be.

const msgIdleWarning = "idle.warning"

// idleCheckEvery is how often the idle times are checked.
var idleCheckEvery = game.TicksFor(time.Second)

func (w *World) initIdle() {
	i := w.cfg.Balance.Idle
	w.idleKickFor = game.TicksFor(time.Duration(i.KickAfterMs) * time.Millisecond)
	w.idleWarnFor = game.TicksFor(time.Duration(i.WarnBeforeMs) * time.Millisecond)
}

// active marks a real action of p: something that happened, not only an intent. The
// handlers call it after validating (a step taken, a target set, a spell cast, an item
// moved or used, a chat line said, a dialog, a trade, a gathering or crafting attempt),
// so an invalid or empty intent (a walk into a wall, SetTarget 0, an unknown item) does
// not keep an idle player online.
func (p *Player) active(tick game.Tick) {
	p.lastAction, p.idleWarned = tick, false
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
