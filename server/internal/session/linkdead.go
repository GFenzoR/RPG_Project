package session

import (
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// The logout block of a fight (docs/02-game-design.md "Bloqueo de logout en combate"): a
// player in combat (inCombat: within balance travel.combat_block_ms a monster attacked it,
// it took damage or it hit a monster or a player; or its PvP lock lasts, T5.2) cannot log
// out, and closing the connection does not take it out of the world either: it stays
// link-dead until the fight is over. Leaving the game is no way out of a death.

// msgLogoutLocked refuses a Logout in a fight that is not a PvP lock (that one says
// pvp.logout_locked).
const msgLogoutLocked = "combat.logout_locked"

// logoutBlock is why p cannot log out now: the message key, or "" when it may.
func (w *World) logoutBlock(tick game.Tick, p *Player) string {
	switch {
	case w.pvpLocked(tick, p):
		return msgPvPLogoutLocked
	case w.inCombat(tick, p):
		return msgLogoutLocked
	}
	return ""
}

// linkDeadOnLeave keeps p in the world when its connection closes while it is in combat
// (inCombat): link-dead, it does nothing (Input ignores it, its trade is cancelled and its
// market window closed) but can still be attacked, monsters keep it as their target and
// its conditions keep ticking (each hit renews the block), until holdsLinkDead ends;
// checkLinkDead then saves it and takes it out, or a death does (deathSave). Nobody plays
// it: it trains no skill (trainBy) and helps no party fight (contribute). It reports
// whether p stays: a player already link-dead stays as it is. A new login of the character
// takes it over (join).
func (w *World) linkDeadOnLeave(tick game.Tick, p *Player) bool {
	if p.linkDead {
		return true
	}
	if !w.inCombat(tick, p) {
		return false
	}
	p.linkDead, p.linkDeadAt = true, tick
	p.target, p.ptarget = nil, nil
	p.stopWalk()
	p.out = p.out[:0]
	w.cancelTrade(p, tradeCancelLeft) // T5.3: "a trade ends if one disconnects" (docs/02)
	w.dropMarket(p)                   // T5.3: nobody to refresh its market window for (flushMarket)
	w.linkDead = append(w.linkDead, p)
	w.log.Info("link-dead", "character", p.charID)
	return true
}

// disconnect closes p's connection with reason because the server ends it (a slow client,
// a password reset). In combat p stays in the world link-dead, as if it had closed the
// connection itself (Leave): the connection closes now and p leaves when the block ends.
// Anyone else leaves the world now (remove). A staff kick or ban, a failed save and a
// logout do not come here: they take the character out.
func (w *World) disconnect(ctx *game.TickContext, p *Player, reason pb.DisconnectReason, slow bool) {
	if !w.linkDeadOnLeave(ctx.Tick, p) {
		w.remove(ctx, p, reason, slow)
		return
	}
	if !p.dropped {
		p.dropped = true
		p.client.Close(reason) // once: remove sends and closes nothing more
	}
}

// LinkDead reports whether p lost its connection and stays in the world for its fight.
func (p *Player) LinkDead() bool { return p.linkDead }

// holdsLinkDead reports whether link-dead p stays in the world: its PvP lock lasts, or it
// is in combat (inCombat) and has not been link-dead for balance travel.link_dead_max_ms
// yet. Without that cap a weak spawn that keeps biting a strong character for nothing
// would hold it there for good (the review of the logout block: it would regenerate and
// stand in its party's fights offline).
func (w *World) holdsLinkDead(now game.Tick, p *Player) bool {
	return w.pvpLocked(now, p) || w.inCombat(now, p) && (w.linkDeadFor == 0 || now-p.linkDeadAt < w.linkDeadFor)
}

// checkLinkDead takes out the link-dead players whose fight is over or capped
// (holdsLinkDead), or that died (deathSave), saving them (remove). It runs every tick, at
// the end, over World.linkDead only (usually empty).
func (w *World) checkLinkDead(ctx *game.TickContext) {
	for i := 0; i < len(w.linkDead); {
		p := w.linkDead[i]
		if !p.diedLinkDead && w.holdsLinkDead(ctx.Tick, p) {
			i++
			continue
		}
		w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED, false) // drops index i
		if i < len(w.linkDead) && w.linkDead[i] == p {
			// remove did nothing: p is listed but not in the world (byClient), which only
			// remove should leave (forgetLinkDead). Drop the entry rather than spin on it:
			// a loop that never ends would hang the game loop (game.Loop recovers a
			// panic, not a hang).
			w.log.Error("session: a link-dead player out of the world was still listed", "character", p.charID)
			p.linkDead = false
			w.linkDead = slices.Delete(w.linkDead, i, i+1)
		}
	}
}

// forgetLinkDead takes p out of World.linkDead when it leaves the world.
func (w *World) forgetLinkDead(p *Player) {
	if p.linkDead {
		p.linkDead = false
		w.linkDead = slices.DeleteFunc(w.linkDead, func(o *Player) bool { return o == p })
	}
}

// deathSave saves p's state right after its death (die, arenaDefeat), at once: a crash
// cannot undo it. A link-dead player whose death ended its fight (wakeAtTemple; a PvP lock
// would still hold it) leaves the world instead, at the end of this tick (checkLinkDead:
// not here, where a fight loop may be going over the players), and its final snapshot is
// that save: the death is saved once, as anyone's.
func (w *World) deathSave(ctx *game.TickContext, p *Player) {
	if p.linkDead && !w.holdsLinkDead(ctx.Tick, p) {
		p.diedLinkDead = true
		return
	}
	w.save(w.snapshot(p, false))
}

// diedLinkDeadNotice keeps died, the death.died message of p's death, for p's next login
// when p is link-dead (nobody to tell now: flushPlayer drops it): that login opens with the
// death screen (tellDiedAway) instead of a character at the temple with less experience
// and nothing said. An arena defeat keeps its pvp.arena_defeat the same way (arenaDefeat),
// but never in place of a death's. It lives in memory only, one message per character
// until its next login: a restart in between loses it, and a character that never comes
// back keeps its one entry until then (bounded by the characters, a few bytes each; the
// review of the logout block accepted it rather than age it out).
func (w *World) diedLinkDeadNotice(p *Player, died *pb.ServerMessage) {
	if p.linkDead {
		w.diedAway[p.charID] = died
	}
}

// tellDiedAway tells p, which just joined, of the death its character died link-dead
// since its last login (diedLinkDeadNotice), once.
func (w *World) tellDiedAway(p *Player) {
	if died, ok := w.diedAway[p.charID]; ok {
		delete(w.diedAway, p.charID)
		p.emit(died)
	}
}

// carryFight is what a new login takes over from the player it replaces (a link-dead one,
// or one still connected): its fight, so a relog is no way out of the logout block or the
// boat's combat rule, and its PvP locks (pvpCarry).
func (w *World) carryFight(from, to *Player) {
	to.fightAt = from.fightAt
	w.pvpCarry(from, to)
}
