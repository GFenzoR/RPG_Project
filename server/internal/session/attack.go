package session

import (
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Who attacks whom and why a creature leaves the view (docs/05 "Quién ataca y por qué
// sale una criatura", docs/17 ANI-7): the clients animate the attacker's swing, shot or
// cast and a death from these instead of guessing them from effects and health bars.
//   - Every attack that happens (the round is due, the checks passed, the chance rolled)
//     calls attackEvent before its Projectile, Effect and FloatingText: a player's through
//     playerAttack (which first ends its invisibility, as the hit itself would), a
//     monster's in monsterAttacks.
//   - Every CreatureDisappear carries a DisappearReason (disappearMsg). The reason says
//     no more than the viewer already sees: a player that turns invisible leaves as a
//     TELEPORT.
// What reaches each client follows the AOI: only who knows the attacker gets its attack,
// never about a target it must not see (an invisible player), and a target beyond its
// window is only a side of it (edgePoint, as for a Projectile).

// Monster attack types (data/monsters attacks[].type).
const (
	attackMelee    = content.AttackMelee
	attackDistance = content.AttackDistance
	attackSpell    = content.AttackSpell
	attackHealSelf = content.AttackHealSelf
	attackSummon   = content.AttackSummon
)

// monsterAttackKind is the AttackKind of a monster attack of type typ.
func monsterAttackKind(typ string) pb.AttackKind {
	switch typ {
	case attackMelee:
		return pb.AttackKind_ATTACK_KIND_MELEE
	case attackSpell:
		return pb.AttackKind_ATTACK_KIND_SPELL
	default:
		return pb.AttackKind_ATTACK_KIND_RANGED
	}
}

func attackMsg(id uint32, kind pb.AttackKind, target uint32, to world.Pos, radius int) *pb.ServerMessage {
	return &pb.ServerMessage{Message: &pb.ServerMessage_CreatureAttack{CreatureAttack: &pb.CreatureAttack{
		Id: id, Kind: kind, TargetId: target, To: posMsg(to), Radius: uint32(max(radius, 0)),
	}}}
}

// attackEvent tells the clients that know creature id, standing at from, that it attacks:
// the creature target on to (hidden: an invisible player), or with target 0 the area of
// radius around to. A client that does not know the target gets nothing if it sees the
// target's tile or the target is hidden (a blow at an empty tile would give an invisible
// player away), and only the side of it if the target is beyond its window. That side is
// the attacker's own tile when the attacker stands on the window's edge (a blow at a
// creature just beyond it): unlike a Projectile, which drops that case (it would fly
// nowhere), the attack still goes, and the client plays it where the attacker faces (a
// monster turns to its target before it strikes). Every client that knows both gets the
// same message, built once (observeMove explains why that is safe).
func (w *World) attackEvent(id uint32, from world.Pos, kind pb.AttackKind, target uint32, to world.Pos, hidden bool, radius int) {
	var full *pb.ServerMessage
	w.eachObserver(nil, from, func(o *Player) {
		if !o.Knows(id) {
			return // T3.2: an invisible attacker reaches nobody but itself
		}
		if target != 0 && !o.Knows(target) {
			if hidden || Sees(o.pos, to) {
				return
			}
			o.emit(attackMsg(id, kind, 0, edgePoint(o.pos, to, from), 0))
			return
		}
		if full == nil {
			full = attackMsg(id, kind, target, to, radius)
		}
		o.emit(full)
	})
}

// playerAttack is attackEvent for player p attacking f. Attacking ends p's invisibility
// (the hit would end it a moment later): first, so the clients around know p by then.
func (w *World) playerAttack(ctx *game.TickContext, p *Player, kind pb.AttackKind, f foe) {
	w.reveal(ctx, p)
	if f.p != nil {
		w.attackEvent(p.id, p.pos, kind, f.p.id, f.p.pos, f.p.invisible, 0)
		return
	}
	w.attackEvent(p.id, p.pos, kind, f.m.id, f.m.pos, false, 0)
}

// areaAttack is attackEvent for player p casting an area spell of radius r around itself.
func (w *World) areaAttack(ctx *game.TickContext, p *Player, r int) {
	w.reveal(ctx, p)
	w.attackEvent(p.id, p.pos, pb.AttackKind_ATTACK_KIND_SPELL, 0, p.pos, false, r)
}

// monsterAreaEvent is attackEvent for monster m attacking the area of radius r around
// centre (a beam goes as the circle of its length around m: the clients play the cast
// where m faces and push whoever it hurt away from m). A client that knows m but does
// not see the centre (a circle around a target beyond its window) gets only the side of
// it, without the area, as for a target it does not know. An area aimed at a hidden
// target (an invisible player m sees, at the centre of the circle or where the beam
// points) reaches only the clients that see that player: the area would give its tile
// away.
func (w *World) monsterAreaEvent(m *Monster, kind pb.AttackKind, centre world.Pos, r int, hidden *Player) {
	var full *pb.ServerMessage // built once, for every client that sees the centre
	send := func(o *Player) {
		if !o.Knows(m.id) {
			return
		}
		if !Sees(o.pos, centre) {
			o.emit(attackMsg(m.id, kind, 0, edgePoint(o.pos, centre, m.pos), 0))
			return
		}
		if full == nil {
			full = attackMsg(m.id, kind, 0, centre, r)
		}
		o.emit(full)
	}
	if hidden != nil {
		w.eachWatcher(hidden, send)
		return
	}
	w.eachObserver(nil, m.pos, send)
}

// Disappear reasons, shorter.
const (
	goneOutOfView = pb.DisappearReason_DISAPPEAR_REASON_OUT_OF_VIEW
	goneDeath     = pb.DisappearReason_DISAPPEAR_REASON_DEATH
	goneDespawn   = pb.DisappearReason_DISAPPEAR_REASON_DESPAWN
	goneTeleport  = pb.DisappearReason_DISAPPEAR_REASON_TELEPORT
	goneLogout    = pb.DisappearReason_DISAPPEAR_REASON_LOGOUT
)
