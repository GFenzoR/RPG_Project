package session_test

import (
	"path/filepath"
	"testing"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// The three milestones of data/ on the real map (docs/02 "Quests de hito"): the right
// group on the plates lands in the reward room, done; the reward room's chest opens; the
// Morvund key opens the gallery gate from the chamber.
func TestMilestonesOnTheMap(t *testing.T) {
	m, err := compile.Compile(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	h := dataHarnessWith(t, func(cfg *session.Config) {
		cfg.Map, cfg.Quests = m, realQuests(t)
		for _, is := range m.Islands() {
			is.Spawns = nil // no monsters: this is about the plates
		}
	})
	at8 := func(x, y int) world.Pos { return world.Pos{X: uint16(x), Y: uint16(y), Z: 8} }
	id := int64(9400)
	type hero struct {
		voc   string
		plate world.Pos
	}
	clients := map[*session.Player]*fakeClient{}
	run := func(q string, level int, to world.Pos, chest string, heroes []hero, worn []session.ItemState,
		gear func(*session.Player)) []*session.Player {
		t.Helper()
		var ps []*session.Player
		for _, hr := range heroes {
			id++
			c := session.Character{ID: id, AccountID: id, Name: "Hero" + hr.voc + q[3:6], Vocation: hr.voc, Level: level,
				Health: 1000, Mana: 100, Inventory: worn}
			cl, p := h.joinFresh(c, world.Pos{X: hr.plate.X, Y: hr.plate.Y + 1, Z: hr.plate.Z})
			h.sim.Command(gameFunc(func() {
				h.w.StartQuestForTest(p, q)
				if gear != nil {
					gear(p)
				}
			}))
			h.sim.Step()
			cl.take()
			clients[p] = cl
			ps = append(ps, p)
		}
		for i, hr := range heroes {
			p, plate := ps[i], hr.plate
			h.sim.Command(gameFunc(func() { h.w.Teleport(p, plate) }))
			h.sim.Step()
		}
		for i, p := range ps {
			if s, _ := h.w.QuestState(p, q); s != quest.Completed || chebyshevPos(p.Pos(), to) > 2 {
				t.Fatalf("%s: hero %d at %v (reward room %v), %v", q, i, p.Pos(), to, s)
			}
		}
		// The chest of the reward room, from where the first one landed.
		def := h.w.ItemForTest(chest)
		cp := chestOf(t, m, def.Numeric, to)
		p := ps[0]
		h.sim.Command(gameFunc(func() { h.w.Teleport(p, nextTo(m, cp)) }))
		h.sim.Step()
		cl := clients[p]
		if evs := h.send(cl, useItem(onTile(cp), uint32(def.Numeric), 1)); !hasKey(evs, "chest.found") {
			t.Fatalf("%s: chest %v", q, systemKeys(evs))
		}
		return ps
	}
	run("ms_thalorn_oath", 20, at8(4224, 6091), "chest_ms_thalorn",
		[]hero{{"guardian", at8(4207, 6090)}, {"druid", at8(4213, 6090)}}, nil, nil)
	amulet := h.w.ItemForTest("antler_amulet")
	run("ms_orthavel_vigil", 25, at8(4191, 6125), "chest_ms_orthavel",
		[]hero{{"ranger", at8(4178, 6125)}},
		[]session.ItemState{{ItemID: amulet.Numeric, Count: 1, Slot: int(pb.EquipmentSlot_EQUIPMENT_SLOT_NECK)}}, nil)
	ps := run("ms_morvund_embers", 35, at8(3668, 5755), "chest_ms_morvund",
		[]hero{{"guardian", at8(3647, 5755)}, {"arcanist", at8(3657, 5755)}, {"ranger", at8(3647, 5761)}, {"druid", at8(3657, 5761)}},
		nil, func(p *session.Player) { h.w.GiveForTest(p, "ember_key", 1) })
	// The gallery gate opens with the key the milestone gave, from the chamber.
	gate := at8(3643, 5758)
	shut := h.w.ItemForTest("morvund_gate")
	p := ps[0]
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, at8(3644, 5758)) }))
	h.sim.Step()
	if evs := h.send(clients[p], useItem(onTile(gate), uint32(shut.Numeric), 1)); !m.Walkable(gate) {
		t.Fatalf("the Morvund gate stays shut with its key: %v", systemKeys(evs))
	}
}

func chebyshevPos(a, b world.Pos) int {
	if a.Z != b.Z {
		return 1 << 20
	}
	return max(absDiff(a.X, b.X), absDiff(a.Y, b.Y))
}

func absDiff(a, b uint16) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

// chestOf is where item num stands within 8 tiles of p.
func chestOf(t *testing.T, m *world.Map, num uint16, p world.Pos) world.Pos {
	t.Helper()
	for y := int(p.Y) - 8; y <= int(p.Y)+8; y++ {
		for x := int(p.X) - 8; x <= int(p.X)+8; x++ {
			q := world.Pos{X: uint16(x), Y: uint16(y), Z: p.Z}
			for _, n := range m.Stack(q) {
				if n == num {
					return q
				}
			}
		}
	}
	t.Fatalf("no item %d near %v", num, p)
	return p
}

// nextTo is a walkable tile next to p that moves nobody on.
func nextTo(m *world.Map, p world.Pos) world.Pos {
	for _, d := range [][2]int{{-1, 0}, {0, 1}, {1, 0}, {0, -1}, {-1, 1}, {1, 1}, {-1, -1}, {1, -1}} {
		q := world.Pos{X: uint16(int(p.X) + d[0]), Y: uint16(int(p.Y) + d[1]), Z: p.Z}
		if m.Walkable(q) && !m.MovesOnStep(q) {
			return q
		}
	}
	return p
}
