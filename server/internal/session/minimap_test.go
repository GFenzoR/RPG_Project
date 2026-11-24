package session_test

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
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

// An acknowledged autosave's sectors are not written again by the next one: only what
// the database may lack (the sectors that gained bits since) goes in a snapshot.
func TestAcknowledgedSectorsAreNotSavedAgain(t *testing.T) {
	h := newHarness(t, wideMap(t), func(c *session.Config) {
		c.Items = testItems()
		c.AutosaveEvery = 40
	})
	cl, p := h.join("Surveyor", at(40, 4)) // view x 25..55: sectors (0,0) and (1,0)
	cl.take()
	h.sim.RunTicks(45)
	if len(h.saves) == 0 {
		t.Fatal("no autosave")
	}
	first := h.saves[len(h.saves)-1]
	if len(first.Explored) != 2 {
		t.Fatalf("first autosave sectors: %v", first.Explored)
	}
	h.sim.Command(h.w.Saved(p.CharacterID(), first.Seq))
	for range 4 { // only sector (1,0) gains bits
		h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	}
	h.sim.RunTicks(45)
	if p.Pos().X < 44 {
		t.Fatalf("did not walk: %v", p.Pos())
	}
	second := h.saves[len(h.saves)-1]
	if second.Seq == first.Seq {
		t.Fatal("no second autosave")
	}
	if len(second.Explored) != 1 || second.Explored[0].Key != explore.KeyOf(32, 0, 7) {
		t.Fatalf("second autosave wrote again what was acknowledged: %v", second.Explored)
	}
	// Not acknowledged: the next snapshot carries it again.
	h.sim.RunTicks(45)
	if third := h.saves[len(h.saves)-1]; len(third.Explored) != 1 || third.Explored[0].Key != explore.KeyOf(32, 0, 7) {
		t.Fatalf("an unacknowledged sector was dropped: %v", third.Explored)
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
	// Budget: 32 sectors at once; the request over it is dropped.
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
	if answered != 2 { // the budget refilled to its cap of 32 since the first request: two of 16
		t.Fatalf("answered %d requests of 16 sectors in a burst", answered)
	}
	// Refill: 32 sectors a second exactly, also for a client asking on every tick (1.6 a
	// tick: the fraction is carried, not rounded away into 20 a second).
	two := 0
	for range 20 {
		h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_MinimapRequest{MinimapRequest: &pb.MinimapRequest{Z: 7, Sectors: ids[:2]}}})
		h.sim.Step()
		two += len(find(cl.take(), (*pb.ServerMessage).GetMinimapSectors))
	}
	if two != 16 {
		t.Fatalf("20 ticks of 2-sector requests on an empty budget: %d answered, want 16 (32 sectors a second)", two)
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

// An answer says it is one (the client stops asking for its sectors); a delta does not,
// so a sector that only came in deltas is still asked for.
func TestMinimapAnswersAreMarkedAndDeltasAreNot(t *testing.T) {
	h := minimapHarness(t)
	cl, _ := h.join("Marker", at(14, 4))
	cl.take()
	h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_MinimapRequest{MinimapRequest: &pb.MinimapRequest{Z: 7, Sectors: []uint32{sectorID(0, 0)}}}})
	h.sim.Step()
	if ms := find(cl.take(), (*pb.ServerMessage).GetMinimapSectors); len(ms) != 1 || !ms[0].GetAnswer() {
		t.Fatalf("answer: %v", ms)
	}
	for range 4 {
		h.input(cl, walk(pb.Direction_DIRECTION_EAST))
	}
	h.sim.RunTicks(60)
	ms := find(cl.take(), (*pb.ServerMessage).GetMinimapSectors)
	if len(ms) == 0 {
		t.Fatal("no delta")
	}
	for _, m := range ms {
		if m.GetAnswer() {
			t.Fatal("a delta says it answers a request")
		}
	}
}

// hintQuests are one-step quests for the places a hint is derived from: a zone, a
// hint_area, a monster's spawns and a point on the map's corner.
const hintQuests = `
id: zone
name: quest.zone.name
steps:
  - { id: go, description: quest.zone.go, complete_when: { reach: { zone: yard } } }
rewards:
  - { xp: 1 }
---
id: area
name: quest.area.name
steps:
  - { id: bring, description: quest.area.bring, complete_when: { has_item: { item: rope, count: 1 } }, hint_area: { x: 9, y: 6, z: 8, radius: 2 } }
rewards:
  - { xp: 1 }
---
id: hunt
name: quest.hunt.name
steps:
  - { id: cull, description: quest.hunt.cull, complete_when: { kill: { monster: dummy, count: 3 } } }
rewards:
  - { xp: 1 }
---
id: corner
name: quest.corner.name
steps:
  - { id: go, description: quest.corner.go, complete_when: { reach: { x: 0, y: 0, z: 8, radius: 1 } } }
rewards:
  - { xp: 1 }
---
id: anywhere
name: quest.anywhere.name
steps:
  - { id: bring, description: quest.anywhere.bring, complete_when: { has_item: { item: rope, count: 1 } } }
rewards:
  - { xp: 1 }
`

// hintHarness is reachHarness plus hintQuests and a harmless monster with a spawn on each
// floor: (12,3) on 7 and (2,6) on 8, radius 1.
func hintHarness(t *testing.T) *harness {
	t.Helper()
	return reachHarness(t, func(c *session.Config) {
		for _, doc := range strings.Split(hintQuests, "\n---\n") {
			q, err := content.ParseQuest([]byte(doc))
			if err != nil {
				t.Fatal(err)
			}
			c.Quests[q.ID] = q
		}
		c.Monsters = content.Monsters{"dummy": {ID: "dummy", Health: 50, Speed: 100, Behavior: content.MonsterBehavior{TargetDistance: 1}}}
		c.Map.Islands()[0].Spawns = []world.Spawn{
			{ID: "up", Center: at3(12, 3, 7), Radius: 1, RespawnSeconds: 600, Monsters: []world.SpawnMonster{{Monster: "dummy", Count: 1}}},
			{ID: "down", Center: at3(2, 6, 8), Radius: 1, RespawnSeconds: 600, Monsters: []world.SpawnMonster{{Monster: "dummy", Count: 1}}},
		}
	})
}

// trackOf starts quest id for p, tracks it and returns the one hint that answers.
func trackOf(t *testing.T, h *harness, cl *fakeClient, p *session.Player, id string) *pb.ObjectiveHint {
	t.Helper()
	h.sim.Command(gameFunc(func() {
		if !h.w.StartQuestForTest(p, id) {
			t.Errorf("quest %s did not start", id)
		}
	}))
	h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_TrackQuest{TrackQuest: &pb.TrackQuest{QuestId: id}}})
	h.sim.Step()
	hs := objectiveHints(cl.take())
	if len(hs) != 1 {
		t.Fatalf("tracking %s: %d hints", id, len(hs))
	}
	return hs[0]
}

// checkArea checks hint h: quest and step, the floor, never centred on the target x, y and
// the whole target area (tr tiles around it) inside the circle.
func checkArea(t *testing.T, h *pb.ObjectiveHint, questID, step string, x, y, z, tr int) {
	t.Helper()
	c := h.GetCenter()
	if h.GetQuestId() != questID || h.GetStepId() != step || c == nil || int(c.GetZ()) != z {
		t.Fatalf("hint %v, want %s/%s on floor %d", h, questID, step, z)
	}
	if int(c.GetX()) == x && int(c.GetY()) == y {
		t.Fatalf("the hint of %s is the exact target %d,%d", questID, x, y)
	}
	for _, k := range [][2]int{{-tr, -tr}, {tr, -tr}, {-tr, tr}, {tr, tr}} {
		if d := math.Hypot(float64(int(c.GetX())-x-k[0]), float64(int(c.GetY())-y-k[1])); d > float64(h.GetRadius())+1e-9 {
			t.Fatalf("%s: corner %v of the target %d,%d outside the hint %v", questID, k, x, y, h)
		}
	}
}

// The place of a step: a zone's bounding box, the YAML's hint_area (another floor), the
// nearest spawn of the monster to kill; a step done anywhere has none.
func TestHintPlaces(t *testing.T) {
	h := hintHarness(t)
	cl, p := h.join("Guide", at(5, 3))
	cl.take()
	// The zone yard is 11..12 x 4 on floor 7: centred on (11,4), 1 tile around.
	checkArea(t, trackOf(t, h, cl, p, "zone"), "zone", "go", 11, 4, 7, 1)
	checkArea(t, trackOf(t, h, cl, p, "area"), "area", "bring", 9, 6, 8, 2)
	if hint := trackOf(t, h, cl, p, "anywhere"); hint.GetQuestId() != "anywhere" || hint.GetCenter() != nil {
		t.Fatalf("a step done anywhere has a place: %v", hint)
	}
	// The spawn of its own floor first, though the one downstairs is nearer in x, y.
	checkArea(t, trackOf(t, h, cl, p, "hunt"), "hunt", "cull", 12, 3, 7, 1)

	// Taking the stairs down: the nearest spawn is now the one of floor 8, and the hint
	// follows without a new TrackQuest.
	evs := h.step(cl, N)
	if p.Pos() != at3(5, 3, 8) {
		t.Fatalf("did not take the stairs: %v", p.Pos())
	}
	hs := objectiveHints(evs)
	if len(hs) != 1 {
		t.Fatalf("after the stairs: %d hints", len(hs))
	}
	checkArea(t, hs[0], "hunt", "cull", 2, 6, 8, 1)
	// Walking on the same floor sends nothing more.
	if hs := objectiveHints(h.step(cl, E)); len(hs) != 0 {
		t.Fatalf("a step on the same floor sent %d hints", len(hs))
	}
}

// A target on the map's corner: the estimate that would fall off the map is mirrored, not
// clamped onto the target itself, for every character.
func TestHintOnTheMapCornerIsNeverTheTarget(t *testing.T) {
	h := hintHarness(t)
	for i := range 24 {
		cl, p := h.join(fmt.Sprintf("Edge%d", i), at(1+i%12, 5+i/12))
		cl.take()
		checkArea(t, trackOf(t, h, cl, p, "corner"), "corner", "go", 0, 0, 8, 1)
	}
}

// An untrack is always answered, also when a quest of the player changes in the same tick
// (the change must not take the pending answer away).
func TestUntrackIsAnsweredWhenAQuestChangesInTheSameTick(t *testing.T) {
	h := hintHarness(t)
	cl, p := h.join("Fickle", at(1, 4))
	cl.take()
	trackOf(t, h, cl, p, "zone")
	h.input(cl, &pb.ClientMessage{Message: &pb.ClientMessage_TrackQuest{TrackQuest: &pb.TrackQuest{}}})
	h.sim.Command(gameFunc(func() { h.w.StartQuestForTest(p, "area") }))
	h.sim.Step()
	hs := objectiveHints(cl.take())
	if len(hs) != 1 || hs[0].GetQuestId() != "" {
		t.Fatalf("untrack with a quest change in its tick: %v", hs)
	}
	// And nothing is left pending: the next quest change sends no hint.
	h.sim.Command(gameFunc(func() { h.w.StartQuestForTest(p, "anywhere") }))
	h.sim.Step()
	if hs := objectiveHints(cl.take()); len(hs) != 0 {
		t.Fatalf("a hint with nothing tracked: %v", hs)
	}
}
