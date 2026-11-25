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
	return betweenIDs(m, is, both, nil, ids)
}

// betweenIDs is between by numeric id, for a map no world runs yet; ok, if given, must
// accept the two sides.
func betweenIDs(m *world.Map, is *world.Island, both bool, ok func(west, east world.Pos) bool, ids []uint16) (on, west, east world.Pos, found bool) {
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
			if okW && standable(m, w) && (!both || okE && standable(m, e)) && (ok == nil || ok(w, e)) {
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

// A tree is cover on the real map, a bush is not (docs/02 "Línea de visión"): a monster
// that spits from afar never takes for target the player standing behind a trunk two tiles
// away, and takes the one standing behind a bush.
func TestTreesCoverFromMonstersOnTheMap(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	m, err := compile.Compile(root)
	if err != nil {
		t.Fatal(err)
	}
	items, err := content.LoadItems(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	nums := func(ids ...string) []uint16 {
		var out []uint16
		for _, id := range ids {
			out = append(out, items[id].Numeric)
		}
		return out
	}
	// Both sides outside every protection zone (no monster hunts in one), on plain ground.
	wild := func(west, east world.Pos) bool {
		return m.Flags(west)&world.FlagProtection == 0 && m.Flags(east)&world.FlagProtection == 0
	}
	type place struct {
		is             *world.Island
		on, west, east world.Pos
	}
	find := func(ids []uint16, far *place) (place, bool) {
		for _, is := range m.Islands() {
			ok := func(west, east world.Pos) bool {
				// Out of sight of the other pair: each monster has one player to see.
				return wild(west, east) && (far == nil || west.Z != far.on.Z ||
					max(dist(west.X, far.on.X), dist(west.Y, far.on.Y)) > 40)
			}
			if on, west, east, found := betweenIDs(m, is, true, ok, ids); found {
				return place{is, on, west, east}, true
			}
		}
		return place{}, false
	}
	tree, okT := find(nums("oak_tree", "pine_tree", "birch_tree", "elm_tree"), nil)
	if !okT {
		t.Fatal("no tree between open ground outside the protection zones")
	}
	bush, okB := find(nums("bush"), &tree)
	if !okB {
		t.Fatal("no bush between open ground outside the protection zones")
	}
	spitter := func(id string, at world.Pos) world.Spawn {
		return world.Spawn{ID: id, Center: at, RespawnSeconds: 600,
			Monsters: []world.SpawnMonster{{Monster: "mire_toad", Count: 1}}}
	}
	spells, err := content.LoadSpells(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	h := dataHarnessWith(t, func(cfg *session.Config) {
		cfg.Map, cfg.Quests, cfg.Spells = m, realQuests(t), spells
		for _, is := range m.Islands() {
			is.Spawns = nil
		}
		tree.is.Spawns = append(tree.is.Spawns, spitter("cover_tree", tree.east))
		bush.is.Spawns = append(bush.is.Spawns, spitter("cover_bush", bush.east))
	})
	stand := func(id int64, at world.Pos) *session.Player {
		c := session.Character{ID: id, AccountID: id, Name: fmt.Sprintf("Bait%d", id), Vocation: "guardian",
			Level: 30, Health: 400, HasPos: true, Pos: at}
		_, p := h.joinChar(c)
		if p.Pos() != at {
			t.Fatalf("joined at %v, want %v", p.Pos(), at)
		}
		return p
	}
	hidden, seen := stand(9930, tree.west), stand(9931, bush.west)
	toad := func(at world.Pos) *session.Monster {
		for _, mo := range h.w.Monsters() {
			if mo.Pos() == at {
				return mo
			}
		}
		t.Fatalf("no monster spawned at %v", at)
		return nil
	}
	behindTree, behindBush := toad(tree.east), toad(bush.east)
	hunted := false
	for range 100 { // 5 s
		h.sim.Step()
		if behindTree.TargetID() != 0 {
			t.Fatalf("the monster at %v took a target through the tree at %v", behindTree.Pos(), tree.on)
		}
		hunted = hunted || behindBush.TargetID() == seen.ID()
	}
	if hp, _ := hidden.Health(); hp != 400 {
		t.Fatalf("behind the tree at %v: health %d, want 400", tree.on, hp)
	}
	if !hunted {
		t.Fatalf("the monster at %v never took the player over the bush at %v", bush.east, bush.on)
	}
}

func dist(a, b uint16) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}
