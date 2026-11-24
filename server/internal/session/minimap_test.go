package session_test

import (
	"math"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/explore"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// wideMap is 96x8 tiles of grass (three sectors across) with a wall at (5,2).
func wideMap(t *testing.T) *world.Map {
	t.Helper()
	rows := make([]string, 8)
	for i := range rows {
		row := make([]byte, 96)
		for j := range row {
			row[j] = '.'
		}
		if i == 2 {
			row[5] = '#'
		}
		rows[i] = string(row)
	}
	return worldtest.Map(t, 0, 0, 7, rows...)
}

func minimapHarness(t *testing.T) *harness {
	t.Helper()
	return newHarness(t, wideMap(t), func(c *session.Config) { c.Items = testItems() })
}

func minimapIndexes(evs []*pb.ServerMessage) []*pb.MinimapIndex {
	return find(evs, (*pb.ServerMessage).GetMinimapIndex)
}

func minimapSectors(evs []*pb.ServerMessage) []*pb.MinimapSector {
	var out []*pb.MinimapSector
	for _, m := range find(evs, (*pb.ServerMessage).GetMinimapSectors) {
		out = append(out, m.GetSectors()...)
	}
	return out
}

func sectorID(sx, sy int) uint32 { return uint32(sx)<<16 | uint32(sy) }

func bit(bits []byte, lx, ly int) bool {
	i := ly*32 + lx
	return len(bits) == 128 && bits[i>>3]&(1<<(i&7)) != 0
}

func indexHas(idx *pb.MinimapIndex, z uint32, id uint32) bool {
	for _, f := range idx.GetFloors() {
		if f.GetZ() != z {
			continue
		}
		for _, s := range f.GetSectors() {
			if s == id {
				return true
			}
		}
	}
	return false
}

// The view explores at login, walking explores more (sent as a delta at most once a
// second) and the final snapshot carries every sector that gained bits; logging in again
// with what was saved, the index has them all.
func TestExploreOnLoginWalkAndSave(t *testing.T) {
	h := minimapHarness(t)
	cl, p := h.join("Scout", at(14, 4))
	evs := cl.take()
	idx := minimapIndexes(evs)
	if len(idx) != 1 {
		t.Fatalf("login: %d MinimapIndex in %v", len(idx), kinds(evs))
	}
	// View 31 wide: x -1..29 from 14: sector 0 only.
	if !indexHas(idx[0], 7, sectorID(0, 0)) || indexHas(idx[0], 7, sectorID(1, 0)) {
		t.Fatalf("login index: %v", idx[0])
	}
	if len(minimapSectors(evs)) != 0 {
		t.Fatal("the login's own view came again as a delta")
	}
	for range 4 {
		h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	}
	h.sim.RunTicks(60)
	if p.Pos().X < 18 {
		t.Fatalf("did not walk: %v", p.Pos())
	}
	evs = cl.take()
	deltas := minimapSectors(evs)
	var s1 *pb.MinimapSector
	for _, s := range deltas {
		if s.GetSector() == sectorID(1, 0) {
			s1 = s
		}
		if len(s.GetTiles()) != 0 || len(s.GetPalette()) != 0 {
			t.Fatal("a delta carries tiles: the client colours them from its own view")
		}
	}
	if s1 == nil || !bit(s1.GetExplored(), 0, 4) {
		t.Fatalf("no delta for sector (1,0): %v", deltas)
	}
	if n := len(find(evs, (*pb.ServerMessage).GetMinimapSectors)); n > 3 {
		t.Fatalf("%d deltas in 60 ticks: more than one a second", n)
	}

	h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	h.sim.Step()
	if len(h.saves) == 0 {
		t.Fatal("no save")
	}
	final := h.saves[len(h.saves)-1]
	keys := map[explore.Key]bool{}
	for _, s := range final.Explored {
		keys[s.Key] = true
	}
	if !keys[explore.KeyOf(0, 0, 7)] || !keys[explore.KeyOf(32, 0, 7)] {
		t.Fatalf("final snapshot sectors: %v", keys)
	}

	// A quick re-login gets them from the final snapshot (not saved yet).
	cl2 := &fakeClient{}
	h.sim.Command(h.joinCmd(session.Character{ID: p.CharacterID(), AccountID: 99, Name: "Scout", Vocation: "guardian",
		Level: 1, Health: 145}, cl2))
	h.sim.Step()
	idx = minimapIndexes(cl2.take())
	if len(idx) != 1 || !indexHas(idx[0], 7, sectorID(0, 0)) || !indexHas(idx[0], 7, sectorID(1, 0)) {
		t.Fatalf("quick relogin index: %v", idx)
	}
	h.input(cl2, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}})
	h.sim.Step()
	if last := h.saves[len(h.saves)-1]; len(last.Explored) < 2 {
		t.Fatalf("the quick relogin's save dropped the unsaved sectors: %d", len(last.Explored))
	}

	// Back from the database, standing at the far end: the saved sectors and the new view.
	c := session.Character{ID: 4242, AccountID: 4242, Name: "Scout2", Vocation: "guardian", Level: 1, Health: 145,
		Pos: pos(90, 4), HasPos: true, Explored: final.Explored}
	cl3 := &fakeClient{}
	h.sim.Command(h.joinCmd(c, cl3))
	h.sim.Step()
	idx = minimapIndexes(cl3.take())
	if len(idx) != 1 || !indexHas(idx[0], 7, sectorID(0, 0)) || !indexHas(idx[0], 7, sectorID(1, 0)) ||
		!indexHas(idx[0], 7, sectorID(2, 0)) {
		t.Fatalf("relogin index: %v", idx)
	}
}

// A MinimapRequest gets the colour item of explored tiles only (a wall on top of its
// ground), nothing of an unexplored sector, nothing for another floor, and nothing past
// the budget.
func TestMinimapRequestSendsOnlyExploredTiles(t *testing.T) {
	h := minimapHarness(t)
	cl, _ := h.join("Cartographer", at(2, 4))
	cl.take()
	req := func(z uint32, ids ...uint32) {
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_MinimapRequest{MinimapRequest: &pb.MinimapRequest{Z: z, Sectors: ids}}})
		h.sim.Step()
	}
	req(7, sectorID(0, 0), sectorID(2, 0), sectorID(0, 0))
	got := minimapSectors(cl.take())
	if len(got) != 2 {
		t.Fatalf("answer: %d sectors", len(got))
	}
	s0, s2 := got[0], got[1]
	if s2.GetSector() != sectorID(2, 0) || len(s2.GetExplored()) != 0 || len(s2.GetTiles()) != 0 {
		t.Fatalf("unexplored sector came with data: %v", s2)
	}
	if len(s0.GetTiles()) != 1024 {
		t.Fatalf("sector 0 tiles: %d bytes", len(s0.GetTiles()))
	}
	colour := func(x, y int) uint32 {
		i := s0.GetTiles()[y*32+x]
		if i == 0 {
			return 0
		}
		return s0.GetPalette()[i-1]
	}
	if colour(2, 4) != worldtest.Grass || colour(5, 2) != worldtest.Wall {
		t.Fatalf("colours: ground %d, wall tile %d", colour(2, 4), colour(5, 2))
	}
	// View from x=2: up to x=17. The tile past it exists but was not seen.
	if colour(17, 4) == 0 || colour(18, 4) != 0 || bit(s0.GetExplored(), 18, 4) {
		t.Fatal("an unexplored tile was revealed")
	}
	req(8, sectorID(0, 0))
	if n := len(minimapSectors(cl.take())); n != 0 {
		t.Fatalf("another floor answered %d sectors", n)
	}
	// Budget: 64 sectors at once; the request over it is dropped.
	ids := make([]uint32, 16)
	for i := range ids {
		ids[i] = sectorID(i, 1)
	}
	answered := 0
	for range 5 {
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_MinimapRequest{MinimapRequest: &pb.MinimapRequest{Z: 7, Sectors: ids}}})
	}
	h.sim.Step()
	answered = len(find(cl.take(), (*pb.ServerMessage).GetMinimapSectors))
	if answered != 4 { // the budget refilled to its cap of 64 since the first request: four of 16
		t.Fatalf("answered %d requests of 16 sectors in a burst", answered)
	}
	// Too many in one request: dropped.
	h.sim.RunTicks(200)
	req(7, append(ids, sectorID(20, 1))...)
	if n := len(minimapSectors(cl.take())); n != 0 {
		t.Fatalf("a request of 17 sectors answered %d", n)
	}
}

func objectiveHints(evs []*pb.ServerMessage) []*pb.ObjectiveHint {
	return find(evs, (*pb.ServerMessage).GetObjectiveHint)
}

// Tracking a quest sends the estimate of its step's place: never the exact tile, the
// target inside the circle; it follows the step (another floor too) and a quest not in
// progress tracks nothing.
func TestTrackQuestSendsAFuzzedHint(t *testing.T) {
	h := reachHarness(t)
	cl, p := h.join("Seeker", at(1, 4))
	track := func(id string) {
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_TrackQuest{TrackQuest: &pb.TrackQuest{QuestId: id}}})
		h.sim.Step()
	}
	cl.take()
	track("errand") // not started
	hs := objectiveHints(cl.take())
	if len(hs) != 1 || hs[0].GetQuestId() != "" {
		t.Fatalf("hint of a quest not started: %v", hs)
	}
	h.sim.Command(gameFunc(func() { h.w.StartQuestForTest(p, "errand") }))
	h.sim.Step()
	if hs := objectiveHints(cl.take()); len(hs) != 0 {
		t.Fatal("a hint came for an untracked quest")
	}
	track("errand")
	hs = objectiveHints(cl.take())
	if len(hs) != 1 {
		t.Fatalf("%d hints", len(hs))
	}
	checkHint(t, hs[0], "walk_east", 3, 4, 7)
	track("errand") // asked again: answered again, the same
	if again := objectiveHints(cl.take()); len(again) != 1 || again[0].GetCenter().GetX() != hs[0].GetCenter().GetX() {
		t.Fatalf("second answer: %v", again)
	}
	// Walking onto (3,4) completes the step: the next one is downstairs, on floor 8.
	h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	h.sim.RunTicks(40)
	hs = objectiveHints(cl.take())
	if len(hs) != 1 {
		t.Fatalf("after the step: %d hints", len(hs))
	}
	checkHint(t, hs[0], "downstairs", 5, 3, 8)
	track("")
	if hs := objectiveHints(cl.take()); len(hs) != 1 || hs[0].GetQuestId() != "" {
		t.Fatalf("untrack: %v", hs)
	}
}

func checkHint(t *testing.T, h *pb.ObjectiveHint, step string, x, y, z int) {
	t.Helper()
	c := h.GetCenter()
	if h.GetQuestId() != "errand" || h.GetStepId() != step || int(c.GetZ()) != z {
		t.Fatalf("hint %v, want step %s on floor %d", h, step, z)
	}
	if int(c.GetX()) == x && int(c.GetY()) == y {
		t.Fatalf("the hint is the exact target %d,%d", x, y)
	}
	if d := math.Hypot(float64(int(c.GetX())-x), float64(int(c.GetY())-y)); d > float64(h.GetRadius()) {
		t.Fatalf("target %d,%d outside the hint %v", x, y, h)
	}
}
