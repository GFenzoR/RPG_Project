package compile

import (
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// TestSolidObjects: what a map object of data/items blocks is what its sprite shows
// (docs/06 "Qué bloquea el paso"). A bush stops feet like a boulder, and like it is low
// enough to see and shoot past; what is tall and dense (a tree, a wall, a closed gate,
// stacked crates, a curtain of vines) also blocks sight. What lies flat stays walkable.
func TestSolidObjects(t *testing.T) {
	cont, err := LoadContent(repoRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	type blocks struct{ move, sight bool }
	for id, want := range map[string]blocks{
		// Plants and rock.
		"bush": {true, false}, "thick_bush": {true, false}, "thorny_vines": {true, true},
		"oak_tree": {true, true}, "pine_tree": {true, true}, "birch_tree": {true, true}, "elm_tree": {true, true},
		"boulder": {true, false}, "mossy_boulder": {true, false}, "cracked_rock": {true, false},
		"iron_vein": {true, false}, "ember_vein": {true, false},
		// Town props and furniture that fill their tile.
		"well": {true, false}, "fountain": {true, false}, "barrel": {true, false}, "rickety_barrel": {true, false},
		"cargo_crate": {true, true}, "heavy_crate": {true, true}, "weathered_crate": {true, false},
		"table": {true, false}, "shelf": {true, false}, "sacks": {true, false}, "anvil": {true, false},
		"lamp_post": {true, false}, "flag_pole": {true, false}, "mooring_post": {true, false},
		"market_stall": {true, false}, "brazier": {true, false}, "clay_pot": {true, false},
		// Walls and gates.
		"stone_wall": {true, true}, "wooden_wall": {true, true}, "rock_wall": {true, true},
		"forge_gate": {true, true}, "forge_gate_open": {false, false},
		// Low growth, what lies flat and what a tenant walks over in a house.
		"grass_tuft": {false, false}, "tall_grass": {false, false}, "wildflowers": {false, false}, "reeds": {false, false},
		"cut_bush": {false, false}, "cut_vines": {false, false}, "rock_rubble": {false, false},
		"weathered_crate_debris": {false, false}, "pressure_plate": {false, false},
		"bench": {false, false}, "bed": {false, false}, "flower_box": {false, false},
		"wall_torch": {false, false}, "wall_banner": {false, false},
	} {
		it := cont.Item(id)
		if it == nil {
			t.Errorf("no item %q in data/items", id)
			continue
		}
		if got := (blocks{it.blocksMovement(), it.blocksSight()}); got != want {
			t.Errorf("%s blocks %+v, want %+v", id, got, want)
		}
	}

	// On the compiled map: nobody stands on a bush of any island, and it hides nothing.
	m, err := Build(repoRoot(t), Options{DevIslands: true})
	if err != nil {
		t.Fatal(err)
	}
	bush, bushes := cont.NumericID("bush"), 0
	for _, is := range m.Islands() {
		for _, s := range is.Sectors() {
			for _, st := range s.Stacks {
				if !slices.Contains(st.Items, bush) {
					continue
				}
				bushes++
				at := world.Pos{
					X: s.CX*world.SectorSize + st.Index%world.SectorSize,
					Y: s.CY*world.SectorSize + st.Index/world.SectorSize,
					Z: s.Z,
				}
				if m.Walkable(at) {
					t.Errorf("%s: the bush at %v is walkable", is.ID, at)
				}
				if len(st.Items) == 1 && s.Flags[st.Index]&world.FlagBlocksSight != 0 {
					t.Errorf("%s: the bush at %v blocks sight", is.ID, at)
				}
			}
		}
		// Nothing that stands somewhere stands on a solid tile (make validate says the same
		// of the YAML; this is the map the server loads).
		if !m.Walkable(is.Temple) {
			t.Errorf("%s: the temple %v is not walkable", is.ID, is.Temple)
		}
		for _, sp := range is.Spawns {
			if !m.Walkable(sp.Center) {
				t.Errorf("%s: the centre of spawn %s %v is not walkable", is.ID, sp.ID, sp.Center)
			}
		}
		for _, n := range is.NPCs {
			if !m.Walkable(n.Pos) {
				t.Errorf("%s: NPC %s stands on %v, not walkable", is.ID, n.NPC, n.Pos)
			}
		}
		for _, h := range is.Houses {
			if !m.Walkable(h.Exit) {
				t.Errorf("%s: the exit %v of house %s is not walkable", is.ID, h.Exit, h.ID)
			}
		}
		for _, pt := range is.Portals {
			if !m.Walkable(pt.To) {
				t.Errorf("%s: portal %s leads to %v, not walkable", is.ID, pt.ID, pt.To)
			}
		}
	}
	// How many bushes, and where, is the map builders' business.
	if bushes == 0 {
		t.Fatal("no bush on the islands: the check above looked at nothing")
	}
}

// TestTreesLeaveNoSpawnBlind: trees block sight (docs/06 "Qué bloquea el paso"), and a
// monster that sees nobody attacks nobody. From the centre of every spawn with a tree
// within 7 tiles, more than half of the tiles a player stands on within those 7 tiles are
// still in sight: no thicket hides a spawn from the ground around it.
func TestTreesLeaveNoSpawnBlind(t *testing.T) {
	cont, err := LoadContent(repoRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	// Without the tools island: its pens are walled in on purpose.
	m, err := Build(repoRoot(t), Options{})
	if err != nil {
		t.Fatal(err)
	}
	trees := []uint16{cont.NumericID("oak_tree"), cont.NumericID("pine_tree"), cont.NumericID("birch_tree"), cont.NumericID("elm_tree")}
	const far = 7
	looked := 0
	for _, is := range m.Islands() {
		for _, sp := range is.Spawns {
			var tree bool
			var walkable, seen int
			for dy := -far; dy <= far; dy++ {
				for dx := -far; dx <= far; dx++ {
					x, y := int(sp.Center.X)+dx, int(sp.Center.Y)+dy
					if x < 0 || y < 0 || x > 0xFFFF || y > 0xFFFF {
						continue
					}
					p := world.Pos{X: uint16(x), Y: uint16(y), Z: sp.Center.Z}
					if slices.ContainsFunc(m.Stack(p), func(id uint16) bool { return slices.Contains(trees, id) }) {
						tree = true
					}
					if !m.Walkable(p) {
						continue
					}
					walkable++
					if m.LineOfSight(sp.Center, p) {
						seen++
					}
				}
			}
			if !tree {
				continue
			}
			looked++
			if seen*2 <= walkable {
				t.Errorf("%s: spawn %s at %v sees %d of the %d tiles one stands on around it", is.ID, sp.ID, sp.Center, seen, walkable)
			}
		}
	}
	if looked == 0 {
		t.Skip("no spawn has a tree within 7 tiles")
	}
	t.Logf("%d spawns with trees around", looked)
}
