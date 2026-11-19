package session

import (
	"fmt"
	"maps"
	"slices"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Reach steps and the quest log (docs/06 "Quest", docs/05 "Diario de misiones").
//
// A reach step completes while the player stands in its place: a zone of the map or the
// tiles around a point. Every place is resolved once, when the world starts (initReach);
// each player keeps the places of its current reach steps (Player.reach, read again after
// a quest of it changed) and a bit per floor they are on, so a move or a relocation costs
// one test for a player with none on its floor and nothing runs per tick.
//
// The QuestLog goes in full at the flush of the login tick and of every tick in which a
// quest of the player changed (questHost.Notify marks it): one per tick, the login's too.

// reachPlace is a reach step's place on the map: a zone, or the tiles within radius
// (Chebyshev) of a point.
type reachPlace struct {
	zone   *world.Zone
	center world.Pos
	radius int
	floors uint16 // a bit per floor the place is on
}

func (r *reachPlace) contains(p world.Pos) bool {
	if r.floors&(1<<p.Z) == 0 {
		return false
	}
	if r.zone != nil {
		return r.zone.Contains(p)
	}
	return max(absInt(int(p.X)-int(r.center.X)), absInt(int(p.Y)-int(r.center.Y))) <= r.radius
}

// initReach resolves the place of every reach step of the quests against the map: a zone
// must exist, a point must lie on an island, on a floor it lists, and either must have a
// tile a player can stand on: walkable, and no entrance of stairs, a hole or a teleport (a
// step onto one counts where it lands, move). Anything else refuses to start, and so does
// a repeatable quest that would start with a reach where it is taken
// (content.CheckRepeatable, with near). make validate checks the same, and that such a
// tile is reached on foot from the temple (packages/map-format, checkReachability).
func (w *World) initReach() error {
	w.reachAt = map[*content.Reach]*reachPlace{}
	for _, id := range slices.Sorted(maps.Keys(w.cfg.Quests)) {
		q := w.cfg.Quests[id]
		for _, s := range q.Steps {
			r := s.CompleteWhen.Reach
			if r == nil {
				continue
			}
			pl := &reachPlace{}
			if r.Zone != "" {
				_, z := w.m.Zone(r.Zone)
				if z == nil {
					return fmt.Errorf("session: quest %q step %q: reach zone %q is no zone of the map", id, s.ID, r.Zone)
				}
				pl.zone = z
				for _, f := range z.Floors {
					pl.floors |= 1 << f
				}
			} else {
				c, ok := worldPos(content.Position{X: *r.X, Y: *r.Y, Z: *r.Z})
				if !ok || w.m.IslandAt(c) == nil {
					return fmt.Errorf("session: quest %q step %q: reach point %d,%d,%d is on no island of the map", id, s.ID, *r.X, *r.Y, *r.Z)
				}
				pl.center, pl.radius, pl.floors = c, r.R(), 1<<c.Z
			}
			if !w.standable(pl) {
				return fmt.Errorf("session: quest %q step %q: no tile of the reach place is walkable ground a player can stand on (not the entrance of stairs, a hole or a teleport): the step could never be done", id, s.ID)
			}
			w.reachAt[r] = pl
		}
	}
	if err := content.CheckRepeatable(w.cfg.Quests, w.cfg.NPCs, w.reachNear); err != nil {
		return fmt.Errorf("session: %w", err)
	}
	return nil
}

// standable reports whether pl has a tile a player can stand on: walkable, and a step onto
// it does not move the player elsewhere (world.Map.MovesOnStep). It stops at the first one:
// at most the 33×33 tiles of a point, and a zone of open ground answers at its first tile.
func (w *World) standable(pl *reachPlace) bool {
	ok := func(p world.Pos) bool { return w.m.Walkable(p) && !w.m.MovesOnStep(p) }
	if z := pl.zone; z != nil {
		for _, f := range z.Floors {
			for _, r := range z.Rects {
				for y := int(r.Y); y < int(r.Y)+int(r.H); y++ {
					for x := int(r.X); x < int(r.X)+int(r.W); x++ {
						if ok(world.Pos{X: uint16(x), Y: uint16(y), Z: f}) {
							return true
						}
					}
				}
			}
		}
		return false
	}
	c := pl.center
	for y := int(c.Y) - pl.radius; y <= int(c.Y)+pl.radius; y++ {
		for x := int(c.X) - pl.radius; x <= int(c.X)+pl.radius; x++ {
			if x >= 0 && y >= 0 && x <= 0xFFFF && y <= 0xFFFF && ok(world.Pos{X: uint16(x), Y: uint16(y), Z: c.Z}) {
				return true
			}
		}
	}
	return false
}

// reachNear reports whether the place of reach step r comes within TalkRange of where an
// NPC of kind npc stands (same floor): a player who takes a quest there stands in it
// (content.CheckRepeatable). Only the geometry counts, as in make validate.
func (w *World) reachNear(r *content.Reach, npc string) bool {
	pl := w.reachAt[r]
	if pl == nil {
		return false
	}
	for _, n := range w.npcs {
		p := n.pos
		if n.def.ID != npc || pl.floors&(1<<p.Z) == 0 {
			continue
		}
		x0, y0, x1, y1 := int(p.X)-TalkRange, int(p.Y)-TalkRange, int(p.X)+TalkRange, int(p.Y)+TalkRange
		if z := pl.zone; z != nil {
			for _, zr := range z.Rects {
				if int(zr.X) <= x1 && int(zr.X)+int(zr.W)-1 >= x0 && int(zr.Y) <= y1 && int(zr.Y)+int(zr.H)-1 >= y0 {
					return true
				}
			}
			continue
		}
		if chebyshev(pl.center, p) <= pl.radius+TalkRange {
			return true
		}
	}
	return false
}

// questsChanged marks what a change of p's quests makes stale: the places p's moves are
// checked against and its client's quest log.
func (p *Player) questsChanged() {
	p.reachStale = true
	p.questLogDirty = true
}

// checkReach completes p's current reach steps p now stands in (after a step, a
// relocation or the login). One bit test for a player with no reach step on its floor.
func (w *World) checkReach(p *Player) {
	if p.reachStale {
		p.reachStale = false
		p.reach, p.reachFloors = p.reach[:0], 0
		rs := w.quests.Reaches(p.storage, w.reachBuf[:0])
		for _, r := range rs {
			if pl := w.reachAt[r]; pl != nil {
				p.reach = append(p.reach, pl)
				p.reachFloors |= pl.floors
			}
		}
		w.reachBuf = rs[:0]
	}
	if p.reachFloors&(1<<p.pos.Z) == 0 {
		return
	}
	for _, pl := range p.reach {
		if pl.contains(p.pos) {
			w.quests.Moved(p.storage, &questHost{w: w, p: p})
			return
		}
	}
}

// nowUnix is the loop's clock in unix seconds (repeatable quests).
func (w *World) nowUnix() int64 { return w.nowTime().Unix() }

// questLog is p's QuestLog.
func (w *World) questLog(p *Player) *pb.ServerMessage {
	now := w.nowUnix()
	var entries []*pb.QuestLogEntry
	for _, en := range w.quests.Entries(p.storage) {
		q := en.Quest
		e := &pb.QuestLogEntry{
			QuestId:    q.ID,
			Name:       q.Name,
			Chapter:    uint32(max(q.Chapter, 0)),
			Repeatable: q.Repeatable != nil,
		}
		switch {
		case en.State == quest.InProgress:
			e.State = pb.QuestLogState_QUEST_LOG_STATE_ACTIVE
			if s := en.Step; s != nil {
				e.StepId, e.StepText = s.ID, s.Description
				if k := s.CompleteWhen.Kill; k != nil {
					e.Kills, e.KillsNeeded = uint32(min(max(en.Kills, 0), k.Count)), uint32(k.Count)
				}
			}
		case en.AvailableAt > now:
			e.State = pb.QuestLogState_QUEST_LOG_STATE_COOLING
			e.AvailableAt = uint64(en.AvailableAt) * 1000
		default:
			e.State = pb.QuestLogState_QUEST_LOG_STATE_DONE
			if en.AvailableAt > 0 {
				e.AvailableAt = uint64(en.AvailableAt) * 1000
			}
		}
		entries = append(entries, e)
	}
	return &pb.ServerMessage{Message: &pb.ServerMessage_QuestLog{QuestLog: &pb.QuestLog{Entries: entries}}}
}

// flushQuestLog sends p's QuestLog if a quest of p changed this tick.
func (w *World) flushQuestLog(p *Player) {
	if !p.questLogDirty {
		return
	}
	p.questLogDirty = false
	p.emit(w.questLog(p))
}
