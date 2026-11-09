package session

import (
	"slices"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/combat"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// PvP with skulls (T5.2, docs/02-game-design.md "PvP"). Every rule is checked here, on
// the loop: where players may fight (zones, levels, staff, safe mode), when an attack is
// justified, the skulls and the locks, and what a death by players counts.
//
// Costs: a check reads a few tile flags and at most maxHitBy entries; a hit appends or
// updates one entry. The sweep that ends skulls and wars runs once per second over the
// players with a skull and the open wars, never over every player.

// Message keys of PvP.
const (
	msgPvPOff            = "pvp.off"
	msgPvPStaff          = "pvp.staff"
	msgPvPProtected      = "pvp.protected_staff"
	msgPvPYourLevel      = "pvp.your_level"
	msgPvPTheirLevel     = "pvp.their_level"
	msgPvPZone           = "pvp.zone"
	msgPvPSafeMode       = "pvp.safe_mode"
	msgPvPLogoutLocked   = "pvp.logout_locked"
	msgPvPProtLocked     = "pvp.protection_locked"
	msgPvPKill           = "pvp.kill"
	msgPvPKillUnjust     = "pvp.kill_unjust"
	msgPvPKilledBy       = "pvp.killed_by"
	msgPvPKilledUnseen   = "pvp.killed_unseen"
	msgPvPArenaDefeat    = "pvp.arena_defeat"
	msgPvPSkullGained    = "pvp.skull_gained"
	msgPvPSafeOn         = "pvp.safe_on"
	msgPvPSafeOff        = "pvp.safe_off"
	msgGMSkullRemoved    = "gm.skull_removed"
	msgPvPSkullRemovedGM = "pvp.skull_removed_staff"
)

// Recent event kinds of PvP (reports, T4.1): ref is the other player's name.
const (
	eventAttackPlayer = "attack_player"
	eventKillPlayer   = "kill_player"
)

// maxHitBy bounds the recent attackers remembered per player; the oldest is replaced.
const maxHitBy = 8

// maxUnjust bounds the unjustified kills remembered per player (older ones beyond the
// windows are dropped anyway).
const maxUnjust = content.MaxUnjustKills

// PvPState is the persisted PvP state of a character (Character.PvP, Snapshot.PvP).
type PvPState struct {
	// Skull is the skull it shows (pb.Skull values) until SkullUntil.
	Skull      int
	SkullUntil time.Time
	// Kills counts every player it killed.
	Kills int
	// Unjust are its unjustified kills inside the longest window, oldest first.
	Unjust []time.Time
}

// pvpHit is a recent hit of a player on p: who (character), when, and whether any of
// its hits since the entry started was unjustified.
type pvpHit struct {
	char   int64
	at     game.Tick
	unjust bool
	// arena: every hit of the entry was an arena hit (both in a pvp zone).
	arena bool
}

func (w *World) initPvP() {
	w.wars = map[int64]*guildWar{}
	w.pvp = w.cfg.Balance.PvP
	w.pvpOn = w.pvp.Enabled
	if !w.pvpOn {
		return
	}
	w.pvpLockFor = ticksFor(w.pvp.LockMs)
	w.pvpKillLock = ticksFor(w.pvp.KillLockMs)
	w.pvpCreditFor = ticksFor(w.pvp.KillCreditMs)
	w.pvpAggrFor = ticksFor(w.pvp.AggressorMs)
	w.aggrDur = time.Duration(w.pvp.AggressorMs) * time.Millisecond
	w.unjustKeep = time.Duration(max(w.pvp.Murderer.MaxWindowHours(), w.pvp.Outlaw.MaxWindowHours())) * time.Hour
	w.initWars()
}

// ---- state ------------------------------------------------------------------------

// loadPvP restores p's saved skull, counter and unjustified kills.
func (w *World) loadPvP(ctx *game.TickContext, p *Player, s PvPState) {
	p.pvpKills = max(s.Kills, 0)
	p.unjust = slices.Clone(s.Unjust)
	switch pb.Skull(s.Skull) {
	case pb.Skull_SKULL_AGGRESSOR:
		p.aggrUntil = s.SkullUntil
	case pb.Skull_SKULL_MURDERER, pb.Skull_SKULL_OUTLAW:
		p.mark, p.markUntil = pb.Skull(s.Skull), s.SkullUntil
	}
	if !w.pvpOn {
		return // kept for the next snapshot, but nobody sees a skull with PvP off
	}
	p.skull = w.currentSkull(p, ctx.Now)
	if p.skull != pb.Skull_SKULL_UNSPECIFIED {
		w.listSkulled(p)
	}
}

// pvpState is what a snapshot saves of p.
func (w *World) pvpState(p *Player) PvPState {
	// From the marks themselves, not p.skull: with PvP off a saved skull is kept as it was.
	// An expired one is saved too; loadPvP ignores it.
	s := PvPState{Kills: p.pvpKills, Unjust: slices.Clone(p.unjust)}
	switch {
	case p.mark != pb.Skull_SKULL_UNSPECIFIED:
		s.Skull, s.SkullUntil = int(p.mark), p.markUntil
	case !p.aggrUntil.IsZero():
		s.Skull, s.SkullUntil = int(pb.Skull_SKULL_AGGRESSOR), p.aggrUntil
	}
	return s
}

// Skull returns the skull p shows (T5.2).
func (p *Player) Skull() pb.Skull { return p.skull }

// SafeMode reports whether p's safe mode is on.
func (p *Player) SafeMode() bool { return p.safe }

// currentSkull is p's skull at now: its mark while it lasts, else aggressor while that
// lasts.
func (w *World) currentSkull(p *Player, now time.Time) pb.Skull {
	if p.mark != pb.Skull_SKULL_UNSPECIFIED && now.Before(p.markUntil) {
		return p.mark
	}
	if now.Before(p.aggrUntil) {
		return pb.Skull_SKULL_AGGRESSOR
	}
	return pb.Skull_SKULL_UNSPECIFIED
}

// refreshSkull recomputes p's skull and, if it changed, tells everyone who sees p.
func (w *World) refreshSkull(p *Player, now time.Time) {
	s := w.currentSkull(p, now)
	if s == pb.Skull_SKULL_UNSPECIFIED && p.mark != pb.Skull_SKULL_UNSPECIFIED {
		p.mark, p.markUntil = pb.Skull_SKULL_UNSPECIFIED, time.Time{}
	}
	if s == p.skull {
		return
	}
	p.skull = s
	if s != pb.Skull_SKULL_UNSPECIFIED {
		w.listSkulled(p)
	}
	msg := &pb.ServerMessage{Message: &pb.ServerMessage_CreatureSkull{CreatureSkull: &pb.CreatureSkull{Id: p.id, Skull: s}}}
	w.eachWatcher(p, func(o *Player) { o.emit(msg) })
}

func (w *World) listSkulled(p *Player) {
	if !p.skullList {
		p.skullList = true
		w.skulled = append(w.skulled, p)
	}
}

// pvpLeftWorld forgets p in the PvP lists when it leaves the world.
func (w *World) pvpLeftWorld(p *Player) {
	p.ptarget = nil
	if p.linkDead {
		p.linkDead = false
		w.linkDead = slices.DeleteFunc(w.linkDead, func(o *Player) bool { return o == p })
	}
	for _, o := range w.players {
		if o.ptarget == p {
			o.ptarget = nil // a spell without a target must not reach a gone player
		}
	}
	if p.skullList {
		p.skullList = false
		w.skulled = slices.DeleteFunc(w.skulled, func(o *Player) bool { return o == p })
	}
}

// checkPvP is the once-per-second sweep: skulls that ended and wars that expired.
func (w *World) checkPvP(ctx *game.TickContext) {
	if !w.pvpOn || ctx.Tick < w.pvpNext {
		return
	}
	w.pvpNext = ctx.Tick + ticksFor(1000)
	for i := 0; i < len(w.linkDead); {
		if p := w.linkDead[i]; !w.pvpLocked(ctx.Tick, p) {
			w.remove(ctx, p, pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED, false) // drops index i
			continue
		}
		i++
	}
	for i := 0; i < len(w.skulled); {
		p := w.skulled[i]
		w.refreshSkull(p, ctx.Now)
		if p.skull == pb.Skull_SKULL_UNSPECIFIED {
			p.skullList = false
			w.skulled = append(w.skulled[:i], w.skulled[i+1:]...)
			continue
		}
		i++
	}
	w.checkWars(ctx)
}

// ---- rules ------------------------------------------------------------------------

func isStaff(p *Player) bool { return p.role >= RoleGM }

// pvpPlace answers whether a may hurt v at all by the rules of place and level (not by
// the safe mode): "" if it may, else the message key (and its level parameter) why not.
func (w *World) pvpPlace(a, v *Player) (string, int) {
	switch {
	case !w.pvpOn || a == v:
		return msgPvPOff, 0
	case isStaff(a):
		return msgPvPStaff, 0
	case isStaff(v):
		return msgPvPProtected, 0
	case a.level < w.pvp.MinLevel:
		return msgPvPYourLevel, w.pvp.MinLevel
	case v.level < w.pvp.MinLevel:
		return msgPvPTheirLevel, w.pvp.MinLevel
	}
	fa, fv := w.m.Flags(a.pos), w.m.Flags(v.pos)
	if (fa|fv)&(world.FlagProtection|world.FlagNoPvP) != 0 {
		return msgPvPZone, 0
	}
	return "", 0
}

// arena reports whether a and v both stand in a pvp zone (no skulls, no penalties).
func (w *World) arena(a, v *Player) bool {
	return w.m.Flags(a.pos)&w.m.Flags(v.pos)&world.FlagPvP != 0
}

// justified reports whether a attacking v now is justified: v has a skull, their guilds
// are at war, v attacked a recently (self-defense), or both stand in an arena.
func (w *World) justified(tick game.Tick, a, v *Player) bool {
	if v.skull != pb.Skull_SKULL_UNSPECIFIED || w.arena(a, v) || w.activeWar(a, v) != nil {
		return true
	}
	for _, h := range a.hitBy {
		// Arena duels give no right of self-defense outside the arena.
		if h.char == v.charID && !h.arena && tick-h.at < w.pvpAggrFor {
			return true
		}
	}
	return false
}

// unjustHit reports whether a's recent hits on v (within the aggressor time) include an
// unjustified one: an attack a condition of a may continue.
func (w *World) unjustHit(tick game.Tick, v *Player, a *Player) bool {
	for _, h := range v.hitBy {
		if h.char == a.charID && h.unjust && tick-h.at < w.pvpAggrFor {
			return true
		}
	}
	return false
}

// conditionMayHurt reports whether a condition that a applied may hurt v now: an attack a
// could start itself (zones, levels, staff, safe mode), and never a new unjustified one —
// only one a already made by hand (a burn that outlives an arena duel or a war hurts
// nobody).
func (w *World) conditionMayHurt(tick game.Tick, a, v *Player) bool {
	if key, _ := w.canAttack(tick, a, v); key != "" {
		return false
	}
	return w.arena(a, v) || w.justified(tick, a, v) || w.unjustHit(tick, v, a)
}

// canAttack is pvpPlace plus the safe mode: with it on, only justified attacks.
func (w *World) canAttack(tick game.Tick, a, v *Player) (string, int) {
	if key, n := w.pvpPlace(a, v); key != "" {
		return key, n
	}
	if a.safe && !w.justified(tick, a, v) {
		return msgPvPSafeMode, 0
	}
	return "", 0
}

// refuse tells p why it cannot attack.
func refuseMsg(key string, level int) *pb.ServerMessage {
	if level > 0 {
		return systemMsg(key, num("level", level))
	}
	return systemMsg(key)
}

// areaHits reports whether a's area spell hurts v: an attack a could start, never on a
// member of a's party or guild.
func (w *World) areaHits(tick game.Tick, a, v *Player) bool {
	if !a.Knows(v.id) {
		return false // an unseen (invisible) player: no hit, no mark, no hint
	}
	if a.party != nil && a.party == v.party || a.gm != nil && v.gm != nil && a.gm.g == v.gm.g {
		return false
	}
	key, _ := w.canAttack(tick, a, v)
	return key == ""
}

// pvpLocked reports whether p cannot log out now.
func (w *World) pvpLocked(tick game.Tick, p *Player) bool {
	return tick < p.lockUntil || tick < p.fightUntil
}

// ---- intents ----------------------------------------------------------------------

// setSafeMode is SetSafeMode.
func (w *World) setSafeMode(p *Player, on bool) {
	if p.safe == on {
		return
	}
	p.safe = on
	if on {
		p.emit(systemMsg(msgPvPSafeOn))
	} else {
		p.emit(systemMsg(msgPvPSafeOff))
	}
}

// setPlayerTarget makes p attack the player v (a SetTarget of a player).
func (w *World) setPlayerTarget(ctx *game.TickContext, p, v *Player) {
	p.target = nil
	if !p.Knows(v.id) || v.pos.Z != p.pos.Z {
		p.ptarget = nil
		p.emit(systemMsg(msgCannotAttack))
		return
	}
	if key, n := w.canAttack(ctx.Tick, p, v); key != "" {
		p.ptarget = nil
		p.emit(refuseMsg(key, n))
		return
	}
	if p.ptarget != v {
		p.recordEvent(ctx.Tick, eventAttackPlayer, v.name, 0, 0)
	}
	p.ptarget = v
}

// ---- fighting ---------------------------------------------------------------------

// pvpFoe returns p's player target if it may still be attacked this tick; otherwise it
// drops it (telling p why when the rules, not the view, changed) and returns nil.
func (w *World) pvpFoe(ctx *game.TickContext, p *Player) *Player {
	v := p.ptarget
	if w.byClient[v.client] != v || v.pos.Z != p.pos.Z || !Sees(p.pos, v.pos) || !p.Knows(v.id) {
		p.ptarget = nil // gone or out of view: the client dropped it too
		return nil
	}
	if key, n := w.canAttack(ctx.Tick, p, v); key != "" {
		p.ptarget = nil
		p.emit(refuseMsg(key, n))
		return nil
	}
	return v
}

// playerDefense is what protects v from a physical hit of a player: armor, shield and
// stance, as against a monster (the shield is not trained by players).
func (w *World) playerDefense(v *Player) combat.PlayerTarget {
	pt := combat.PlayerTarget{Armor: v.armor, ModeDefense: w.mode(v).Defense}
	if v.shield != nil && v.shield.Shield != nil {
		pt.ShieldDefense = v.shield.Shield.Defense
	}
	return pt
}

// hurtPlayer applies a hit of player a on player v (already rolled, before
// balance pvp.damage_pct): the aggression is judged and recorded, then v takes the
// scaled damage. direct is false for a condition's hit (it does not end a's
// invisibility). The caller checked pvpPlace.
func (w *World) hurtPlayer(ctx *game.TickContext, a, v *Player, dmg int, element string, direct bool) {
	w.aggress(ctx, a, v)
	if direct {
		w.reveal(ctx, a)
	}
	w.markFight(ctx, a)
	w.damagePlayerBy(ctx, v, dmg*w.pvp.DamagePct/100, element, a)
}

// aggress judges and records an attack of a on v: v remembers it (self-defense and
// kill credit), both are locked out of logging out (a also out of protection zones), and
// an unjustified attack gives a the aggressor skull (a mark it already has stays).
func (w *World) aggress(ctx *game.TickContext, a, v *Player) {
	arena := w.arena(a, v)
	unjust := !arena && !w.justified(ctx.Tick, a, v)
	w.rememberHit(ctx.Tick, v, a.charID, unjust, arena)
	if arena {
		return
	}
	a.lockUntil = max(a.lockUntil, ctx.Tick+w.pvpLockFor)
	v.fightUntil = max(v.fightUntil, ctx.Tick+w.pvpLockFor)
	if unjust {
		a.aggrUntil = ctx.Now.Add(w.aggrDur)
		w.refreshSkull(a, ctx.Now)
	}
}

// rememberHit records on v a hit by character char. An entry older than the aggressor
// time starts afresh; with maxHitBy entries the oldest is replaced.
func (w *World) rememberHit(tick game.Tick, v *Player, char int64, unjust, arena bool) {
	oldest := -1
	for i := range v.hitBy {
		h := &v.hitBy[i]
		if h.char == char {
			if tick-h.at >= w.pvpAggrFor {
				h.unjust, h.arena = false, true
			}
			h.at, h.unjust, h.arena = tick, h.unjust || unjust, h.arena && arena
			return
		}
		if oldest < 0 || h.at < v.hitBy[oldest].at {
			oldest = i
		}
	}
	if len(v.hitBy) < maxHitBy {
		v.hitBy = append(v.hitBy, pvpHit{char: char, at: tick, unjust: unjust, arena: arena})
		return
	}
	v.hitBy[oldest] = pvpHit{char: char, at: tick, unjust: unjust, arena: arena}
}

// pvpSource returns the online player that applied a condition to v, if it was another
// player (c.source is a creature id; monsters and players share the id space).
func (w *World) pvpSource(source uint32, v *Player) *Player {
	if !w.pvpOn || source == 0 || source == v.id {
		return nil
	}
	return w.playerByID(source)
}

// ---- deaths -----------------------------------------------------------------------

// pvpDeath settles the death of v if players took part in it. killer is the player whose
// hit killed v (nil: a monster, the world or a condition of nobody online). It is an arena
// defeat (no penalty, reported) only if v died on a pvp tile by a killer standing on one
// too. Every player that hurt v within balance pvp.kill_credit_ms gets the kill (its
// counter, and an unjustified kill if any of its hits was) — arena hits only in an arena
// defeat —, each war it was fought in scores once, both sides are told, and the kill is
// logged.
func (w *World) pvpDeath(ctx *game.TickContext, v, killer *Player) (arena bool) {
	if !w.pvpOn || len(v.hitBy) == 0 {
		return false
	}
	arena = killer != nil && w.arena(killer, v)
	last := killer
	var lastAt game.Tick
	var wars [maxHitBy]*guildWar
	var scorers [maxHitBy]*Player
	nw := 0
	for _, h := range v.hitBy {
		if ctx.Tick-h.at >= w.pvpCreditFor || h.arena && !arena {
			continue
		}
		a := w.byChar[h.char] // a locked attacker that lost its connection is still here (link-dead)
		if a == nil {
			continue
		}
		if killer == nil && (last == nil || h.at > lastAt) {
			last, lastAt = a, h.at
		}
		a.pvpKills++
		a.recordEvent(ctx.Tick, eventKillPlayer, v.name, 0, 0)
		war := w.activeWar(a, v)
		unjust := h.unjust && war == nil
		if unjust {
			w.unjustKill(ctx, a)
			a.emit(systemMsg(msgPvPKillUnjust, textParam("name", v.name)))
		} else {
			a.emit(systemMsg(msgPvPKill, textParam("name", v.name)))
		}
		var warID int64
		if war != nil {
			warID = war.id
			if !slices.Contains(wars[:nw], war) {
				wars[nw], scorers[nw] = war, a
				nw++
			}
		}
		w.log.Info("pvp kill", "killer", a.charID, "victim", v.charID, "justified", !unjust, "arena", h.arena,
			"war", warID, "x", v.pos.X, "y", v.pos.Y, "z", v.pos.Z)
	}
	if arena {
		v.hitBy = slices.DeleteFunc(v.hitBy, func(h pvpHit) bool { return h.arena })
	} else {
		v.hitBy = v.hitBy[:0]
	}
	if last == nil {
		return false
	}
	// One death is one kill in each war it was part of (after every attacker was judged:
	// a war that ends now does not change how the others counted).
	for i := range nw {
		w.warKill(ctx, wars[i], scorers[i])
	}
	if v.Knows(last.id) {
		v.emit(systemMsg(msgPvPKilledBy, textParam("name", last.name)))
	} else {
		v.emit(systemMsg(msgPvPKilledUnseen)) // an invisible killer stays unnamed
	}
	return arena
}

// unjustKill counts an unjustified kill of a: the kill lock, and the murderer or outlaw
// skull when a window reaches its threshold (a new kill renews the mark's time).
func (w *World) unjustKill(ctx *game.TickContext, a *Player) {
	now := ctx.Now
	a.lockUntil = max(a.lockUntil, ctx.Tick+w.pvpKillLock)
	a.unjust = pruneUnjust(append(a.unjust, now), now.Add(-w.unjustKeep))
	mark := pb.Skull_SKULL_UNSPECIFIED
	switch {
	case reached(a.unjust, now, w.pvp.Outlaw.Windows):
		mark = pb.Skull_SKULL_OUTLAW
	case reached(a.unjust, now, w.pvp.Murderer.Windows):
		mark = pb.Skull_SKULL_MURDERER
	}
	if a.mark != pb.Skull_SKULL_UNSPECIFIED && now.Before(a.markUntil) {
		mark = max(mark, a.mark) // a mark never goes down with a new kill
	}
	if mark == pb.Skull_SKULL_UNSPECIFIED {
		return
	}
	hours := w.pvp.Murderer.Hours
	if mark == pb.Skull_SKULL_OUTLAW {
		hours = w.pvp.Outlaw.Hours
	}
	before := a.skull
	a.mark, a.markUntil = mark, now.Add(time.Duration(hours)*time.Hour)
	w.refreshSkull(a, now)
	if a.skull > before {
		a.emit(systemMsg(msgPvPSkullGained, contentParam("skull", skullID(a.skull))))
	}
}

// pruneUnjust drops kills at or before since and keeps at most maxUnjust (the newest).
func pruneUnjust(kills []time.Time, since time.Time) []time.Time {
	i := 0
	for i < len(kills) && !kills[i].After(since) {
		i++
	}
	kills = kills[i:]
	if len(kills) > maxUnjust {
		kills = kills[len(kills)-maxUnjust:]
	}
	return slices.Clip(kills)
}

// reached reports whether any window holds at least its kills at now.
func reached(kills []time.Time, now time.Time, windows []content.PvPWindow) bool {
	for _, win := range windows {
		since := now.Add(-time.Duration(win.Hours) * time.Hour)
		n := 0
		for _, k := range kills {
			if k.After(since) {
				n++
			}
		}
		if n >= win.Kills {
			return true
		}
	}
	return false
}

// skullID is the i18n id of a skull (client.skull.<id>).
func skullID(s pb.Skull) string {
	switch s {
	case pb.Skull_SKULL_AGGRESSOR:
		return "aggressor"
	case pb.Skull_SKULL_MURDERER:
		return "murderer"
	case pb.Skull_SKULL_OUTLAW:
		return "outlaw"
	}
	return "none"
}

// deathDrop raises the death penalty's drop chances for a player with a mark.
func (w *World) deathDrop(now time.Time, p *Player, equipment, backpack float64) (float64, float64) {
	if !w.pvpOn || p.mark == pb.Skull_SKULL_UNSPECIFIED || !now.Before(p.markUntil) {
		return equipment, backpack
	}
	m := w.pvp.Murderer
	if p.mark == pb.Skull_SKULL_OUTLAW {
		m = w.pvp.Outlaw
	}
	return max(equipment, m.EquipmentDropPct), max(backpack, m.BackpackDropPct)
}

// pvpDied clears what a death ends: the aggressor skull, the attackers remembered and
// every player's attack on v.
// After an arena defeat (arena) the aggressor skull, the locks and the attacks from
// outside the arena stay: losing a duel is not a way out of a fight.
func (w *World) pvpDied(now time.Time, v *Player, arena bool) {
	if !w.pvpOn {
		return
	}
	if !arena {
		v.aggrUntil = time.Time{}
		v.hitBy = v.hitBy[:0]
	}
	v.ptarget = nil
	for _, o := range w.players {
		if o.ptarget == v {
			o.ptarget = nil
		}
	}
	w.refreshSkull(v, now)
}

// ---- staff ------------------------------------------------------------------------

// cmdUnskull is "/unskull Name": a GM removes an online player's skull and forgets its
// unjustified kills (audited).
func (w *World) cmdUnskull(ctx *game.TickContext, p *Player, args []string) bool {
	if len(args) == 0 {
		return false
	}
	name := strings.Join(args, " ")
	t := w.onlineByName(name)
	switch {
	case t == nil:
		p.emit(systemMsg(msgGMOffline, textParam("name", name)))
		w.audit(ctx, p, "remove_skull", nil, map[string]string{"target": name}, auditOffline)
	case t.role >= p.role && t != p:
		p.emit(systemMsg(msgGMProtected, textParam("name", t.name)))
		w.audit(ctx, p, "remove_skull", t, nil, AdminProtected)
	default:
		was := skullID(t.skull)
		t.mark, t.markUntil, t.aggrUntil, t.unjust = pb.Skull_SKULL_UNSPECIFIED, time.Time{}, time.Time{}, nil
		w.refreshSkull(t, ctx.Now)
		p.emit(systemMsg(msgGMSkullRemoved, textParam("name", t.name)))
		if t != p {
			t.emit(systemMsg(msgPvPSkullRemovedGM))
		}
		w.audit(ctx, p, "remove_skull", t, map[string]string{"skull": was}, auditOK)
	}
	return true
}

// ---- link-dead --------------------------------------------------------------------

// linkDeadOnLeave keeps p in the world when its connection closes while its PvP lock
// lasts (docs/02 "Bloqueo de combate PvP"): link-dead, it does nothing but can still be
// attacked (which renews the lock) until the lock ends; checkPvP then saves it and takes it
// out. It reports whether p stays. A new login of the character takes it over (join).
func (w *World) linkDeadOnLeave(tick game.Tick, p *Player) bool {
	if !w.pvpOn || p.linkDead || !w.pvpLocked(tick, p) {
		return false
	}
	p.linkDead = true
	p.target, p.ptarget = nil, nil
	p.stopWalk()
	p.out = p.out[:0]
	w.linkDead = append(w.linkDead, p)
	w.log.Info("pvp link-dead", "character", p.charID)
	return true
}

// LinkDead reports whether p lost its connection and stays in the world for its PvP lock.
func (p *Player) LinkDead() bool { return p.linkDead }

// pvpCarry is what a new login takes over from the player it replaces: the locks and the
// recent attacks on it (the rest travels in the Character).
func (w *World) pvpCarry(from, to *Player) {
	to.lockUntil, to.fightUntil = from.lockUntil, from.fightUntil
	to.hitBy = append(to.hitBy[:0], from.hitBy...)
	to.aggrUntil = from.aggrUntil
}
