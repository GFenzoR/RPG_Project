package session_test

import (
	"fmt"
	"path/filepath"
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// floraHarness runs the real map and the real content with no monsters: these tests are
// about where players stand and what they see.
func floraHarness(t *testing.T) (*harness, *world.Map) {
	t.Helper()
	m, err := compile.Compile(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	spells, err := content.LoadSpells(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	h := dataHarnessWith(t, func(cfg *session.Config) {
		cfg.Map, cfg.Quests, cfg.Spells = m, realQuests(t), spells
		for _, is := range m.Islands() {
			is.Spawns = nil
		}
	})
	return h, m
}

// standable reports whether a player stands on p of the street: walkable, no house and no
// entrance of stairs, a hole or a teleport.
func standable(m *world.Map, p world.Pos) bool {
	return m.Walkable(p) && !m.MovesOnStep(p) && m.Flags(p)&world.FlagHouse == 0
}

// between returns the first tile of is holding one of items with ground a player stands
// on to its west, and to its east too if both.
func between(h *harness, m *world.Map, is *world.Island, both bool, items ...string) (on, west, east world.Pos, found bool) {
	var ids []uint16
	for _, id := range items {
		ids = append(ids, h.w.ItemForTest(id).Numeric)
	}
	for _, s := range is.Sectors() {
		for _, st := range s.Stacks {
			if !slices.ContainsFunc(st.Items, func(id uint16) bool { return slices.Contains(ids, id) }) {
				continue
			}
			p := world.Pos{
				X: s.CX*world.SectorSize + st.Index%world.SectorSize,
				Y: s.CY*world.SectorSize + st.Index/world.SectorSize,
				Z: s.Z,
			}
			w, okW := p.Step(world.West)
			e, okE := p.Step(world.East)
			if okW && standable(m, w) && (!both || okE && standable(m, e)) {
				return p, w, e, true
			}
		}
	}
	return on, west, east, false
}

// leave logs cl out and runs the tick that takes its player off the map.
func (h *harness) leave(cl *fakeClient) {
	h.sim.Command(h.w.Leave(cl))
	h.sim.Step()
}

// Bushes are solid (docs/06 "Qué bloquea el paso") on the real map: a step onto one is
// refused, and a character that logged out standing on one, when they were walkable, does
// not wake up inside it but beside it (placement, besideSolid), whatever its town: a
// character of another island is not carried home for free.
func TestBushesAreSolidOnTheMap(t *testing.T) {
	h, m := floraHarness(t)
	id, looked := int64(9700), 0
	islands := m.Islands()
	for i, is := range islands {
		// The first bush of the island with open ground to its west. Where the bushes grow
		// is the map builders' business: an island with none is skipped.
		on, west, _, found := between(h, m, is, false, "bush")
		if !found {
			continue
		}
		looked++
		if m.Walkable(on) || !m.LineOfSight(west, world.Pos{X: on.X + 1, Y: on.Y, Z: on.Z}) {
			t.Fatalf("%s: the bush at %v is walkable or hides what is behind it", is.ID, on)
		}

		// Its own town, and the town of another island.
		for _, town := range []string{is.ID, islands[(i+1)%len(islands)].ID} {
			id++
			saved := session.Character{ID: id, AccountID: id, Name: fmt.Sprintf("Sleeper%d", id), Vocation: "guardian",
				Level: 1, Health: 145, Town: town, HasPos: true, Pos: on}
			cl, p := h.joinChar(saved)
			if got := p.Pos(); got == on || !standable(m, got) || got.Z != on.Z ||
				max(dist(got.X, on.X), dist(got.Y, on.Y)) > 3 || m.IslandAt(got) != is {
				t.Fatalf("%s (town %s): saved on the bush at %v, logged in at %v", is.ID, town, on, got)
			}
			h.leave(cl)
		}

		id++
		beside := session.Character{ID: id, AccountID: id, Name: fmt.Sprintf("Walker%d", id), Vocation: "guardian",
			Level: 1, Health: 145, Town: is.ID, HasPos: true, Pos: west}
		cl, q := h.joinChar(beside)
		if q.Pos() != west {
			t.Fatalf("%s: saved beside the bush at %v, logged in at %v", is.ID, west, q.Pos())
		}
		cl.take()
		h.input(cl, walk(E))
		h.sim.RunTicks(30)
		if rej := find(cl.take(), (*pb.ServerMessage).GetWalkRejected); len(rej) != 1 || q.Pos() != west {
			t.Fatalf("%s: a step onto the bush at %v: %d rejections, now at %v", is.ID, on, len(rej), q.Pos())
		}
		h.leave(cl)
	}
	if looked == 0 {
		t.Fatal("no island has a bush with open ground to its west: the test looked at nothing")
	}
}

// A character saved on a wall (the map changed) still wakes up at its temple: only what is
// low enough to see over was ever ground (besideSolid).
func TestSavedOnAWallGoesToTheTemple(t *testing.T) {
	h, m := floraHarness(t)
	for _, is := range m.Islands() {
		on, _, _, found := between(h, m, is, false, "stone_wall")
		if !found {
			continue
		}
		c := session.Character{ID: 9800, AccountID: 9800, Name: "Mason", Vocation: "guardian", Level: 1,
			Health: 145, Town: is.ID, HasPos: true, Pos: on}
		_, p := h.joinChar(c)
		if got := p.Pos(); max(dist(got.X, is.Temple.X), dist(got.Y, is.Temple.Y)) > 3 || got.Z != is.Temple.Z {
			t.Fatalf("%s: saved on the wall at %v, logged in at %v (temple %v)", is.ID, on, got, is.Temple)
		}
		return
	}
	t.Skip("no stone wall with open ground to its west on the map")
}

// Trees block sight on the real map (docs/06 "Qué bloquea el paso": tall and dense), bushes
// do not: a heal thrown at a friend behind a trunk is refused and heals nothing, the same
// heal over a bush lands, and the tree next to the woodcutter is still cut (the ends of a
// line of sight do not count).
func TestTreesBlockSightOnTheMap(t *testing.T) {
	h, m := floraHarness(t)
	trees := []string{"oak_tree", "pine_tree", "birch_tree", "elm_tree"}
	healer := func(id int64, at world.Pos) (*fakeClient, *session.Player) {
		c := session.Character{ID: id, AccountID: id, Name: fmt.Sprintf("Druid%d", id), Vocation: "druid",
			Level: 20, Health: 200, Mana: 400, HasPos: true, Pos: at,
			Skills: []session.SkillState{{ID: "magic", Level: 10}}}
		return h.joinChar(c)
	}
	// heal casts mend_other from west at a hurt friend on east and returns what the caster
	// heard and the health the friend gained.
	heal := func(id int64, west, east world.Pos) ([]string, int) {
		cl, caster := healer(id, west)
		fcl, friend := healer(id+1, east)
		if caster.Pos() != west || friend.Pos() != east {
			t.Fatalf("joined at %v and %v, want %v and %v", caster.Pos(), friend.Pos(), west, east)
		}
		h.sim.Step()
		friend.SetHealthForTest(50)
		cl.take()
		keys := sysKeys(h.castNow(cl, castAt("mend_other", friend.ID())))
		hp, _ := friend.Health()
		h.leave(cl)
		h.leave(fcl)
		return keys, hp - 50
	}
	var tree, bush, chop bool
	for _, is := range m.Islands() {
		if on, west, east, ok := between(h, m, is, true, trees...); ok && !tree {
			tree = true
			if m.LineOfSight(west, east) {
				t.Fatalf("%s: one sees through the tree at %v", is.ID, on)
			}
			if keys, gained := heal(9900, west, east); !slices.Contains(keys, "magic.no_sight") || gained != 0 {
				t.Fatalf("%s: a heal through the tree at %v: messages %v, healed %d", is.ID, on, keys, gained)
			}
		}
		if on, west, east, ok := between(h, m, is, true, "bush"); ok && !bush {
			bush = true
			if keys, gained := heal(9910, west, east); gained <= 0 {
				t.Fatalf("%s: a heal over the bush at %v: messages %v, healed %d", is.ID, on, keys, gained)
			}
		}
		if on, west, _, ok := between(h, m, is, false, "birch_tree", "elm_tree"); ok && !chop {
			chop = true
			axe := h.w.ItemForTest("felling_axe").Numeric
			c := session.Character{ID: 9920, AccountID: 9920, Name: "Woodcutter", Vocation: "guardian", Level: 1,
				Health: 145, HasPos: true, Pos: west,
				Inventory: []session.ItemState{{ItemID: axe, Count: 1, Slot: int(slotRight)}}}
			cl, p := h.joinChar(c)
			h.sim.Step()
			cl.take()
			h.input(cl, useOn(axe, on))
			h.sim.Step()
			keys := sysKeys(cl.take())
			cut := func(k string) bool { return k == "gather.got" || k == "gather.failed" }
			if p.Pos() != west || !slices.ContainsFunc(keys, cut) {
				t.Fatalf("%s: an axe on the tree at %v from %v: messages %v", is.ID, on, west, keys)
			}
			h.leave(cl)
		}
	}
	if !tree || !bush || !chop {
		t.Fatalf("looked at a tree %v, a bush %v, a tree to cut %v: the map has none between open ground", tree, bush, chop)
	}
}

func dist(a, b uint16) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}
