package session_test

import (
	"math"
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// TestEveryObjectiveMarkHoldsARealTarget walks every step of every quest of data/ on the
// real map (with the sandbox island, where its own quests happen): the circle the minimap
// gets, for several characters standing in several places, always holds a whole real
// target of the step (the spawn area of the monster to kill or of one that drops the item
// to collect, the NPC to talk to, a tile to stand on of the place to reach, the sigil
// plates), never centred on it, and no step is left without a place. The targets are read
// from the map and data/ here, not from the session's locator (owner, 2026-11-25: a mark
// must never point where the objective is not).
//
// It walks them twice: on the development map, and on the map production runs (without
// the sandbox island), where a step must not lean on a target only the sandbox has. The
// sandbox's own quests (a step whose every target is on a dev island) are left out there.
func TestEveryObjectiveMarkHoldsARealTarget(t *testing.T) {
	var sandbox map[string]bool
	t.Run("dev", func(t *testing.T) { sandbox = walkObjectiveMarks(t, true, nil) })
	if len(sandbox) == 0 {
		t.Fatal("no quest of the sandbox island found: is it still dev_only?")
	}
	t.Run("production", func(t *testing.T) { walkObjectiveMarks(t, false, sandbox) })
}

// walkObjectiveMarks checks the mark of every step of every quest but skip on the map
// built with or without the dev islands, and returns the quests that have a step whose
// every target is on a dev island.
func walkObjectiveMarks(t *testing.T, dev bool, skip map[string]bool) map[string]bool {
	root := filepath.Join("..", "..", "..")
	m, err := compile.Build(root, compile.Options{DevIslands: dev})
	if err != nil {
		t.Fatal(err)
	}
	npcs, err := content.LoadNPCs(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := dataConfig(t, nil)
	cfg.Map, cfg.NPCs, cfg.Quests = m, npcs, realQuests(t)
	w, err := session.New(cfg)
	if err != nil {
		t.Fatal(err)
	}

	type area struct {
		c   world.Pos
		r   int
		dev bool // on a dev island
	}
	spawnsOf := func(want func(monster string) bool) []area {
		var out []area
		for _, is := range m.Islands() {
			for _, sp := range is.Spawns {
				for _, sm := range sp.Monsters {
					if sm.Count > 0 && want(sm.Monster) {
						out = append(out, area{sp.Center, int(sp.Radius), is.Dev})
						break
					}
				}
			}
		}
		return out
	}
	npcsWhere := func(want func(*content.NPC) bool) []area {
		var out []area
		for _, is := range m.Islands() {
			for _, pl := range is.NPCs {
				if def := npcs[pl.NPC]; def != nil && want(def) {
					out = append(out, area{pl.Pos, 0, is.Dev})
				}
			}
		}
		return out
	}
	// holds: the whole square of a (its corners) lies inside the circle of h, on its floor.
	holds := func(h *pb.ObjectiveHint, a area) bool {
		c := h.GetCenter()
		if uint32(a.c.Z) != c.GetZ() {
			return false
		}
		for _, k := range [][2]int{{-a.r, -a.r}, {a.r, -a.r}, {-a.r, a.r}, {a.r, a.r}} {
			dx := float64(int(c.GetX()) - int(a.c.X) - k[0])
			dy := float64(int(c.GetY()) - int(a.c.Y) - k[1])
			if math.Hypot(dx, dy) > float64(h.GetRadius())+1e-9 {
				return false
			}
		}
		return true
	}

	// Where the players stand: every temple and the far corners of the map.
	froms := []world.Pos{{X: 0, Y: 0, Z: 7}, {X: 0xFFFF, Y: 0xFFFF, Z: 7}, {X: 2000, Y: 2000, Z: 8}}
	for _, is := range m.Islands() {
		froms = append(froms, is.Temple)
	}
	steps := 0
	devOnly := map[string]bool{}
	for _, q := range cfg.Quests {
		if skip[q.ID] {
			continue
		}
		for i := range q.Steps {
			step := &q.Steps[i]
			steps++
			cw := step.CompleteWhen
			var valid []area
			switch {
			case cw.Kill != nil:
				valid = spawnsOf(func(mon string) bool { return mon == cw.Kill.Monster })
			case cw.HasItem != nil:
				valid = spawnsOf(func(mon string) bool {
					def := cfg.Monsters[mon]
					if def == nil {
						return false
					}
					for _, l := range def.Loot {
						if l.Item == cw.HasItem.Item && l.Chance > 0 {
							return true
						}
					}
					return false
				})
			case cw.DialogAction != nil:
				valid = npcsWhere(func(n *content.NPC) bool { return n.ID == cw.DialogAction.NPC })
			case cw.FlagEquals != nil:
				valid = npcsWhere(func(n *content.NPC) bool {
					for _, node := range n.Dialog.Nodes {
						for _, o := range node.Options {
							for _, a := range o.Action {
								if a.SetFlag != nil && *a.SetFlag == *cw.FlagEquals {
									return true
								}
							}
						}
					}
					return false
				})
			case cw.Sigils != nil:
				valid = []area{{world.Pos{X: uint16(cw.Sigils.X), Y: uint16(cw.Sigils.Y), Z: uint8(cw.Sigils.Z)}, cw.Sigils.Radius, false}}
			}
			onDev := 0
			for _, a := range valid {
				if a.dev {
					onDev++
				}
			}
			if onDev > 0 && onDev == len(valid) {
				devOnly[q.ID] = true
			}
			if cw.Reach == nil && len(valid) == 0 {
				t.Errorf("%s/%s: no place on the map where the step can be done", q.ID, step.ID)
				continue
			}
		places:
			for _, from := range froms {
				for char := int64(1); char <= 40; char++ {
					h := w.HintForTest(char, from, q.ID, step)
					c := h.GetCenter()
					if c == nil || h.GetRadius() == 0 {
						t.Errorf("%s/%s: no mark for a player at %v", q.ID, step.ID, from)
						break places
					}
					ok := cw.Reach != nil && standsInside(m, w, cw.Reach, h)
					for _, a := range valid {
						if !holds(h, a) {
							continue
						}
						ok = true
						if int(c.GetX()) == int(a.c.X) && int(c.GetY()) == int(a.c.Y) {
							t.Errorf("%s/%s: the mark of character %d is centred on the target %v", q.ID, step.ID, char, a.c)
						}
					}
					if !ok {
						t.Errorf("%s/%s: the mark %v r=%d of character %d at %v holds no real target", q.ID, step.ID, c, h.GetRadius(), char, from)
						break places
					}
				}
			}
		}
	}
	if steps < 30 {
		t.Fatalf("only %d steps walked: data/quests not loaded?", steps)
	}
	return devOnly
}

// A flag_equals step is done at the NPC that sets the flag to the value the step waits
// for: one that sets the same key to another value is not a target of its mark.
func TestSetsFlagComparesTheValue(t *testing.T) {
	npc := func(value int64) *content.NPC {
		n := &content.NPC{}
		n.Dialog.Nodes = map[string]*content.DialogNode{"start": {Options: []content.DialogOption{
			{Action: content.Actions{{SetFlag: &content.Flag{Key: "ring", Value: value}}}},
		}}}
		return n
	}
	if !session.SetsFlagForTest(npc(1), "ring", 1) {
		t.Error("the NPC that sets ring = 1 is not a target of flag_equals ring = 1")
	}
	if session.SetsFlagForTest(npc(2), "ring", 1) {
		t.Error("an NPC that sets ring = 2 is a target of flag_equals ring = 1")
	}
	if session.SetsFlagForTest(npc(1), "other", 1) {
		t.Error("an NPC that sets another flag is a target")
	}
}

// standsInside reports whether the circle of h holds a tile a player can stand on that
// completes reach step r.
func standsInside(m *world.Map, w *session.World, r *content.Reach, h *pb.ObjectiveHint) bool {
	c, rad := h.GetCenter(), int(h.GetRadius())
	for dy := -rad; dy <= rad; dy++ {
		for dx := -rad; dx <= rad; dx++ {
			x, y := int(c.GetX())+dx, int(c.GetY())+dy
			if x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF || dx*dx+dy*dy > rad*rad {
				continue
			}
			p := world.Pos{X: uint16(x), Y: uint16(y), Z: uint8(c.GetZ())}
			if m.Walkable(p) && !m.MovesOnStep(p) && w.ReachContainsForTest(r, p) {
				return true
			}
		}
	}
	return false
}
