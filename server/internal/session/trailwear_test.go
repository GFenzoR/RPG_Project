package session_test

import (
	"slices"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Trail wear (trailwear.go, livingworld/README.md "Desgaste de senderos"): a player's
// steps on grass wear it, the road ('=', dirt) never; the players who see a tile get its
// level when it changes, a player that comes into view gets it with its map, the grass
// recovers with the ticks, and the wear survives a restart.

// trailRows: grass with a road on row 3.
var trailRows = []string{
	"....................",
	"....................",
	"....................",
	"====================",
	"....................",
}

// trailConfig: two steps of a player make level 1 (6 points each, levels at 10, 20, 30);
// 10 points of decay every 10 seconds (200 ticks; a step takes 10); a snapshot every 2 s.
func trailConfig() *session.TrailConfig {
	return &session.TrailConfig{Surfaces: []string{"grass"}, PlayerStep: 6, MonsterStep: 0, Max: 40,
		Levels: [3]int{10, 20, 30}, DecayEveryMs: 10000, Decay: 10, SaveEveryMs: 2000}
}

func trailItems() content.Items {
	return content.Items{
		"grass": {ID: "grass", Numeric: worldtest.Grass, Kind: "ground", Ground: &content.Ground{Walkable: true, Surface: "grass"}},
		"road":  {ID: "road", Numeric: worldtest.Road, Kind: "ground", Ground: &content.Ground{Walkable: true, Surface: "dirt"}},
	}
}

func trailHarness(t *testing.T, saved *[]session.TrailSnapshot, data []byte, downMs int64) *harness {
	t.Helper()
	return newHarness(t, worldtest.Map(t, 0, 0, 7, trailRows...), func(c *session.Config) {
		c.Items = trailItems()
		c.Trail = trailConfig()
		c.TrailData, c.TrailDowntimeMs = data, downMs
		c.SaveTrail = func(s session.TrailSnapshot) bool {
			if saved != nil {
				*saved = append(*saved, s)
			}
			return true
		}
	})
}

// stepTo walks the player of cl one tile in d and runs ticks until it stands on to.
func stepTo(t *testing.T, h *harness, cl *fakeClient, p *session.Player, d pb.Direction, to world.Pos) {
	t.Helper()
	h.input(cl, walk(d))
	for range 100 {
		h.sim.Step()
		if p.Pos() == to {
			return
		}
	}
	t.Fatalf("never reached %v (at %v)", to, p.Pos())
}

// wearOf returns the (tile, level) pairs of every TrailWear event in evs, in order.
func wearOf(evs []*pb.ServerMessage) [][2]uint32 {
	var out [][2]uint32
	for _, m := range find(evs, (*pb.ServerMessage).GetTrailWear) {
		for i, xy := range m.GetTiles() {
			out = append(out, [2]uint32{xy, uint32(m.GetLevels()[i])})
		}
	}
	return out
}

func xy(x, y int) uint32 { return uint32(x)<<16 | uint32(y) }

func TestTrailWearGrowsAndIsSentOnLevelChanges(t *testing.T) {
	h := trailHarness(t, nil, nil, 0)
	cl, p := h.join("Walker", at(2, 1))
	other, _ := h.join("Watcher", at(10, 1))
	cl.take()
	other.take()

	// First step onto (3, 1): 6 points, still level 0: nothing is sent.
	stepTo(t, h, cl, p, pb.Direction_DIRECTION_EAST, pos(3, 1))
	if got := wearOf(cl.take()); len(got) != 0 {
		t.Fatalf("wear sent below level 1: %v", got)
	}
	stepTo(t, h, cl, p, pb.Direction_DIRECTION_WEST, pos(2, 1))
	stepTo(t, h, cl, p, pb.Direction_DIRECTION_EAST, pos(3, 1)) // 12: level 1
	want := [][2]uint32{{xy(3, 1), 1}}
	if got := wearOf(cl.take()); !slices.Equal(got, want) {
		t.Fatalf("walker got %v, want %v", got, want)
	}
	if got := wearOf(other.take()); !slices.Equal(got, want) {
		t.Fatalf("watcher got %v, want %v", got, want)
	}
	if h.w.TrailLevel(pos(3, 1)) != 1 {
		t.Fatalf("level %d", h.w.TrailLevel(pos(3, 1)))
	}

	// The road never wears.
	stepTo(t, h, cl, p, pb.Direction_DIRECTION_SOUTH, pos(3, 2))
	for range 4 {
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_SOUTH, pos(3, 3))
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_NORTH, pos(3, 2))
	}
	if h.w.TrailLevel(pos(3, 3)) != 0 {
		t.Fatal("the road wore")
	}
	if h.w.TrailLevel(pos(3, 2)) != 3 { // 5 steps: 30, bare dirt
		t.Fatalf("grass walked 5 times is level %d", h.w.TrailLevel(pos(3, 2)))
	}
}

func TestTrailWearComesWithTheMapAndRecovers(t *testing.T) {
	var saved []session.TrailSnapshot
	h := trailHarness(t, &saved, nil, 0)
	cl, p := h.join("Walker", at(2, 1))
	for range 2 {
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_EAST, pos(3, 1))
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_WEST, pos(2, 1))
	}
	// (3, 1) 12: level 1; (2, 1) 12 too (two steps back onto it).
	late, _ := h.join("Late", at(12, 4))
	var area *pb.MapArea
	for _, f := range find(late.take(), (*pb.ServerMessage).GetFullMapView) {
		area = f.GetArea()
	}
	if area == nil || len(area.GetWear()) != 1 || area.GetWear()[0].GetZ() != 7 {
		t.Fatalf("FullMapView wear = %v", area.GetWear())
	}
	got := area.GetWear()[0]
	if !slices.Equal(got.GetTiles(), []uint32{xy(2, 1), xy(3, 1)}) || !slices.Equal(got.GetLevels(), []byte{1, 1}) {
		t.Fatalf("area wear tiles %v levels %v", got.GetTiles(), got.GetLevels())
	}

	// 10 points every 10 s: both tiles drop under level 1 at the next decay pass, and the
	// clients are told (level 0).
	cl.take()
	for range 220 {
		h.sim.Step()
	}
	if h.w.TrailLevel(pos(3, 1)) != 0 {
		t.Fatal("the grass did not recover")
	}
	rec := wearOf(late.take())
	if !slices.Contains(rec, [2]uint32{xy(3, 1), 0}) || !slices.Contains(rec, [2]uint32{xy(2, 1), 0}) {
		t.Fatalf("recovery sent %v", rec)
	}
	if len(saved) == 0 {
		t.Fatal("no snapshot handed to persistence")
	}
}

// The wear survives a restart (the snapshot's bytes, as the trail_wear row keeps them),
// minus the decay of the downtime; unreadable bytes start without wear.
func TestTrailWearPersistsAcrossARestart(t *testing.T) {
	h := trailHarness(t, nil, nil, 0)
	cl, p := h.join("Walker", at(2, 1))
	for range 2 { // (3, 1) 12 and (2, 1) 12: level 1
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_EAST, pos(3, 1))
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_WEST, pos(2, 1))
	}
	snap, ok := h.w.TrailSnapshot()
	if !ok {
		t.Fatal("no snapshot")
	}
	data := snap.Encode()
	lvl := h.w.TrailLevel(pos(3, 1))

	again := trailHarness(t, nil, data, 0)
	if got := again.w.TrailLevel(pos(3, 1)); got != lvl || got == 0 {
		t.Fatalf("after a restart level %d, want %d", got, lvl)
	}
	// A long downtime: the grass grew back meanwhile.
	if got := trailHarness(t, nil, data, 60_000).w.TrailLevel(pos(3, 1)); got != 0 {
		t.Fatalf("after a minute down level %d, want 0", got)
	}
	if got := trailHarness(t, nil, []byte("junk"), 0).w.TrailLevel(pos(3, 1)); got != 0 {
		t.Fatalf("corrupt data restored level %d", got)
	}
}

// An invisible player leaves no trail: its worn path would show where nobody is seen.
func TestTrailWearIgnoresInvisiblePlayers(t *testing.T) {
	h := trailHarness(t, nil, nil, 0)
	cl, p := h.join("Ghost", at(2, 1))
	h.w.SetInvisibleForTest(p, true)
	for range 3 { // visible, (3, 1) would reach 18: level 1
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_EAST, pos(3, 1))
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_WEST, pos(2, 1))
	}
	if lv := h.w.TrailLevel(pos(3, 1)); lv != 0 {
		t.Fatalf("an invisible player wore the grass to level %d", lv)
	}
}

// MapArea.wear carries only the player's own floor: the level changes of a tile reach the
// players on its floor, so the wear of a floor seen from above would go stale.
func TestTrailWearAreaOnlyOfThePlayersFloor(t *testing.T) {
	m := worldtest.Floors(t, 0, 0,
		worldtest.Layer{Z: 6, Rows: []string{"", "", "", "", "      ..."}},
		worldtest.Layer{Z: 7, Rows: trailRows})
	h := newHarness(t, m, func(c *session.Config) {
		c.Items = trailItems()
		c.Trail = trailConfig()
		c.SaveTrail = func(session.TrailSnapshot) bool { return true }
	})
	cl, p := h.join("Walker", at(2, 1))
	for range 2 { // (3, 1) and (2, 1): level 1 on floor 7
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_EAST, pos(3, 1))
		stepTo(t, h, cl, p, pb.Direction_DIRECTION_WEST, pos(2, 1))
	}
	up := world.Pos{X: 7, Y: 4, Z: 6}
	above, _ := h.join("Above", &up)
	var area *pb.MapArea
	for _, f := range find(above.take(), (*pb.ServerMessage).GetFullMapView) {
		area = f.GetArea()
	}
	if area == nil {
		t.Fatal("no FullMapView")
	}
	if len(area.GetFloors()) < 2 {
		t.Fatalf("the player above sees %d floors, want floor 7 too", len(area.GetFloors()))
	}
	if w := area.GetWear(); len(w) != 0 {
		t.Fatalf("FullMapView on floor 6 carries the wear of floor %d", w[0].GetZ())
	}
}
