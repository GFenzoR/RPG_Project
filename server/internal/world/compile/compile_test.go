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
