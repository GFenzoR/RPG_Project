package session

import (
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/explore"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// The minimap (docs/02 "Minimapa", docs/05 "Minimapa"): what a character has explored and
// the estimate of its tracked objective.
//
// Exploration: every tile of the player's view window (ViewTilesW x ViewTilesH, its own
// floor) is explored when the player lands on a tile (move, relocate, join). The bits live
// in Player.explored (explore.Map), are loaded with the character and saved with its
// snapshots (the sectors that gained bits during the login), so the fog follows the
// character to any device. The client gets the explored sectors' list after Welcome
// (MinimapIndex), asks for the sectors its minimap shows (MinimapRequest, answered with
// the colour item of every explored tile, nothing of the others) and gets the sectors that
// gained bits at most once a second (flushMinimap, bitsets only).
//
// Tracked objective: TrackQuest names one active quest; its current step's place (a
// hint_area of its YAML, or the nearest of the step's real targets, stepTargets: the NPC to
// talk to, a spawn of the monster to kill or of one that drops the item to collect, the
// reach place, the sigil plates) goes to the client as a circle around
// a point near it (quest.FuzzHint), again whenever its quests change or a relocation
// (stairs, a teleport, a boat, waking up at the temple) may have changed which place is
// the nearest (hintMoved).

const (
	// minimapDeltaEvery is how often the sectors that gained bits go to the client.
	minimapDeltaEvery = game.Tick(20) // 1 s
	// MaxMinimapRequestSectors is how many sectors one MinimapRequest may ask for.
	MaxMinimapRequestSectors = 16
	// minimapBudget is how many sectors a client may ask for in a burst, refilled at
	// minimapRefill sectors a second: a sector costs up to 1024 tile reads in the tick
	// (BenchmarkMinimapRequestBurst: the whole budget in one tick is ~0.7 ms). A minimap at
	// its widest shows 36 sectors, asked 16 at a time as the answers arrive.
	minimapBudget = 32
	minimapRefill = 32
)

// exploreView explores the tiles p sees from where it stands now (its own floor).
func (p *Player) exploreView() {
	if p.explored == nil {
		return
	}
	x, y := int(p.pos.X), int(p.pos.Y)
	p.explored.Reveal(x-ViewTilesW/2, y-ViewTilesH/2, x+ViewTilesW/2, y+ViewTilesH/2, p.pos.Z)
}

// loadExplored builds p's explored map from what its login carries.
func loadExplored(c Character) *explore.Map {
	m := explore.Load(c.Explored)
	// A state carried over from a login whose last save may not be written yet: the next
	// snapshot writes those sectors again.
	m.Merge(c.ExploredUnsaved)
	return m
}

// minimapIndex is the MinimapIndex of p: every floor's explored sectors.
func (p *Player) minimapIndex() *pb.ServerMessage {
	idx := &pb.MinimapIndex{}
	for _, z := range p.explored.Floors() {
		f := &pb.MinimapFloorIndex{Z: uint32(z)}
		for _, k := range p.explored.Keys(z) {
			f.Sectors = append(f.Sectors, k.Wire())
		}
		idx.Floors = append(idx.Floors, f)
	}
	return &pb.ServerMessage{Message: &pb.ServerMessage_MinimapIndex{MinimapIndex: idx}}
}

// flushMinimap sends p the sectors that gained explored tiles, at most once a second.
func (w *World) flushMinimap(tick game.Tick, p *Player) {
	if p.explored == nil || tick < p.minimapAt {
		return
	}
	keys := p.explored.TakePending()
	if len(keys) == 0 {
		return
	}
	p.minimapAt = tick + minimapDeltaEvery
	msg := &pb.MinimapSectors{Sectors: make([]*pb.MinimapSector, 0, len(keys))}
	for _, k := range keys {
		s := p.explored.Sector(k)
		if s == nil {
			continue
		}
		msg.Sectors = append(msg.Sectors, &pb.MinimapSector{Z: uint32(k.Z()), Sector: k.Wire(), Explored: append([]byte(nil), s[:]...)})
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_MinimapSectors{MinimapSectors: msg}})
}

// minimapRequest answers a MinimapRequest: the explored tiles of the sectors asked for,
// on p's own floor, within p's request budget (a request over it is dropped: the client
// asks again for what it still lacks).
func (w *World) minimapRequest(tick game.Tick, p *Player, m *pb.MinimapRequest) {
	if p.explored == nil || m.GetZ() != uint32(p.pos.Z) {
		return
	}
	ids := m.GetSectors()
	if len(ids) == 0 || len(ids) > MaxMinimapRequestSectors {
		return
	}
	p.refillMinimapBudget(tick)
	if p.minimapBudget < len(ids) {
		return
	}
	p.minimapBudget -= len(ids)
	z := p.pos.Z
	out := &pb.MinimapSectors{Answer: true}
	seen := make(map[explore.Key]bool, len(ids))
	for _, id := range ids {
		k, ok := explore.FromWire(z, id)
		if !ok || seen[k] {
			continue
		}
		seen[k] = true
		out.Sectors = append(out.Sectors, w.minimapSector(p, k))
	}
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_MinimapSectors{MinimapSectors: out}})
}

// refillMinimapBudget refills p's request budget by the ticks since its last refill:
// minimapRefill sectors a second, exactly (the fraction of a sector a tick leaves is kept
// for the next one, so requests on consecutive ticks do not round it away).
func (p *Player) refillMinimapBudget(tick game.Tick) {
	if tick <= p.minimapBudgetAt {
		return
	}
	perSecond := int(time.Second / game.TickDuration)
	acc := int(min(tick-p.minimapBudgetAt, game.Tick(minimapBudget*perSecond)))*minimapRefill + p.minimapBudgetRem
	p.minimapBudgetAt = tick
	p.minimapBudget += acc / perSecond
	p.minimapBudgetRem = acc % perSecond
	if p.minimapBudget >= minimapBudget {
		p.minimapBudget, p.minimapBudgetRem = minimapBudget, 0
	}
}

// minimapSector is sector k as p has explored it: the colour item of each explored tile.
func (w *World) minimapSector(p *Player, k explore.Key) *pb.MinimapSector {
	ms := &pb.MinimapSector{Z: uint32(k.Z()), Sector: k.Wire()}
	s := p.explored.Sector(k)
	if s == nil {
		return ms
	}
	ms.Explored = append([]byte(nil), s[:]...)
	tiles := make([]byte, explore.SectorSize*explore.SectorSize)
	index := map[uint16]byte{}
	x0, y0 := k.SX()*explore.SectorSize, k.SY()*explore.SectorSize
	for ly := range explore.SectorSize {
		for lx := range explore.SectorSize {
			if !s.Has(lx, ly) {
				continue
			}
			id := w.minimapItem(world.Pos{X: uint16(x0 + lx), Y: uint16(y0 + ly), Z: k.Z()})
			if id == 0 {
				continue
			}
			i, ok := index[id]
			if !ok {
				if len(ms.Palette) >= 255 {
					continue // a sector has far fewer distinct items; never past one byte
				}
				ms.Palette = append(ms.Palette, uint32(id))
				i = byte(len(ms.Palette))
				index[id] = i
			}
			tiles[ly*explore.SectorSize+lx] = i
		}
	}
	if len(ms.Palette) > 0 {
		ms.Tiles = tiles
	}
	return ms
}

// minimapItem is the item a minimap colours tile pos by: the topmost map item that blocks
// movement (a wall, a tree, a rock), else the ground; 0 for no tile.
func (w *World) minimapItem(pos world.Pos) uint16 {
	ground, flags, ok := w.m.Tile(pos)
	if !ok {
		return 0
	}
	stack := w.m.Stack(pos)
	for i := len(stack) - 1; i >= 0; i-- {
		if def := w.byNum[stack[i]]; def != nil && def.BlocksMovement() {
			return stack[i]
		}
	}
	if flags&world.FlagBlocksMovement != 0 && len(stack) > 0 {
		return stack[len(stack)-1] // a blocking tile whose items are not in data/: the top one
	}
	return ground
}

// ---- tracked objective ---------------------------------------------------------------

// trackQuest runs a TrackQuest: track quest id (if p has it in progress) or nothing.
func (w *World) trackQuest(p *Player, id string) {
	if len(id) > 64 || id != "" && w.quests.CurrentStep(p.storage, id) == nil {
		id = ""
	}
	p.tracked = id
	p.hintStale = true
	p.hintForce = true
}

// flushHint sends p's ObjectiveHint when its tracked quest or that quest's step changed.
func (w *World) flushHint(p *Player) {
	if !p.hintStale {
		return
	}
	p.hintStale = false
	h := &pb.ObjectiveHint{}
	if p.tracked != "" {
		step := w.quests.CurrentStep(p.storage, p.tracked)
		if step == nil {
			p.tracked = "" // done, or abandoned: nothing to track
		} else {
			h = w.hintOf(p.charID, p.pos, p.tracked, step)
		}
	}
	key := hintKey{quest: h.GetQuestId(), step: h.GetStepId(), x: h.GetCenter().GetX(), y: h.GetCenter().GetY(),
		z: h.GetCenter().GetZ(), r: h.GetRadius()}
	if key == p.hintSent && !p.hintForce {
		return
	}
	p.hintForce = false
	p.hintSent = key
	p.emit(&pb.ServerMessage{Message: &pb.ServerMessage_ObjectiveHint{ObjectiveHint: h}})
}

// hintOf is the ObjectiveHint of step of questID for character charID standing at from:
// the circle around the nearest of the step's targets, or no centre for a step with no
// place on this map.
func (w *World) hintOf(charID int64, from world.Pos, questID string, step *content.QuestStepDef) *pb.ObjectiveHint {
	c, r, ok := w.stepPlace(from, step)
	if !ok {
		return &pb.ObjectiveHint{QuestId: questID, StepId: step.ID}
	}
	fz := quest.FuzzHint(int(c.X), int(c.Y), r, quest.HintSeed(charID, questID, step.ID, int(c.X), int(c.Y), int(c.Z)))
	return &pb.ObjectiveHint{QuestId: questID, StepId: step.ID,
		Center: &pb.Position{X: hintCoord(fz.X, int(c.X)), Y: hintCoord(fz.Y, int(c.Y)), Z: uint32(c.Z)},
		Radius: uint32(fz.Radius)}
}

// hintCoord is a fuzzed coordinate v of a target at t, kept on the map: one that fell off
// its edge is mirrored to the other side of the target (the same distance from it, so the
// target stays inside the circle), not clamped, which could land on the target itself.
func hintCoord(v, t int) uint32 {
	if v < 0 || v > 0xFFFF {
		v = 2*t - v
	}
	return uint32(max(min(v, 0xFFFF), 0))
}

// hintMoved marks p's hint to compute again after a relocation: the nearest spawn of a
// kill step and the floor of a reach zone depend on where p stands. Walking does not (a
// scan of the map's spawns per step would be too much): on the same floor the estimate is
// the nearest to where p last changed floor, tracked the quest or advanced it.
func (p *Player) hintMoved() {
	if p.tracked != "" {
		p.hintStale = true
	}
}

// hintKey is what an ObjectiveHint said, to send it only when it changes.
type hintKey struct {
	quest, step string
	x, y, z, r  uint32
}

// hintTarget is one place where a step can be done: a point and how many tiles
// (Chebyshev) around it.
type hintTarget struct {
	c world.Pos
	r int
}

// maxTargetRadius bounds the area of one target: a wider place (a zone that covers half
// an island) is marked by the part of it around its anchor, so the circle stays readable
// and still holds tiles where the step is done.
const maxTargetRadius = quest.MaxHintRadius / 2

// stepPlace is where a player at from does step: the nearest of its targets (its own floor
// first; stepTargets), a point and how many tiles (Chebyshev) around it. ok is false for a step with
// no place on this map.
func (w *World) stepPlace(from world.Pos, step *content.QuestStepDef) (world.Pos, int, bool) {
	best, bestD, found := hintTarget{}, 0, false
	for _, t := range w.stepTargets(step) {
		d := chebyshev(from, t.c) + absInt(int(from.Z)-int(t.c.Z))*1_000_000
		if !found || d < bestD {
			best, bestD, found = t, d, true
		}
	}
	return best.c, best.r, found
}

// stepTargets is every place where step can be done, each one a real target: a hint_area
// of the YAML wins; otherwise the NPC to talk to, every spawn of the monster to kill,
// every spawn of a monster that drops the item to collect, the NPC whose dialog sets the
// flag, the reach place (each rectangle of a zone with a tile to stand on, on each of its
// floors) or the sigil plates. Nothing of it changes after the world starts (spawns, NPCs
// and zones are the map's), so it is worked out once per step.
func (w *World) stepTargets(step *content.QuestStepDef) []hintTarget {
	if ts, ok := w.hintTargets[step]; ok {
		return ts
	}
	ts := w.findTargets(step)
	if w.hintTargets == nil {
		w.hintTargets = map[*content.QuestStepDef][]hintTarget{}
	}
	w.hintTargets[step] = ts
	return ts
}

func (w *World) findTargets(step *content.QuestStepDef) []hintTarget {
	if a := step.HintArea; a != nil {
		if c, ok := worldPos(content.Position{X: a.X, Y: a.Y, Z: a.Z}); ok {
			return []hintTarget{{c, a.Radius}}
		}
		return nil
	}
	var ts []hintTarget
	cw := step.CompleteWhen
	switch {
	case cw.DialogAction != nil:
		// An NPC stands where the map placed it for good (npc.go): its place never moves.
		for _, n := range w.npcs {
			if n.def.ID == cw.DialogAction.NPC {
				ts = append(ts, hintTarget{n.pos, 1})
			}
		}
	case cw.FlagEquals != nil:
		for _, n := range w.npcs {
			if setsFlag(n.def, cw.FlagEquals.Key) {
				ts = append(ts, hintTarget{n.pos, 1})
			}
		}
	case cw.Kill != nil:
		ts = w.spawnTargets(func(monster string) bool { return monster == cw.Kill.Monster })
	case cw.HasItem != nil:
		ts = w.spawnTargets(func(monster string) bool {
			k := w.kinds[monster]
			if k == nil {
				return false
			}
			for _, l := range k.def.Loot {
				if l.Item == cw.HasItem.Item && l.Chance > 0 {
					return true
				}
			}
			return false
		})
	case cw.Reach != nil:
		pl := w.reachAt[cw.Reach]
		if pl == nil {
			break
		}
		if pl.zone == nil {
			ts = append(ts, hintTarget{pl.center, pl.radius})
			break
		}
		for _, f := range pl.zone.Floors {
			for _, r := range pl.zone.Rects {
				x0, y0 := int(r.X), int(r.Y)
				x1, y1 := x0+int(r.W)-1, y0+int(r.H)-1
				// The anchor: the tile to stand on nearest the rectangle's middle.
				if c, ok := w.standNear(x0, y0, x1, y1, f); ok {
					ts = append(ts, hintTarget{c, min(max(x1-x0, y1-y0)/2+1, maxTargetRadius)})
				}
			}
		}
	case cw.Sigils != nil:
		if c, ok := worldPos(content.Position{X: cw.Sigils.X, Y: cw.Sigils.Y, Z: cw.Sigils.Z}); ok {
			ts = append(ts, hintTarget{c, cw.Sigils.Radius})
		}
	}
	return ts
}

// setsFlag reports whether an option of npc's dialog sets flag key.
func setsFlag(npc *content.NPC, key string) bool {
	for _, node := range npc.Dialog.Nodes {
		for _, o := range node.Options {
			for _, a := range o.Action {
				if a.SetFlag != nil && a.SetFlag.Key == key {
					return true
				}
			}
		}
	}
	return false
}

// standNear is the tile of the rectangle x0, y0 to x1, y1 on floor z a player can stand
// on (as standable) nearest its middle.
func (w *World) standNear(x0, y0, x1, y1 int, z uint8) (world.Pos, bool) {
	mx, my := (x0+x1)/2, (y0+y1)/2
	best, bestD, found := world.Pos{}, 0, false
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			d := max(absInt(x-mx), absInt(y-my))
			if found && d >= bestD || x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
				continue
			}
			if p := (world.Pos{X: uint16(x), Y: uint16(y), Z: z}); w.m.Walkable(p) && !w.m.MovesOnStep(p) {
				best, bestD, found = p, d, true
			}
		}
	}
	return best, found
}

// spawnTargets is the area of every spawn that keeps a monster want accepts.
func (w *World) spawnTargets(want func(monster string) bool) []hintTarget {
	var ts []hintTarget
	for _, is := range w.m.Islands() {
		for _, sp := range is.Spawns {
			for _, m := range sp.Monsters {
				if m.Count > 0 && want(m.Monster) {
					ts = append(ts, hintTarget{sp.Center, int(sp.Radius)})
					break
				}
			}
		}
	}
	return ts
}
