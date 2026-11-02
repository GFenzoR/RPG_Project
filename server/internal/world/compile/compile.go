// Package compile turns the text sources of the world (world/ chunks and YAML, plus the
// item definitions in data/) into a world.Map ready to be written as world.bin.
//
// It checks what it needs to compile correctly (IDs resolve, chunks sit inside their island
// on a listed floor, island rects are aligned to sectors) and stops at the first file with
// problems. Full map validation (connectivity, spawns, i18n...) is packages/map-format's job
// and runs in `make validate`.
//
// Tile flags (docs/03-world-and-maps.md):
//   - FlagBlocksMovement: no ground, ground without `ground.walkable: true`, or an item on
//     the stack with `blocks_movement: true`, or with `kind: wall` unless it says
//     `blocks_movement: false` (same rule as packages/map-format).
//   - FlagBlocksSight: an item on the stack with `blocks_sight: true`.
//   - Zone flags from zones.yaml: protection, no_logout, pvp, no_pvp. community_plot only
//     matters to the editor and sets no flag.
package compile

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Item is the slice of an item definition that matters on the map.
type Item struct {
	ID             string     `yaml:"id"`
	Kind           string     `yaml:"kind"`
	BlocksMovement *bool      `yaml:"blocks_movement"`
	BlocksSight    bool       `yaml:"blocks_sight"`
	Ground         *groundDef `yaml:"ground"`

	num uint16
}

type groundDef struct {
	Walkable bool   `yaml:"walkable"`
	Speed    uint16 `yaml:"speed"`
}

func (it *Item) blocksMovement() bool {
	if it.BlocksMovement != nil {
		return *it.BlocksMovement
	}
	return it.Kind == "wall"
}

type rect struct {
	X int `yaml:"x"`
	Y int `yaml:"y"`
	W int `yaml:"w"`
	H int `yaml:"h"`
}

type pos struct {
	X int `yaml:"x"`
	Y int `yaml:"y"`
	Z int `yaml:"z"`
}

type worldFile struct {
	Format  int `yaml:"format"`
	Islands []struct {
		ID   string `yaml:"id"`
		Rect rect   `yaml:"rect"`
	} `yaml:"islands"`
}

type islandFile struct {
	ID     string `yaml:"id"`
	Rect   rect   `yaml:"rect"`
	Floors []int  `yaml:"floors"`
	Temple pos    `yaml:"temple"`
}

type zone struct {
	ID     string `yaml:"id"`
	Type   string `yaml:"type"`
	Floors []int  `yaml:"floors"`
	Rects  []rect `yaml:"rects"`
}

type chunkFile struct {
	Format int `json:"format"`
	Chunk  struct {
		CX int `json:"cx"`
		CY int `json:"cy"`
		Z  int `json:"z"`
	} `json:"chunk"`
	Palette []string `json:"palette"`
	Ground  [][]int  `json:"ground"`
	Items   []struct {
		X     int   `json:"x"`
		Y     int   `json:"y"`
		Stack []int `json:"stack"`
	} `json:"items"`
}

var zoneFlags = map[string]world.Flags{
	"protection":     world.FlagProtection,
	"no_logout":      world.FlagNoLogout,
	"pvp":            world.FlagPvP,
	"no_pvp":         world.FlagNoPvP,
	"community_plot": 0,
}

var chunkName = regexp.MustCompile(`^c(\d{4})_(\d{4})\.json$`)
var floorName = regexp.MustCompile(`^z(\d{2})$`)

// Content is the item catalogue the compiler resolves map IDs against.
type Content struct {
	Items map[string]*Item
	// speeds is indexed by numeric item ID.
	speeds []uint16
}

// Item returns the item with the given text ID, or nil.
func (c *Content) Item(id string) *Item { return c.Items[id] }

// NumericID returns the stable numeric ID of an item (0 if unknown).
func (c *Content) NumericID(id string) uint16 {
	if it := c.Items[id]; it != nil {
		return it.num
	}
	return 0
}

// LoadContent reads data/items/*.yaml and data/ids.lock.yaml under root.
func LoadContent(root string) (*Content, error) {
	files, err := filepath.Glob(filepath.Join(root, "data", "items", "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("list items: %w", err)
	}
	sort.Strings(files)
	c := &Content{Items: map[string]*Item{}}
	for _, f := range files {
		var list []*Item
		if err := readYAML(f, &list); err != nil {
			return nil, err
		}
		for _, it := range list {
			if it == nil || it.ID == "" {
				return nil, fmt.Errorf("%s: item without id", rel(root, f))
			}
			if c.Items[it.ID] != nil {
				return nil, fmt.Errorf("%s: item %q is defined twice", rel(root, f), it.ID)
			}
			c.Items[it.ID] = it
		}
	}
	var lock struct {
		Items map[string]int `yaml:"items"`
	}
	lockFile := filepath.Join(root, "data", "ids.lock.yaml")
	if err := readYAML(lockFile, &lock); err != nil {
		return nil, err
	}
	maxID := 0
	owner := map[int]string{}
	lockIDs := make([]string, 0, len(lock.Items))
	for id := range lock.Items {
		lockIDs = append(lockIDs, id)
	}
	sort.Strings(lockIDs) // reproducible error messages
	for _, id := range lockIDs {
		n := lock.Items[id]
		if n <= 0 || n > 0xFFFF {
			return nil, fmt.Errorf("%s: item %q has numeric ID %d, outside 1..65535", rel(root, lockFile), id, n)
		}
		if other, dup := owner[n]; dup {
			a, b := min(id, other), max(id, other)
			return nil, fmt.Errorf("%s: items %q and %q share numeric ID %d", rel(root, lockFile), a, b, n)
		}
		owner[n] = id
		if it := c.Items[id]; it != nil {
			it.num = uint16(n)
		}
		maxID = max(maxID, n)
	}
	c.speeds = make([]uint16, maxID+1)
	for _, it := range c.Items {
		if it.Ground != nil && it.num != 0 {
			c.speeds[it.num] = it.Ground.Speed // 0 = world.DefaultGroundSpeed
		}
	}
	return c, nil
}

// Compile reads world/ and data/ under root and builds the map.
func Compile(root string) (*world.Map, error) {
	content, err := LoadContent(root)
	if err != nil {
		return nil, err
	}
	var wf worldFile
	if err := readYAML(filepath.Join(root, "world", "world.yaml"), &wf); err != nil {
		return nil, err
	}
	if wf.Format != 1 {
		return nil, fmt.Errorf("world/world.yaml: format %d, mapcompile reads format 1", wf.Format)
	}
	var islands []*world.Island
	sectors := map[string][]*world.Sector{}
	for _, entry := range wf.Islands {
		is, secs, err := compileIsland(root, entry.ID, entry.Rect, content)
		if err != nil {
			return nil, err
		}
		islands = append(islands, is)
		sectors[is.ID] = secs
	}
	m, err := world.NewMap(islands, sectors, content.speeds)
	if err != nil {
		return nil, fmt.Errorf("world/world.yaml: %w", err)
	}
	return m, nil
}

func compileIsland(root, id string, worldRect rect, content *Content) (*world.Island, []*world.Sector, error) {
	dir := filepath.Join(root, "world", "islands", id)
	islandPath := filepath.Join(dir, "island.yaml")
	var meta islandFile
	if err := readYAML(islandPath, &meta); err != nil {
		return nil, nil, err
	}
	where := rel(root, islandPath)
	if meta.ID != id {
		return nil, nil, fmt.Errorf("%s: id %q does not match the directory %q", where, meta.ID, id)
	}
	if meta.Rect != worldRect {
		return nil, nil, fmt.Errorf("%s: rect %+v differs from world/world.yaml %+v", where, meta.Rect, worldRect)
	}
	r := meta.Rect
	if r.X < 0 || r.Y < 0 || r.W <= 0 || r.H <= 0 || r.X+r.W > 65536 || r.Y+r.H > 65536 {
		return nil, nil, fmt.Errorf("%s: rect %+v is empty or leaves the world", where, r)
	}
	if r.X%world.SectorSize != 0 || r.Y%world.SectorSize != 0 || r.W%world.SectorSize != 0 || r.H%world.SectorSize != 0 {
		return nil, nil, fmt.Errorf("%s: rect %+v must be aligned to %d-tile chunks (x, y, w and h multiples of %d)", where, r, world.SectorSize, world.SectorSize)
	}
	floors := make([]uint8, 0, len(meta.Floors))
	for _, f := range meta.Floors {
		if f < 0 || f > world.MaxFloor {
			return nil, nil, fmt.Errorf("%s: floor %d outside 0..%d", where, f, world.MaxFloor)
		}
		floors = append(floors, uint8(f))
	}
	t := meta.Temple
	if t.X < 0 || t.Y < 0 || t.X > 0xFFFF || t.Y > 0xFFFF || t.Z < 0 || t.Z > world.MaxFloor {
		return nil, nil, fmt.Errorf("%s: temple %+v outside the world", where, t)
	}
	is := &world.Island{
		ID:     id,
		Rect:   world.Rect{X: uint32(r.X), Y: uint32(r.Y), W: uint32(r.W), H: uint32(r.H)},
		Floors: floors,
		Temple: world.Pos{X: uint16(t.X), Y: uint16(t.Y), Z: uint8(t.Z)},
	}

	var sectors []*world.Sector
	chunksDir := filepath.Join(dir, "chunks")
	floorDirs, err := os.ReadDir(chunksDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, fmt.Errorf("read %s: %w", rel(root, chunksDir), err)
	}
	for _, fd := range floorDirs {
		fm := floorName.FindStringSubmatch(fd.Name())
		if !fd.IsDir() || fm == nil {
			return nil, nil, fmt.Errorf("%s: expected floor directories named z00..z15", rel(root, filepath.Join(chunksDir, fd.Name())))
		}
		z := atoi(fm[1])
		if !slices.Contains(floors, uint8(z)) {
			return nil, nil, fmt.Errorf("%s: floor %d is not listed in island.yaml", rel(root, filepath.Join(chunksDir, fd.Name())), z)
		}
		entries, err := os.ReadDir(filepath.Join(chunksDir, fd.Name()))
		if err != nil {
			return nil, nil, fmt.Errorf("read %s: %w", rel(root, filepath.Join(chunksDir, fd.Name())), err)
		}
		for _, e := range entries {
			path := filepath.Join(chunksDir, fd.Name(), e.Name())
			cm := chunkName.FindStringSubmatch(e.Name())
			if cm == nil {
				return nil, nil, fmt.Errorf("%s: chunk files are named cXXXX_YYYY.json", rel(root, path))
			}
			s, err := compileChunk(path, rel(root, path), z, atoi(cm[1]), atoi(cm[2]), r, content)
			if err != nil {
				return nil, nil, err
			}
			sectors = append(sectors, s)
		}
	}
	// Deterministic order: z, cy, cx (also the world.bin order).
	sort.Slice(sectors, func(i, j int) bool {
		a, b := sectors[i], sectors[j]
		if a.Z != b.Z {
			return a.Z < b.Z
		}
		if a.CY != b.CY {
			return a.CY < b.CY
		}
		return a.CX < b.CX
	})

	if err := applyZones(root, dir, sectors); err != nil {
		return nil, nil, err
	}
	return is, sectors, nil
}

func compileChunk(path, where string, z, cx, cy int, island rect, content *Content) (*world.Sector, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", where, err)
	}
	var c chunkFile
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("%s: %w", where, err)
	}
	if c.Format != 1 {
		return nil, fmt.Errorf("%s: format %d, mapcompile reads format 1", where, c.Format)
	}
	if c.Chunk.CX != cx || c.Chunk.CY != cy || c.Chunk.Z != z {
		return nil, fmt.Errorf("%s: says cx=%d cy=%d z=%d but the file name says cx=%d cy=%d z=%d", where, c.Chunk.CX, c.Chunk.CY, c.Chunk.Z, cx, cy, z)
	}
	ox, oy := cx*world.SectorSize, cy*world.SectorSize
	if ox < island.X || oy < island.Y || ox+world.SectorSize > island.X+island.W || oy+world.SectorSize > island.Y+island.H {
		return nil, fmt.Errorf("%s: chunk lies outside the island rectangle", where)
	}
	palette := make([]*Item, len(c.Palette))
	for i, id := range c.Palette {
		it := content.Item(id)
		if it == nil {
			return nil, fmt.Errorf("%s: palette[%d]: unknown item %q", where, i, id)
		}
		if it.num == 0 {
			return nil, fmt.Errorf("%s: palette[%d]: item %q has no numeric ID in data/ids.lock.yaml (run make gen-ids)", where, i, id)
		}
		palette[i] = it
	}
	resolve := func(v int, at string) (*Item, error) {
		if v < 0 || v >= len(palette) {
			return nil, fmt.Errorf("%s: %s: palette index %d out of range (palette has %d)", where, at, v, len(palette))
		}
		return palette[v], nil
	}

	s := &world.Sector{CX: uint16(cx), CY: uint16(cy), Z: uint8(z)}
	if len(c.Ground) != world.SectorSize {
		return nil, fmt.Errorf("%s: ground has %d rows, want %d", where, len(c.Ground), world.SectorSize)
	}
	for y, row := range c.Ground {
		if len(row) != world.SectorSize {
			return nil, fmt.Errorf("%s: ground[%d] has %d columns, want %d", where, y, len(row), world.SectorSize)
		}
		for x, v := range row {
			i := y*world.SectorSize + x
			if v == -1 {
				s.Flags[i] = world.FlagBlocksMovement
				continue
			}
			it, err := resolve(v, fmt.Sprintf("ground[%d][%d]", y, x))
			if err != nil {
				return nil, err
			}
			s.Ground[i] = it.num
			if it.Ground == nil || !it.Ground.Walkable {
				s.Flags[i] |= world.FlagBlocksMovement
			}
		}
	}
	seen := map[int]bool{}
	for k, st := range c.Items {
		if st.X < 0 || st.Y < 0 || st.X >= world.SectorSize || st.Y >= world.SectorSize {
			return nil, fmt.Errorf("%s: items[%d]: tile %d,%d outside the chunk", where, k, st.X, st.Y)
		}
		i := st.Y*world.SectorSize + st.X
		if seen[i] {
			return nil, fmt.Errorf("%s: items[%d]: tile %d,%d already has a stack", where, k, st.X, st.Y)
		}
		seen[i] = true
		if len(st.Stack) == 0 {
			continue
		}
		ts := world.TileStack{Index: uint16(i), Items: make([]uint16, 0, len(st.Stack))}
		for j, v := range st.Stack {
			it, err := resolve(v, fmt.Sprintf("items[%d].stack[%d]", k, j))
			if err != nil {
				return nil, err
			}
			ts.Items = append(ts.Items, it.num)
			if it.blocksMovement() {
				s.Flags[i] |= world.FlagBlocksMovement
			}
			if it.BlocksSight {
				s.Flags[i] |= world.FlagBlocksSight
			}
		}
		s.Stacks = append(s.Stacks, ts)
	}
	sort.Slice(s.Stacks, func(a, b int) bool { return s.Stacks[a].Index < s.Stacks[b].Index })
	return s, nil
}

func applyZones(root, dir string, sectors []*world.Sector) error {
	path := filepath.Join(dir, "zones.yaml")
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	var zones []zone
	if err := readYAML(path, &zones); err != nil {
		return err
	}
	for i, z := range zones {
		flag, ok := zoneFlags[z.Type]
		if !ok {
			return fmt.Errorf("%s: zones[%d] (%s): unknown type %q", rel(root, path), i, z.ID, z.Type)
		}
		if flag == 0 {
			continue
		}
		for _, s := range sectors {
			if !slices.Contains(z.Floors, int(s.Z)) {
				continue
			}
			ox, oy := int(s.CX)*world.SectorSize, int(s.CY)*world.SectorSize
			for _, r := range z.Rects {
				x0, y0 := max(r.X, ox), max(r.Y, oy)
				x1, y1 := min(r.X+r.W, ox+world.SectorSize), min(r.Y+r.H, oy+world.SectorSize)
				for y := y0; y < y1; y++ {
					for x := x0; x < x1; x++ {
						i := (y-oy)*world.SectorSize + (x - ox)
						if s.Ground[i] != 0 {
							s.Flags[i] |= flag
						}
					}
				}
			}
		}
	}
	return nil
}

func readYAML(path string, out any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := yaml.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func rel(root, path string) string {
	if r, err := filepath.Rel(root, path); err == nil {
		return filepath.ToSlash(r)
	}
	return path
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}
