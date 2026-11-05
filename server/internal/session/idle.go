package session

import (
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/antibot"
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
// kind is the kind of action for the bot detection (antibot.Kind*): the time between
// actions of the same kind is what is measured.
func (p *Player) active(tick game.Tick, kind int) { p.activePaced(tick, kind, 0) }

// pacedSlack is how soon after its cooldown an action counts as paced by the server.
const pacedSlack = game.Tick(2) // 100 ms

// activePaced is active for an action with a cooldown that ended at readyAt. The server
// set its pace, so it is no timing sample for the bot detection, when it came right as
// the cooldown allowed, or when an earlier try of the same kind was refused for the
// cooldown since the last one (a player mashing the hotkey: the client sends one action
// per key press, never an auto-repeat).
func (p *Player) activePaced(tick game.Tick, kind int, readyAt game.Tick) {
	p.lastAction, p.idleWarned = tick, false
	if kind < 0 || kind >= antibot.NumKinds {
		kind = antibot.KindOther
	}
	paced := readyAt > 0 && tick <= readyAt+pacedSlack ||
		p.earlyTry[kind] != 0 && p.earlyTry[kind] >= p.kindLast[kind]
	p.earlyTry[kind], p.kindLast[kind] = 0, tick
	if p.sus != nil { // bot detection: the time between real actions, steps aside (T4.1)
		p.sus.tracker.Action(tickMs(tick), kind, paced, p.sus.cfg)
	}
}

// tooEarly records a try refused because its cooldown had not ended.
func (p *Player) tooEarly(tick game.Tick, kind int) { p.earlyTry[kind] = tick }

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
