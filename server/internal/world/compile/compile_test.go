package compile

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

const miniRoot = "testdata/miniworld"

// repoRoot is the repository root, four levels above this package.
func repoRoot(t testing.TB) string {
	t.Helper()
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "world", "world.yaml")); err != nil {
		t.Fatalf("repository root not found at %s: %v", root, err)
	}
	return root
}

func mustCompile(t testing.TB, root string) *world.Map {
	t.Helper()
	m, err := Compile(root)
	if err != nil {
		t.Fatalf("Compile(%s): %v", root, err)
	}
	return m
}

func p(x, y, z int) world.Pos { return world.Pos{X: uint16(x), Y: uint16(y), Z: uint8(z)} }

type walkableDump struct {
	Island string   `json:"island"`
	Z      int      `json:"z"`
	X      int      `json:"x"`
	Y      int      `json:"y"`
	Rows   []string `json:"rows"`
}

// portalDump is a portal as testdata/walkable.ts prints it.
type portalDump struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	From [3]int `json:"from"`
	To   [3]int `json:"to"`
}

// parityEnv enables TestWalkableParityWithMapFormat. It needs node and the pnpm workspace
// installed, which plain `go test` does not: run it with `make test-parity`.
const parityEnv = "RPG_MAPFORMAT_PARITY"

// TestWalkableParityWithMapFormat checks that mapcompile and packages/map-format (the
// validator used by mapcli, the editor and `make validate`) agree on every tile.
func TestWalkableParityWithMapFormat(t *testing.T) {
	if os.Getenv(parityEnv) != "1" {
		t.Skipf("set %s=1 to compare with packages/map-format (make test-parity)", parityEnv)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("%s=1 but node is not installed: %v", parityEnv, err)
	}
	if _, err := os.Stat(filepath.Join(repoRoot(t), "packages", "map-format", "node_modules")); err != nil {
		t.Fatalf("%s=1 but the pnpm workspace is not installed (run pnpm install): %v", parityEnv, err)
	}
	for _, root := range []string{repoRoot(t), miniRoot} {
		t.Run(filepath.Base(root), func(t *testing.T) {
			abs, err := filepath.Abs(root)
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(node, "--experimental-strip-types", "--no-warnings", "testdata/walkable.ts", abs)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			out, err := cmd.Output()
			if err != nil {
				t.Fatalf("map-format dump: %v\n%s", err, stderr.String())
			}
			var dumps []walkableDump
			if err := json.Unmarshal(out, &dumps); err != nil {
				t.Fatalf("parse map-format dump: %v", err)
			}
			m := mustCompile(t, abs)
			if len(dumps) == 0 {
				t.Fatal("map-format reported no floors")
			}
			floors := 0
			for _, is := range m.Islands() {
				floors += len(is.Floors)
			}
			if floors != len(dumps) {
				t.Fatalf("mapcompile has %d island floors, map-format %d", floors, len(dumps))
			}
			walkable, mismatches := 0, 0
			for _, d := range dumps {
				for dy, row := range d.Rows {
					for dx, c := range row {
						pos := p(d.X+dx, d.Y+dy, d.Z)
						got := m.Walkable(pos)
						if got {
							walkable++
						}
						if got != (c == '1') {
							mismatches++
							if mismatches <= 10 {
								t.Errorf("%s %v: mapcompile walkable=%v, map-format walkable=%v", d.Island, pos, got, c == '1')
							}
						}
					}
				}
			}
			if mismatches > 0 {
				t.Fatalf("%d tiles disagree", mismatches)
			}
			if walkable == 0 {
				t.Fatal("no walkable tiles: the comparison is vacuous")
			}

			// The portals map-format loads are the ones mapcompile writes to world.bin.
			cmd = exec.Command(node, "--experimental-strip-types", "--no-warnings", "testdata/walkable.ts", abs, "portals")
			stderr.Reset()
			cmd.Stderr = &stderr
			out, err = cmd.Output()
			if err != nil {
				t.Fatalf("map-format portals: %v\n%s", err, stderr.String())
			}
			var portals []portalDump
			if err := json.Unmarshal(out, &portals); err != nil {
				t.Fatalf("parse map-format portals: %v", err)
			}
			var got []portalDump
			for _, pt := range m.Portals() {
				got = append(got, portalDump{ID: pt.ID, Kind: pt.Kind.String(),
					From: [3]int{int(pt.From.X), int(pt.From.Y), int(pt.From.Z)},
					To:   [3]int{int(pt.To.X), int(pt.To.Y), int(pt.To.Z)}})
			}
			if len(portals) == 0 || !reflect.DeepEqual(got, portals) {
				t.Fatalf("mapcompile portals %+v, map-format %+v", got, portals)
			}
		})
	}
}

func TestCompileMiniworldFlags(t *testing.T) {
	m := mustCompile(t, miniRoot)
	const (
		grass, road, plainFloor, water = 1, 2, 3, 4
		stoneWall, openGate, crate     = 5, 6, 7
		flower, coin                   = 9, 10
	)
	cases := []struct {
		name   string
		pos    world.Pos
		ground uint16
		flags  world.Flags
	}{
		{"grass", p(34, 34, 7), grass, 0},
		{"water", p(32, 40, 7), water, world.FlagBlocksMovement},
		{"no tile", p(62, 34, 7), 0, world.FlagBlocksMovement},
		{"wall without blocks_movement or blocks_sight", p(42, 36, 7), grass, world.FlagBlocksMovement | world.FlagBlocksSight},
		{"wall with blocks_movement and blocks_sight false", p(42, 44, 7), grass, 0},
		{"crate", p(47, 37, 7), grass, world.FlagBlocksMovement | world.FlagBlocksSight},
		{"banner", p(52, 52, 7), grass, world.FlagBlocksSight},
		{"flower", p(37, 37, 7), grass, 0},
		{"road", p(40, 57, 7), road, 0},
		{"ground without speed", p(36, 35, 7), plainFloor, 0},
		{"protection", p(40, 40, 7), grass, world.FlagProtection},
		{"protection edge (wall)", p(42, 42, 7), grass, world.FlagProtection | world.FlagBlocksMovement | world.FlagBlocksSight},
		{"outside protection", p(43, 40, 7), grass, 0},
		{"no_logout", p(64, 51, 7), grass, world.FlagNoLogout},
		{"no_logout on 8 over no tile", p(60, 51, 8), 0, world.FlagBlocksMovement},
		{"no_logout on 8", p(66, 52, 8), plainFloor, world.FlagNoLogout},
		{"cave crate", p(69, 47, 8), plainFloor, world.FlagBlocksMovement | world.FlagBlocksSight},
		{"floor 6 does not exist", p(40, 40, 6), 0, world.FlagBlocksMovement},
		{"outside every island", p(10, 10, 7), 0, world.FlagBlocksMovement},
	}
	for _, c := range cases {
		g, f, _ := m.Tile(c.pos)
		if g != c.ground || f != c.flags {
			t.Errorf("%s %v: ground %d flags %06b, want ground %d flags %06b", c.name, c.pos, g, f, c.ground, c.flags)
		}
	}
	if got := m.Stack(p(37, 37, 7)); !reflect.DeepEqual(got, []uint16{flower, coin}) {
		t.Errorf("stack at 37,37,7 = %v, want [flower coin]", got)
	}
	if got := m.Stack(p(42, 44, 7)); !reflect.DeepEqual(got, []uint16{openGate}) {
		t.Errorf("stack at 42,44,7 = %v, want [open_gate]", got)
	}
	if got := m.Stack(p(42, 40, 7)); !reflect.DeepEqual(got, []uint16{stoneWall}) {
		t.Errorf("stack at 42,40,7 = %v, want [stone_wall]", got)
	}
	if got := m.Stack(p(34, 34, 7)); got != nil {
		t.Errorf("stack at 34,34,7 = %v, want none", got)
	}
	speeds := m.GroundSpeeds()
	if speeds[grass] != 150 || speeds[road] != 50 || speeds[plainFloor] != 0 || speeds[crate] != 0 {
		t.Errorf("ground speeds = %v", speeds)
	}
	is := m.Island("mini")
	if is == nil || is.Temple != p(40, 40, 7) || !reflect.DeepEqual(is.Floors, []uint8{7, 8}) {
		t.Fatalf("island meta = %+v", is)
	}
	if n := len(is.Sectors()); n != 3 {
		t.Errorf("mini has %d sectors, want 3", n)
	}
	want := []world.Portal{
		{ID: "mini_cave_down", Kind: world.PortalStairs, From: p(66, 54, 7), To: p(66, 55, 8)},
		{ID: "mini_cave_up", Kind: world.PortalStairs, From: p(66, 54, 8), To: p(66, 55, 7)},
		{ID: "mini_shortcut", Kind: world.PortalTeleport, From: p(70, 54, 7), To: p(72, 54, 7)},
	}
	if !reflect.DeepEqual(is.Portals, want) {
		t.Errorf("portals = %+v, want %+v", is.Portals, want)
	}
	if pt := m.PortalAt(p(66, 54, 8)); pt == nil || pt.ID != "mini_cave_up" || !m.MovesOnStep(p(70, 54, 7)) {
		t.Errorf("PortalAt(66,54,8) = %+v", pt)
	}
}

// TestCompilePortals: the stairs of the real islands (portals.yaml) reach world.bin, so the
// mines on floor 8 are reachable without a staff teleport: the volcanic mine's stairs at
// 3692,5796 go down and come back up next to where they started.
func TestCompilePortals(t *testing.T) {
	m := mustCompile(t, repoRoot(t))
	down, up := m.PortalAt(p(3692, 5796, 7)), m.PortalAt(p(3692, 5796, 8))
	if down == nil || down.ID != "volcan_mine_down" || down.Kind != world.PortalStairs || down.To != p(3692, 5797, 8) {
		t.Fatalf("volcanic mine stairs down = %+v", down)
	}
	if up == nil || up.ID != "volcan_mine_up" || up.Kind != world.PortalStairs || up.To != p(3692, 5797, 7) {
		t.Fatalf("volcanic mine stairs up = %+v", up)
	}
	for _, id := range []string{"puerto", "bosque", "volcan", "testisle", "pruebas"} {
		if is := m.Island(id); is == nil || len(is.Portals) == 0 {
			t.Errorf("island %s has no portals", id)
		}
	}
}

func TestCompileTestisle(t *testing.T) {
	m := mustCompile(t, repoRoot(t))
	is := m.Island("testisle")
	if is == nil {
		t.Fatal("testisle missing")
	}
	if !m.Walkable(is.Temple) {
		t.Errorf("temple %v is not walkable", is.Temple)
	}
	if m.Flags(is.Temple)&world.FlagProtection == 0 {
		t.Errorf("temple %v is not in a protection zone", is.Temple)
	}
	if len(is.Spawns) != 3 || is.Spawns[0].ID != "testisle_wolves" || is.Spawns[0].Monsters[0] != (world.SpawnMonster{Monster: "wolf", Count: 3}) ||
		is.Spawns[0].RespawnSeconds != 60 || is.Spawns[0].Radius != 4 {
		t.Errorf("spawns = %+v", is.Spawns)
	}
	// The cave stairs lead down to 1069,1056,8: there must be a walking path from the
	// temple to the top of the stairs.
	pf := world.NewPathfinder(m, 0)
	path, ok := pf.Find(is.Temple, p(1068, 1056, 7), nil)
	if !ok || len(path) == 0 {
		t.Fatalf("no path from the temple to the cave stairs")
	}
}

// TestCompilePruebas: the sandbox island (docs/16-probar-el-juego.md) compiles with its
// temple in a protection zone, one portal of each kind, an arena where PvP needs no skulls
// and a house, and the temple reaches the floor 7 portals on foot.
func TestCompilePruebas(t *testing.T) {
	m := mustCompile(t, repoRoot(t))
	is := m.Island("pruebas")
	if is == nil {
		t.Fatal("pruebas missing")
	}
	if !m.Walkable(is.Temple) || m.Flags(is.Temple)&world.FlagProtection == 0 {
		t.Errorf("temple %v: walkable %v, flags %b", is.Temple, m.Walkable(is.Temple), m.Flags(is.Temple))
	}
	kinds := map[world.PortalKind]int{}
	for _, pt := range is.Portals {
		kinds[pt.Kind]++
	}
	want := map[world.PortalKind]int{world.PortalStairs: 2, world.PortalLadder: 2, world.PortalHole: 1,
		world.PortalRopeSpot: 1, world.PortalTeleport: 1}
	for k, n := range want {
		if kinds[k] != n {
			t.Errorf("%d portals of kind %v, want %d", kinds[k], k, n)
		}
	}
	// The arena (2102..2112, 2111..2119) is a pvp zone without protection.
	if f := m.Flags(p(2107, 2115, 7)); f&world.FlagPvP == 0 || f&world.FlagProtection != 0 {
		t.Errorf("arena flags = %b, want pvp and no protection", f)
	}
	if f := m.Flags(p(2088, 2111, 7)); f&world.FlagHouse == 0 {
		t.Errorf("house tile flags = %b, want house", f)
	}
	// On foot from the temple to beside the stairs down, the trapdoor and the hole.
	pf := world.NewPathfinder(m, 0)
	for _, to := range []world.Pos{p(2121, 2091, 7), p(2116, 2091, 7), p(2119, 2095, 7)} {
		if path, ok := pf.Find(is.Temple, to, nil); !ok || len(path) == 0 {
			t.Errorf("no path from the temple to %v", to)
		}
	}
}

// TestCompilePuerto: the starting island (T1.16) compiles with its town walls blocking
// walking and sight, the six NPCs of Chapter 1 and a walkable way down to the mine.
func TestCompilePuerto(t *testing.T) {
	m := mustCompile(t, repoRoot(t))
	is := m.Island("puerto")
	if is == nil {
		t.Fatal("puerto missing")
	}
	if m.Flags(is.Temple)&world.FlagProtection == 0 {
		t.Errorf("temple %v is not in a protection zone", is.Temple)
	}
	// 3150,6386 is the temple's west wall (stone_wall).
	wall := p(3150, 6386, 7)
	if f := m.Flags(wall); f&world.FlagBlocksMovement == 0 || f&world.FlagBlocksSight == 0 {
		t.Errorf("temple wall %v flags = %b, want blocks movement and sight", wall, f)
	}
	if m.LineOfSight(p(3149, 6386, 7), is.Temple) {
		t.Error("line of sight crosses the temple wall")
	}
	if !m.LineOfSight(p(3166, 6386, 7), is.Temple) {
		t.Error("no line of sight through the temple door")
	}
	got := map[string]bool{}
	for _, n := range is.NPCs {
		got[n.NPC] = true
	}
	for _, id := range []string{"harbor_master", "puerto_priest", "puerto_provisioner",
		"puerto_armorer", "puerto_foreman", "puerto_diver"} {
		if !got[id] {
			t.Errorf("NPC %s is not on puerto", id)
		}
	}
	pf := world.NewPathfinder(m, 0)
	if path, ok := pf.Find(is.Temple, p(3176, 6322, 7), nil); !ok || len(path) == 0 {
		t.Fatal("no path from the temple to the mine stairs")
	}
}

// TestCompileDeterministic: the same sources give the same world.bin bytes, and decoding
// them gives back the same map.
func TestCompileDeterministic(t *testing.T) {
	for _, root := range []string{repoRoot(t), miniRoot} {
		var a, b bytes.Buffer
		m := mustCompile(t, root)
		if err := world.Encode(&a, m); err != nil {
			t.Fatal(err)
		}
		if err := world.Encode(&b, mustCompile(t, root)); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a.Bytes(), b.Bytes()) {
			t.Fatalf("%s: two compilations produced different bytes", root)
		}
		back, err := world.Decode(a.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(back, m) {
			t.Fatalf("%s: decoded map differs from the compiled one", root)
		}
	}
}

// copyTree copies the mini world to a temp dir so a test can break one file.
func copyTree(t *testing.T) string {
	t.Helper()
	dst := t.TempDir()
	err := filepath.WalkDir(miniRoot, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(miniRoot, path)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

func TestCompileErrors(t *testing.T) {
	const island = "world/islands/mini/island.yaml"
	const worldYAML = "world/world.yaml"
	const chunk = "world/islands/mini/chunks/z07/c0001_0001.json"
	const portals = "world/islands/mini/portals.yaml"
	const items = "data/items/items.yaml"
	const cave = "world/islands/mini/chunks/z08/c0002_0001.json"
	cases := []struct {
		name    string
		files   []string
		old     string
		new     string
		wantErr string
	}{
		{"unaligned rect", []string{island, worldYAML}, "w: 64", "w: 60", "aligned to 32-tile chunks"},
		{"rect differs from world.yaml", []string{worldYAML}, "w: 64", "w: 96", "differs from world/world.yaml"},
		{"floor not listed", []string{island}, "floors: [7, 8]", "floors: [7]", "floor 8 is not listed"},
		{"unknown item", []string{chunk}, `"flower"`, `"tulip"`, `unknown item "tulip"`},
		{"chunk name mismatch", []string{chunk}, `"cx": 1`, `"cx": 3`, "file name says"},
		{"palette index", []string{chunk}, `"stack": [5]`, `"stack": [60]`, "palette index 60 out of range"},
		{"no numeric id", []string{"data/ids.lock.yaml"}, "  coin: 10\n", "", `"coin" has no numeric ID`},
		{"duplicate numeric id", []string{"data/ids.lock.yaml"}, "coin: 10", "coin: 9", `share numeric ID 9`},
		{"unknown zone", []string{"world/islands/mini/zones.yaml"}, "type: no_logout", "type: lava", `unknown type "lava"`},
		{"unknown island dir", []string{worldYAML}, "id: mini", "id: nope", "nope/island.yaml"},
		{"unknown portal kind", []string{portals}, "kind: teleport", "kind: ramp", `unknown kind "ramp"`},
		{"portal outside the world", []string{portals}, "x: 72, y: 54, z: 7", "x: 72, y: 54, z: 16", "outside the world"},
		{"portal into nothing", []string{portals}, "x: 72, y: 54, z: 7", "x: 72, y: 33, z: 8", "not a walkable tile"},
		{"stairs on one floor", []string{portals}, "to: { x: 66, y: 55, z: 8 }", "to: { x: 66, y: 55, z: 7 }", "must change floor"},
		// Every portal but a boat stands under the item that shows it (docs/03).
		{"portal without its item", []string{cave}, `,
    { "x": 2, "y": 22, "stack": [2] }`, "", `stairs "mini_cave_up" has no item that shows it on its entrance 66,54,8`},
		{"portal under an item of another kind", []string{items}, "portal: { kind: teleport }", "portal: { kind: hole }", `teleport "mini_shortcut" has no item that shows it`},
		{"stairs under the look of the other way", []string{items}, "portal: { kind: stairs, leads: down }", "portal: { kind: stairs, leads: up }", `stairs "mini_cave_down" has no item that shows it`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := copyTree(t)
			for _, file := range c.files {
				path := filepath.Join(root, file)
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(data), c.old) {
					t.Fatalf("%s does not contain %q", file, c.old)
				}
				if err := os.WriteFile(path, []byte(strings.Replace(string(data), c.old, c.new, 1)), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			_, err := Compile(root)
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("Compile error = %v, want it to contain %q", err, c.wantErr)
			}
		})
	}
}

func TestChunkOutsideIsland(t *testing.T) {
	root := copyTree(t)
	src := filepath.Join(root, "world/islands/mini/chunks/z07/c0001_0001.json")
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	moved := strings.Replace(string(data), `"cx": 1`, `"cx": 5`, 1)
	if err := os.WriteFile(filepath.Join(root, "world/islands/mini/chunks/z07/c0005_0001.json"), []byte(moved), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Compile(root); err == nil || !strings.Contains(err.Error(), "outside the island rectangle") {
		t.Fatalf("Compile error = %v, want chunk outside the island", err)
	}
}

func BenchmarkCompileTestisle(b *testing.B) {
	root := repoRoot(b)
	b.ReportAllocs()
	for b.Loop() {
		if _, err := Compile(root); err != nil {
			b.Fatal(err)
		}
	}
}
