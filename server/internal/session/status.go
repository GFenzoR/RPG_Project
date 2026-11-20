package session

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Statuses (docs/02 "Estados del personaje"): what the player's own client shows in its
// status tray besides its conditions, sent in the same PlayerConditions with ids that are
// not balance.yaml conditions:
//   - in_combat: the logout block of a fight (inCombat, linkdead.go), with the time until
//     the player may log out again;
//   - pvp_locked: an attacker's PvP lock (lockUntil, pvp.go): no protection zone and no
//     logout until it ends;
//   - protection_zone: the player stands in a protection zone (remaining_ms 0: no end).
//
// They are not conditions: no scheduler event, nothing saved, nothing an attack or a cure
// touches. sendConditions reads them from the player at flush, one map lookup and a few
// comparisons per player and tick (docs/07), and sends the list again only when one starts
// or ends, or when an end moved statusSlack or more from what the client was told.

const (
	statusInCombat   = "in_combat"
	statusPvPLocked  = "pvp_locked"
	statusProtection = "protection_zone"
)

// statusIDs are the ids the statuses take in PlayerConditions: no balance.yaml condition
// may use one (initConditions).
var statusIDs = []string{statusInCombat, statusPvPLocked, statusProtection}

// statusSlack is how far an end may move before the client is told again: a fight moves
// the logout block's end at every hit, and this caps it at one message a second. The
// client counts down what it was told, so its icon may end up to this much early (or
// late): the list without it comes on the tick the block really ends.
const statusSlack = game.Tick(20) // 1 s

// statusView is what a player's statuses are, or what its client was last told: the
// tick each timed one ends (0 = none) and whether it stands in a protection zone.
type statusView struct {
	fight game.Tick // the logout block (in_combat)
	lock  game.Tick // the attacker's PvP lock (pvp_locked)
	zone  bool
}

// checkStatusIDs refuses a balance.yaml condition with the id of a status.
func checkStatusIDs(cs content.ConditionDefs) error {
	for _, id := range statusIDs {
		if _, ok := cs[id]; ok {
			return fmt.Errorf("session: condition %q: the id belongs to a status the server sends itself (status.go)", id)
		}
	}
	return nil
}

// statusOf is p's statuses at tick now.
func (w *World) statusOf(now game.Tick, p *Player) statusView {
	var s statusView
	if end := w.combatEnd(p); end > now {
		s.fight = end
	}
	if p.lockUntil > now {
		s.lock = p.lockUntil
	}
	s.zone = w.inProtection(p.pos)
	return s
}

// combatEnd is the first tick p is out of combat (inCombat is now < combatEnd): its last
// fight plus travel.combat_block_ms, or the end of its PvP locks if later.
func (w *World) combatEnd(p *Player) game.Tick {
	end := max(p.lockUntil, p.fightUntil)
	if p.fightAt > 0 {
		end = max(end, p.fightAt+w.fightFor)
	}
	return end
}

// stale reports whether a client told `told` must hear of `s`: a status started or ended,
// or an end moved statusSlack or more.
func (s statusView) stale(told statusView) bool {
	return s.zone != told.zone || endMoved(s.fight, told.fight) || endMoved(s.lock, told.lock)
}

// count is how many entries s takes in PlayerConditions.
func (s statusView) count() int {
	n := 0
	if s.fight != 0 {
		n++
	}
	if s.lock != 0 {
		n++
	}
	if s.zone {
		n++
	}
	return n
}

func endMoved(end, told game.Tick) bool {
	if (end == 0) != (told == 0) {
		return true
	}
	return end >= told+statusSlack || told >= end+statusSlack
}

// appendStatuses adds s to a PlayerConditions list at tick now, after the conditions.
func appendStatuses(list []*pb.ActiveCondition, s statusView, now game.Tick) []*pb.ActiveCondition {
	tickMs := game.Tick(game.TickDuration.Milliseconds())
	if s.fight > now {
		list = append(list, &pb.ActiveCondition{ConditionId: statusInCombat, RemainingMs: uint32((s.fight - now) * tickMs)})
	}
	if s.lock > now {
		list = append(list, &pb.ActiveCondition{ConditionId: statusPvPLocked, RemainingMs: uint32((s.lock - now) * tickMs)})
	}
	if s.zone {
		list = append(list, &pb.ActiveCondition{ConditionId: statusProtection})
	}
	return list
}
