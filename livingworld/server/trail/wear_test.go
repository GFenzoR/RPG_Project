package trail

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// cfg is a small config: levels at 10, 20 and 30 of 40; a player step 4, a monster's 1;
// decay of 2 every second (20 ticks of 50 ms); a snapshot every 10 s.
func cfg() Config {
	return Config{Surfaces: []string{"grass", "tall_grass"}, PlayerStep: 4, MonsterStep: 1, Max: 40,
		Levels: [3]int{10, 20, 30}, DecayEveryMs: 1000, Decay: 2, SaveEveryMs: 10000}
}

var at = Pos{X: 100, Y: 200, Z: 7}

func steps(m *Map, p Pos, n int, w Walker) {
	for range n {
		m.OnStep(p, "grass", w)
	}
}

func TestStepsWearUpToTheCap(t *testing.T) {
	m := New(cfg(), 50)
	steps(m, at, 2, WalkerPlayer)
	if got := m.Wear(at); got != 8 {
		t.Fatalf("wear after 2 steps = %d, want 8", got)
	}
	steps(m, at, 100, WalkerPlayer)
	if got := m.Wear(at); got != 40 {
		t.Fatalf("wear = %d, want the cap 40", got)
	}
	if m.Level(at) != LevelBare || m.Tiles() != 1 || m.Chunks() != 1 {
		t.Fatalf("level %d, tiles %d, chunks %d", m.Level(at), m.Tiles(), m.Chunks())
	}
}

func TestOnlyWornSurfacesAndWeightedWalkers(t *testing.T) {
	m := New(cfg(), 50)
	m.OnStep(at, "sand", WalkerPlayer)
	m.OnStep(at, "", WalkerPlayer)
	m.OnStep(at, "grass", Walker(0)) // an NPC
	if m.Wear(at) != 0 || m.Chunks() != 0 {
		t.Fatalf("wear %d on a surface or walker that does not wear", m.Wear(at))
	}
	m.OnStep(at, "tall_grass", WalkerMonster)
	if m.Wear(at) != 1 {
		t.Fatalf("monster step wear = %d, want 1", m.Wear(at))
	}
	c := cfg()
	c.MonsterStep = 0
	m = New(c, 50)
	m.OnStep(at, "grass", WalkerMonster)
	if m.Chunks() != 0 {
		t.Fatal("monster_step 0 still wears")
	}
}

func TestQuantization(t *testing.T) {
	c := cfg()
	for v, want := range map[int]uint8{0: 0, 9: 0, 10: 1, 19: 1, 20: 2, 29: 2, 30: 3, 40: 3} {
		if got := c.Level(v); got != want {
			t.Errorf("Level(%d) = %d, want %d", v, got, want)
		}
	}
}

func TestChangesOnlyOnLevelChange(t *testing.T) {
	m := New(cfg(), 50)
	steps(m, at, 2, WalkerPlayer) // 8: still 0
	if ch := m.TakeChanges(nil); len(ch) != 0 {
		t.Fatalf("changes below the first level: %v", ch)
	}
	steps(m, at, 1, WalkerPlayer) // 12: level 1
	steps(m, at, 1, WalkerPlayer) // 16: still 1
	ch := m.TakeChanges(nil)
	if !slices.Equal(ch, []Change{{Pos: at, Level: 1}}) {
		t.Fatalf("changes = %v, want one to level 1", ch)
	}
	if ch := m.TakeChanges(nil); len(ch) != 0 {
		t.Fatalf("changes not forgotten: %v", ch)
	}
	steps(m, at, 10, WalkerPlayer) // 40 at the cap: levels 2 and 3 crossed
	if ch := m.TakeChanges(nil); !slices.Equal(ch, []Change{{at, 2}, {at, 3}}) {
		t.Fatalf("changes = %v", ch)
	}
	steps(m, at, 5, WalkerPlayer) // capped: nothing
	if ch := m.TakeChanges(nil); len(ch) != 0 {
		t.Fatalf("changes at the cap: %v", ch)
	}
}

func TestDecayWithTheTick(t *testing.T) {
	m := New(cfg(), 50)
	far := Pos{X: 5000, Y: 3, Z: 6}
	steps(m, at, 3, WalkerPlayer)  // 12: level 1
	steps(m, far, 1, WalkerPlayer) // 4
	m.TakeChanges(nil)
	tick := int64(1000)
	if m.OnTick(tick) {
		t.Fatal("the first tick only schedules")
	}
	// Nothing happens before a whole decay period (20 ticks).
	for tick++; tick < 1020; tick++ {
		m.OnTick(tick)
	}
	if m.Wear(at) != 12 {
		t.Fatalf("decayed early: %d", m.Wear(at))
	}
	m.OnTick(tick) // 1020: one pass
	if m.Wear(at) != 10 || m.Wear(far) != 2 {
		t.Fatalf("after one pass: %d, %d", m.Wear(at), m.Wear(far))
	}
	tick += 20
	m.OnTick(tick) // 8: level 0; far 0, its chunk dropped
	if m.Wear(at) != 8 || m.Wear(far) != 0 || m.Chunks() != 1 {
		t.Fatalf("after two passes: %d, %d, chunks %d", m.Wear(at), m.Wear(far), m.Chunks())
	}
	if ch := m.TakeChanges(nil); !slices.Equal(ch, []Change{{at, 0}}) {
		t.Fatalf("decay changes = %v, want the recovery of at", ch)
	}
	for range 4 {
		tick += 20
		m.OnTick(tick)
	}
	if m.Chunks() != 0 || m.Tiles() != 0 {
		t.Fatalf("grass did not recover: %d chunks", m.Chunks())
	}
}

func TestSnapshotIsDue(t *testing.T) {
	m := New(cfg(), 50)
	m.OnTick(0)
	due := 0
	for tick := int64(1); tick <= 400; tick++ { // 20 s: two snapshots of 10 s
		if m.OnTick(tick) {
			due++
		}
	}
	if due != 2 {
		t.Fatalf("snapshots due in 20 s = %d, want 2", due)
	}
}

func TestEachInRect(t *testing.T) {
	m := New(cfg(), 50)
	in := []Pos{{31, 10, 7}, {32, 10, 7}, {33, 11, 7}}
	for _, p := range in {
		steps(m, p, 3, WalkerPlayer)
	}
	steps(m, Pos{32, 10, 6}, 3, WalkerPlayer) // another floor
	steps(m, Pos{40, 10, 7}, 3, WalkerPlayer) // outside
	steps(m, Pos{33, 12, 7}, 1, WalkerPlayer) // level 0
	var got []Pos
	m.EachInRect(30, 9, 35, 12, 7, func(p Pos, l uint8) {
		if l != 1 {
			t.Errorf("%v level %d", p, l)
		}
		got = append(got, p)
	})
	if !slices.Equal(got, in) {
		t.Fatalf("EachInRect = %v, want %v", got, in)
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	m := New(cfg(), 50)
	worn := map[Pos]int{{1, 1, 7}: 3, {700, 64, 7}: 10, {33, 0, 8}: 1}
	for p, n := range worn {
		steps(m, p, n, WalkerPlayer)
	}
	s := m.Snapshot()
	steps(m, Pos{1, 1, 7}, 1, WalkerPlayer) // after the copy: not in it
	data := s.Encode()
	if s.Tiles() != 3 || len(data) != 3+3*(7+4) {
		t.Fatalf("snapshot: %d tiles, %d bytes", s.Tiles(), len(data))
	}
	r := New(cfg(), 50)
	if err := r.Restore(data, 0); err != nil {
		t.Fatal(err)
	}
	for p, n := range worn {
		if got := r.Wear(p); got != min(4*n, 40) {
			t.Errorf("restored %v = %d, want %d", p, got, min(4*n, 40))
		}
	}
	if !slices.Equal(r.Snapshot().Encode(), data) {
		t.Fatal("encode(restore(data)) != data")
	}
	if ch := r.TakeChanges(nil); len(ch) != 0 {
		t.Fatalf("restore reported changes: %v", ch)
	}
}

func TestRestoreDecaysTheDowntime(t *testing.T) {
	m := New(cfg(), 50)
	steps(m, at, 10, WalkerPlayer) // 40
	steps(m, Pos{1, 1, 7}, 1, WalkerPlayer)
	data := m.Snapshot().Encode()
	r := New(cfg(), 50)
	if err := r.Restore(data, 5500); err != nil { // 5 passes of 2
		t.Fatal(err)
	}
	if r.Wear(at) != 30 || r.Wear(Pos{1, 1, 7}) != 0 || r.Chunks() != 1 {
		t.Fatalf("after the downtime: %d, chunks %d", r.Wear(at), r.Chunks())
	}
	if err := r.Restore(data, 1<<40); err != nil || r.Chunks() != 0 {
		t.Fatalf("a long downtime leaves wear: %v, %d chunks", err, r.Chunks())
	}
}

func TestRestoreRefusesCorruptBytes(t *testing.T) {
	m := New(cfg(), 50)
	steps(m, at, 3, WalkerPlayer)
	good := m.Snapshot().Encode()
	for name, data := range map[string][]byte{
		"header":    []byte("XX\x01"),
		"truncated": good[:len(good)-1],
		"cell":      append(append([]byte{}, good[:10]...), 0xFF, 0xFF, 1, 0),
	} {
		r := New(cfg(), 50)
		if err := r.Restore(data, 0); !errors.Is(err, ErrCorrupt) {
			t.Errorf("%s: err = %v", name, err)
		}
		if r.Chunks() != 0 {
			t.Errorf("%s: a corrupt restore kept %d chunks", name, r.Chunks())
		}
	}
	if err := New(cfg(), 50).Restore(nil, 0); err != nil {
		t.Fatalf("empty restore: %v", err)
	}
}

func TestConfig(t *testing.T) {
	if _, err := ParseConfig([]byte("surfaces: [grass]\nplayer_step: 1\nmonster_step: 0\nmax: 9\nlevels: [1, 2, 3]\ndecay_every_ms: 1\ndecay: 1\nsave_every_ms: 1\n")); err != nil {
		t.Fatal(err)
	}
	bad := []string{
		"surfaces: []\nplayer_step: 1\nmax: 9\nlevels: [1, 2, 3]\ndecay_every_ms: 1\ndecay: 1\nsave_every_ms: 1\n",
		"surfaces: [grass]\nplayer_step: 1\nmax: 9\nlevels: [3, 2, 1]\ndecay_every_ms: 1\ndecay: 1\nsave_every_ms: 1\n",
		"surfaces: [grass]\nplayer_step: 1\nmax: 2\nlevels: [1, 2, 3]\ndecay_every_ms: 1\ndecay: 1\nsave_every_ms: 1\n",
		"surfaces: [grass]\nplayer_step: 1\nmax: 9\nlevels: [1, 2, 3]\ndecay_every_ms: 1\ndecay: 1\nsave_every_ms: 1\nextra: 1\n",
	}
	for _, b := range bad {
		if _, err := ParseConfig([]byte(b)); err == nil {
			t.Errorf("accepted:\n%s", b)
		}
	}
}

// The repo's data/livingworld/wear.yaml loads and keeps the owner's pace: a path takes a
// few hours of steady traffic and recovers in about a day (livingworld/README.md).
func TestRepoConfig(t *testing.T) {
	c, err := LoadConfig(filepath.Join("..", "..", "..", "data", "livingworld", "wear.yaml"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			t.Skip("no data/ next to the module")
		}
		t.Fatal(err)
	}
	perHour := 3_600_000 / c.DecayEveryMs * c.Decay
	if hours := float64(c.Max) / float64(perHour); hours < 12 || hours > 36 {
		t.Errorf("full recovery takes %.1f h, want about a day", hours)
	}
	// Three steps a minute on a tile for three hours make bare dirt.
	if got := 3*60*3*c.PlayerStep - 3*perHour; got < c.Levels[2] {
		t.Errorf("3 h of 3 steps/min leave %d wear, below level 3 (%d)", got, c.Levels[2])
	}
	if !c.Wears("grass") || c.Wears("sand") {
		t.Error("only grass wears")
	}
}
