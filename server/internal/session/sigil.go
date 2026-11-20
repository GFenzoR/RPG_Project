package session

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Milestone quests (docs/02 "Quests de hito"): the last step of one is its sigils step,
// a set of sigil plates (map items with a sigil block) in one room. When every plate has
// a player that counts on it in the same tick (alive, connected, not staff: quest.
// Cooperative) and each meets the requirements (the quest on that step, the plate's
// vocation, the level, the gear), the server moves all of them together to the reward room
// and completes the step for each; if anyone misses something, everyone hears why and
// nobody moves.
//
// Nothing runs per tick for a room nobody stepped on: a step onto a plate, a relocation
// onto one or a login on one marks its room (sigilStep), and checkSigils, in the flush,
// evaluates only the marked ones. One character never holds two plates (one tile each)
// and leaving the world (logout, link-dead) leaves the plate: it no longer counts.

const (
	msgMilestoneWaiting  = "milestone.waiting"
	msgMilestoneNotReady = "milestone.not_ready"
	msgMilestoneBlocked  = "milestone.blocked"
	msgMilestoneStaff    = "milestone.staff"
	msgMilestoneAchieved = "milestone.achieved"
	msgMilestonePlates   = "milestone.plates"
)

// sigilRoom is the plates of one milestone's sigils step, resolved against the map.
type sigilRoom struct {
	quest     *content.Quest
	plates    []world.Pos
	vocations []string // per plate; "" = any
	to        world.Pos
	dirty     bool
}

// initSigils resolves every sigils step: the plates within its radius (the static items
// with a sigil block), as many as the milestone's players, with the vocations it lists (or
// none), on walkable tiles nobody is moved off; the destination a walkable tile of an
// island, no house, no portal entrance. A plate belongs to one milestone only. Anything
// else refuses to start; make validate checks the same (packages/map-format, checkSigils).
func (w *World) initSigils() error {
	w.sigilAt = map[world.Pos]*sigilRoom{}
	w.sigilRooms = nil
	vocs := map[string]bool{}
	for _, v := range w.cfg.Vocations {
		vocs[v.ID] = true
	}
	for _, id := range slices.Sorted(maps.Keys(w.cfg.Quests)) {
		q := w.cfg.Quests[id]
		i := q.SigilsStep()
		if !q.Milestone || i < 0 {
			continue
		}
		for _, v := range q.Requires.Vocations {
			if !vocs[v] {
				return fmt.Errorf("session: milestone %q: unknown vocation %q", id, v)
			}
		}
		s := q.Steps[i].CompleteWhen.Sigils
		c, ok := worldPos(content.Position{X: s.X, Y: s.Y, Z: s.Z})
		if !ok {
			return fmt.Errorf("session: milestone %q: sigils point outside the world", id)
		}
		room := &sigilRoom{quest: q}
		for y := int(c.Y) - s.Radius; y <= int(c.Y)+s.Radius; y++ {
			for x := int(c.X) - s.Radius; x <= int(c.X)+s.Radius; x++ {
				if x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
					continue
				}
				p := world.Pos{X: uint16(x), Y: uint16(y), Z: c.Z}
				for _, num := range w.m.Stack(p) {
					if def := w.byNum[num]; def != nil && def.Sigil != nil {
						room.plates = append(room.plates, p)
						room.vocations = append(room.vocations, def.Sigil.Vocation)
					}
				}
			}
		}
		if err := w.checkSigilRoom(room); err != nil {
			return fmt.Errorf("session: milestone %q: %w", id, err)
		}
		to, ok := worldPos(s.To)
		if !ok || w.m.IslandAt(to) == nil || !w.m.Walkable(to) || w.m.MovesOnStep(to) || w.m.HouseAt(to) != nil {
			return fmt.Errorf("session: milestone %q: sigils destination %d,%d,%d is no walkable tile of an island (outside houses and portal entrances)", id, s.To.X, s.To.Y, s.To.Z)
		}
		room.to = to
		w.sigilRooms = append(w.sigilRooms, room)
		for _, p := range room.plates {
			w.sigilAt[p] = room
		}
	}
	return nil
}

// checkSigilRoom checks the plates found for a milestone against its requirements.
func (w *World) checkSigilRoom(r *sigilRoom) error {
	req := r.quest.Requires
	if len(r.plates) != req.Players {
		return fmt.Errorf("%d sigil plates within its radius, %d players asked", len(r.plates), req.Players)
	}
	got := slices.Clone(r.vocations)
	slices.Sort(got)
	want := slices.Clone(req.Vocations)
	if len(want) == 0 {
		want = make([]string, req.Players)
	}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		return fmt.Errorf("plate vocations %v, requires.vocations %v", r.vocations, req.Vocations)
	}
	for k, p := range r.plates {
		switch {
		case w.sigilAt[p] != nil:
			return fmt.Errorf("plate %d,%d,%d is also one of milestone %q", p.X, p.Y, p.Z, w.sigilAt[p].quest.ID)
		case slices.Index(r.plates, p) != k:
			return fmt.Errorf("two plates on %d,%d,%d", p.X, p.Y, p.Z)
		case !w.m.Walkable(p) || w.m.MovesOnStep(p) || w.m.HouseAt(p) != nil:
			return fmt.Errorf("plate %d,%d,%d is no tile a player stands on", p.X, p.Y, p.Z)
		}
	}
	return nil
}

// sigilStep marks the room of the plate p now stands on, if any (after a step, a
// relocation or the login).
func (w *World) sigilStep(p *Player) {
	if len(w.sigilAt) == 0 {
		return
	}
	if r := w.sigilAt[p.pos]; r != nil {
		r.dirty = true
	}
}

// hasGear reports whether p meets gear (nil: no requirement).
func (w *World) hasGear(p *Player, g *content.Gear) bool {
	switch {
	case g == nil:
		return true
	case g.Weapon != "":
		for _, s := range []pb.EquipmentSlot{pb.EquipmentSlot_EQUIPMENT_SLOT_RIGHT_HAND, pb.EquipmentSlot_EQUIPMENT_SLOT_LEFT_HAND} {
			if it := p.equip[s]; it != nil && it.def.Weapon != nil && it.def.Weapon.Type == g.Weapon {
				return true
			}
		}
		return false
	case g.Equipped:
		for _, it := range p.equip {
			if it != nil && it.def.ID == g.Item {
				return true
			}
		}
		return false
	}
	found := false
	p.eachCarried(true, func(it *Item) {
		if it.def.ID == g.Item {
			found = true
		}
	})
	return found
}

// candidate is what quest.Cooperative needs to know of p for milestone q.
func (w *World) candidate(p *Player, q *content.Quest) *quest.Candidate {
	return &quest.Candidate{
		Name:     p.name,
		Level:    p.level,
		Vocation: p.vocation.ID,
		Staff:    isStaff(p),
		Alive:    p.health > 0,
		Online:   !p.linkDead && w.byClient[p.client] == p,
		HasGear:  w.hasGear(p, q.Requires.Gear),
		OnStep:   w.quests.OnSigils(p.storage, q.ID),
	}
}

// occupants returns who stands on each plate of r (nil: nobody) and their candidates.
func (w *World) occupants(r *sigilRoom) ([]*Player, []*quest.Candidate) {
	ps := make([]*Player, len(r.plates))
	cs := make([]*quest.Candidate, len(r.plates))
	for i, pos := range r.plates {
		if p := w.creatureAt(pos); p != nil {
			ps[i], cs[i] = p, w.candidate(p, r.quest)
		}
	}
	return ps, cs
}

// checkSigils evaluates the rooms someone stepped onto this tick (in the flush, after
// every command: who stands where is final for the tick).
func (w *World) checkSigils(ctx *game.TickContext) {
	for _, r := range w.sigilRooms {
		if r.dirty {
			r.dirty = false
			w.evalSigils(ctx, r)
		}
	}
}

// evalSigils is checkSigils for one room.
func (w *World) evalSigils(ctx *game.TickContext, r *sigilRoom) {
	ps, cs := w.occupants(r)
	o := quest.Cooperative(r.quest, r.vocations, cs)
	var on []*Player // the ones that count, in plate order
	for i, p := range ps {
		switch {
		case p == nil:
		case cs[i].Counts():
			on = append(on, p)
		case cs[i].Staff:
			p.emit(systemMsg(msgMilestoneStaff))
		}
	}
	qp := &pb.TextParam{Name: "quest", Value: &pb.TextParam_ContentId{ContentId: r.quest.ID}}
	if !o.Full {
		for _, p := range on {
			p.emit(systemMsg(msgMilestoneWaiting, qp, num("count", o.Occupied), num("total", len(r.plates))))
		}
		return
	}
	if !o.Done {
		var missing []string
		for i, f := range o.Fails {
			if f != quest.FailNone {
				missing = append(missing, ps[i].name)
				ps[i].emit(systemMsg(f.Key(), qp))
			}
		}
		for i, f := range o.Fails {
			if f == quest.FailNone {
				ps[i].emit(systemMsg(msgMilestoneNotReady, qp, textParam("names", strings.Join(missing, ", "))))
			}
		}
		return
	}
	// Everyone qualifies: where each one lands, all of them or nobody.
	dest := make([]world.Pos, len(on))
	taken := map[world.Pos]bool{}
	skip := world.FlagBlocksMovement | world.FlagPortalStep | world.FlagHouse
	for i, p := range on {
		to, ok := w.searchRings(r.to, w.arrivalRadius, skip, func(q world.Pos) bool { return w.free(q) && !taken[q] })
		if !ok || ctx.Tick < p.lockUntil && w.inProtection(to) && !w.inProtection(p.pos) {
			for _, o := range on {
				o.emit(systemMsg(msgMilestoneBlocked, qp))
			}
			return
		}
		dest[i], taken[to] = to, true
	}
	names := make([]string, len(on))
	for i, p := range on {
		names[i] = p.name
	}
	for i, p := range on {
		w.relocate(p, dest[i], goneTeleport)
	}
	for _, p := range on {
		w.quests.CompleteSigils(p.storage, r.quest.ID, &questHost{w: w, p: p})
		p.emit(systemMsg(msgMilestoneAchieved, qp, textParam("names", strings.Join(names, ", "))))
	}
}

// lookSigil adds to a Look at pos how many plates of its milestone hold a player that
// counts, if pos is a plate.
func (w *World) lookSigil(p *Player, pos world.Pos) {
	r := w.sigilAt[pos]
	if r == nil {
		return
	}
	_, cs := w.occupants(r)
	n := 0
	for _, c := range cs {
		if c.Counts() {
			n++
		}
	}
	params := []*pb.TextParam{
		{Name: "quest", Value: &pb.TextParam_ContentId{ContentId: r.quest.ID}},
		num("count", n), num("total", len(r.plates)),
	}
	key := msgMilestonePlates
	if v := r.vocations[slices.Index(r.plates, pos)]; v != "" {
		key = msgMilestonePlates + "_vocation"
		params = append(params, &pb.TextParam{Name: "vocation", Value: &pb.TextParam_ContentId{ContentId: v}})
	}
	p.emit(systemMsg(key, params...))
}

// milestoneInfo is the quest log's view of milestone q for p.
func (w *World) milestoneInfo(p *Player, q *content.Quest) *pb.MilestoneInfo {
	r := q.Requires
	m := &pb.MilestoneInfo{
		Title:       q.Title,
		Level:       uint32(max(r.Level, 0)),
		LevelMet:    p.level >= r.Level,
		GearMet:     w.hasGear(p, r.Gear),
		Players:     uint32(max(r.Players, 0)),
		Vocations:   r.Vocations,
		VocationMet: len(r.Vocations) == 0 || slices.Contains(r.Vocations, p.vocation.ID),
	}
	if g := r.Gear; g != nil {
		m.GearWeapon, m.GearEquipped = g.Weapon, g.Equipped
		if def := w.cfg.Items[g.Item]; def != nil {
			m.GearItem = uint32(def.Numeric)
		}
	}
	return m
}

// milestoneMarks is a fingerprint of p's met marks in the quest log: the log goes again
// when it changes (questRecheck, after an inventory change or a level up).
func (w *World) milestoneMarks(p *Player) uint64 {
	var sig uint64
	for i, q := range w.quests.Milestones() {
		if i >= 32 {
			break
		}
		if p.level >= q.Requires.Level {
			sig |= 1 << (2 * i)
		}
		if w.hasGear(p, q.Requires.Gear) {
			sig |= 2 << (2 * i)
		}
	}
	return sig
}
