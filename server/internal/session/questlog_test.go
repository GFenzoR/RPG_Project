package session_test

import (
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// errandQuest is the reach quest of the reach tests, on portalMap: a walk to a tile, the
// stairs down (a portal), a zone reached by a teleport and the temple reached by dying.
const errandQuest = `
id: errand
name: quest.errand.name
chapter: 2
steps:
  - { id: walk_east, description: quest.errand.walk, complete_when: { reach: { x: 3, y: 4, z: 7 } } }
  - { id: downstairs, description: quest.errand.down, complete_when: { reach: { x: 5, y: 3, z: 8, radius: 1 } } }
  - { id: yard, description: quest.errand.yard, complete_when: { reach: { zone: yard } } }
  - { id: temple, description: quest.errand.temple, complete_when: { reach: { x: 0, y: 0, z: 7, radius: 1 } } }
rewards:
  - { xp: 100 }
`

// reachHarness runs portalMap (arrivals within 1) with errandQuest and the zone yard
// (11..12 × 4, floor 7); opts change the config after that.
func reachHarness(t *testing.T, opts ...option) *harness {
	t.Helper()
	m := portalMap(t)
	m.Islands()[0].Zones = []world.Zone{{ID: "yard", Floors: []uint8{7}, Rects: []world.ZoneRect{{X: 11, Y: 4, W: 2, H: 1}}}}
	q, err := content.ParseQuest([]byte(errandQuest))
	if err != nil {
		t.Fatal(err)
	}
	return newHarness(t, m, append([]option{func(c *session.Config) {
		c.Items = testItems()
		c.Balance.Travel.ArrivalRadius = 1
		c.Quests = content.Quests{q.ID: q}
	}}, opts...)...)
}

// questLogs are the QuestLog messages of evs.
func questLogs(evs []*pb.ServerMessage) []*pb.QuestLog {
	return find(evs, (*pb.ServerMessage).GetQuestLog)
}

// logEntry is quest id's entry of the last QuestLog of evs, or nil when that log has none;
// it fails the test when evs have no QuestLog.
func logEntry(t *testing.T, evs []*pb.ServerMessage, id string) *pb.QuestLogEntry {
	t.Helper()
	logs := questLogs(evs)
	if len(logs) == 0 {
		t.Fatalf("no QuestLog in %v", kinds(evs))
	}
	for _, e := range logs[len(logs)-1].GetEntries() {
		if e.GetQuestId() == id {
			return e
		}
	}
	return nil
}

// A reach step completes when the player gets to its place: walking there, and also when
// a relocation puts it there (stairs, a teleport, waking up at the temple). Each change
// sends the QuestLog once, in its tick.
func TestReachStepsOnMovesAndRelocations(t *testing.T) {
	h := reachHarness(t)
	cl, p := h.join("Walker", at(1, 4))
	if evs := cl.take(); len(questLogs(evs)) != 1 || logEntry(t, evs, "errand") != nil {
		t.Fatalf("login: %d quest logs", len(questLogs(evs)))
	}
	h.sim.Command(gameFunc(func() { h.w.StartQuestForTest(p, "errand") }))
	h.sim.Step()
	evs := cl.take()
	e := logEntry(t, evs, "errand")
	if len(questLogs(evs)) != 1 || e == nil || e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_ACTIVE ||
		e.GetStepId() != "walk_east" || e.GetStepText() != "quest.errand.walk" || e.GetName() != "quest.errand.name" ||
		e.GetChapter() != 2 || e.GetKillsNeeded() != 0 {
		t.Fatalf("started: %v", e)
	}
	step := func() string { _, s := h.w.QuestState(p, "errand"); return s }

	// Walking: one step short counts for nothing; the tile itself completes the step.
	if evs := h.step(cl, E); step() != "walk_east" || len(questLogs(evs)) != 0 {
		t.Fatalf("at %v the step is %q (%d logs)", p.Pos(), step(), len(questLogs(evs)))
	}
	evs = h.step(cl, E)
	if p.Pos() != pos(3, 4) || step() != "downstairs" || !messageKeys(evs)["dialog.quest_updated"] {
		t.Fatalf("at %v the step is %q (%v)", p.Pos(), step(), messageKeys(evs))
	}
	if e := logEntry(t, evs, "errand"); e.GetStepId() != "downstairs" || len(questLogs(evs)) != 1 {
		t.Fatalf("log after the walk: %v", e)
	}

	// The stairs: the step onto them lands on floor 8, by the place.
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, at3(5, 3, 7)) }))
	h.sim.Step()
	if step() != "downstairs" {
		t.Fatalf("a teleport on floor 7 completed the step on floor 8: %q", step())
	}
	h.step(cl, N)
	if p.Pos().Z != 8 || step() != "yard" {
		t.Fatalf("down the stairs at %v the step is %q", p.Pos(), step())
	}

	// A teleport (a GM, a dialog) into the zone.
	h.sim.RunFor(1e9)
	cl.take()
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(12, 4)) }))
	h.sim.Step()
	if evs := cl.take(); step() != "temple" || logEntry(t, evs, "errand").GetStepId() != "temple" {
		t.Fatalf("teleported into the yard the step is %q", step())
	}

	// Dying wakes it up at the temple: the last step, and the quest is done.
	h.kill(p)
	evs = cl.take()
	if s, _ := h.w.QuestState(p, "errand"); s != quest.Completed || !messageKeys(evs)["dialog.quest_completed"] {
		t.Fatalf("at the temple %v: %v", s, messageKeys(evs))
	}
	if e := logEntry(t, evs, "errand"); e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_DONE || e.GetStepId() != "" ||
		e.GetRepeatable() || e.GetAvailableAt() != 0 {
		t.Fatalf("log after the quest: %v", e)
	}
	// Done: no more reach steps to watch, and walking sends nothing.
	if evs := h.step(cl, E); len(questLogs(evs)) != 0 {
		t.Fatal("a QuestLog without a change")
	}
}

// A player who logs in standing in the place of its current reach step gets it at once;
// one who is elsewhere does not.
func TestReachStepAtLogin(t *testing.T) {
	h := reachHarness(t)
	c := session.Character{ID: 7101, AccountID: 7101, Name: "Back", Vocation: "guardian", Level: 1, Health: 145, Mana: 20,
		Pos: pos(3, 4), HasPos: true,
		Storage: map[string]int64{"quest.errand": int64(quest.InProgress)}} // at walk_east
	cl, p := h.joinChar(c)
	evs := cl.take()
	if _, s := h.w.QuestState(p, "errand"); s != "downstairs" || !messageKeys(evs)["dialog.quest_updated"] {
		t.Fatalf("logged in on the place: step %q", s)
	}
	if e := logEntry(t, evs, "errand"); e.GetStepId() != "downstairs" {
		t.Fatalf("the last log of the login tick: %v", e)
	}
	c2 := c
	c2.ID, c2.AccountID, c2.Name, c2.Pos = 7102, 7102, "Away", pos(8, 6)
	cl2, p2 := h.joinChar(c2)
	if _, s := h.w.QuestState(p2, "errand"); s != "walk_east" {
		t.Fatalf("logged in elsewhere: step %q", s)
	}
	if e := logEntry(t, cl2.take(), "errand"); e.GetStepId() != "walk_east" {
		t.Fatalf("login log: %v", e)
	}
}

// The QuestLog of the real chapter 1 follows its kill step: one per kill counted (1/6 to
// 5/6), and the sixth wolf, which completes the step, sends the next one (0/5 bats).
func TestQuestLogFollowsKills(t *testing.T) {
	h := dataHarness(t, world.Spawn{ID: "wolves", Center: pos(40, 44), Radius: 3, RespawnSeconds: 60,
		Monsters: []world.SpawnMonster{{Monster: "wolf", Count: 6}}})
	c := session.Character{ID: 7201, AccountID: 7201, Name: "Logger", Vocation: "guardian", Level: 20, Health: 1000, Mana: 100}
	cl, p := h.joinFresh(c, pos(10, 10))
	h.sim.Step()
	cl.take()
	d := h.lastDialog(h.send(cl, talkMsg(h.npc("harbor_master").ID())))
	d = h.lastDialog(h.pick(cl, d, "npc.harbor_master.opt_shipwreck"))
	evs := h.pick(cl, d, "dialog.accept")
	e := logEntry(t, evs, "ch1_shipwreck")
	if len(questLogs(evs)) != 1 || e == nil || e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_ACTIVE || e.GetStepId() != "clear_wolves" ||
		e.GetStepText() != "quest.ch1_shipwreck.step_clear_wolves" || e.GetKills() != 0 || e.GetKillsNeeded() != 6 ||
		e.GetChapter() != 1 || e.GetName() != "quest.ch1_shipwreck.name" {
		t.Fatalf("accepted: %v", e)
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, pos(36, 44)) }))
	h.hunt(cl, p, "wolf", 6)
	type seen struct {
		step        string
		kills, need uint32
	}
	var got []seen
	for _, l := range questLogs(cl.take()) {
		for _, en := range l.GetEntries() {
			if en.GetQuestId() == "ch1_shipwreck" {
				got = append(got, seen{en.GetStepId(), en.GetKills(), en.GetKillsNeeded()})
			}
		}
	}
	want := []seen{{"clear_wolves", 1, 6}, {"clear_wolves", 2, 6}, {"clear_wolves", 3, 6}, {"clear_wolves", 4, 6},
		{"clear_wolves", 5, 6}, {"mine_bats", 0, 5}}
	if len(got) != len(want) {
		t.Fatalf("quest logs %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("quest logs %v, want %v", got, want)
		}
	}
}

// A dialog's set_quest_step onto a reach step the player is away from changes the quest:
// the QuestLog says so in that tick, and walking into the place later completes the step
// (the reach places p's moves are checked against were read again).
func TestSetQuestStepOntoReach(t *testing.T) {
	guide, err := content.ParseNPC([]byte(`{id: guide, name: npc.guide.name, dialog: {start: greet, nodes: {
		greet: {text: npc.guide.greet, options: [
			{text: npc.guide.yard, action: {set_quest_step: {quest: errand, step: yard}}, goto: sent}]},
		sent: {text: npc.guide.sent, options: [{text: dialog.bye, action: close}]}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	h := reachHarness(t, func(c *session.Config) {
		c.NPCs = content.NPCs{guide.ID: guide}
		is := c.Map.Islands()[0]
		is.NPCs = append(is.NPCs, world.NPCPlacement{NPC: "guide", Pos: pos(8, 6)})
	})
	cl, p := h.join("Errand", at(8, 4))
	h.sim.Command(gameFunc(func() { h.w.StartQuestForTest(p, "errand") }))
	h.sim.Step()
	step := func() string { _, s := h.w.QuestState(p, "errand"); return s }
	// A step reads the places of the quest's first step (walk_east, at 3,4).
	if h.step(cl, W); p.Pos() != pos(7, 4) || step() != "walk_east" {
		t.Fatalf("at %v the step is %q", p.Pos(), step())
	}
	h.sim.RunFor(time.Second)
	cl.take()
	d := h.lastDialog(h.send(cl, talkMsg(h.npc("guide").ID())))
	evs := h.pick(cl, d, "npc.guide.yard")
	if step() != "yard" {
		t.Fatalf("after the dialog the step is %q", step())
	}
	if e := logEntry(t, evs, "errand"); len(questLogs(evs)) != 1 || e.GetStepId() != "yard" || e.GetStepText() != "quest.errand.yard" {
		t.Fatalf("quest log of the dialog's tick: %v", e)
	}
	for _, x := range []int{8, 9, 10} {
		if evs := h.step(cl, E); p.Pos() != pos(x, 4) || step() != "yard" || len(questLogs(evs)) != 0 {
			t.Fatalf("at %v the step is %q (%d logs)", p.Pos(), step(), len(questLogs(evs)))
		}
	}
	evs = h.step(cl, E)
	if p.Pos() != pos(11, 4) || step() != "temple" {
		t.Fatalf("walked into the yard at %v: the step is %q", p.Pos(), step())
	}
	if e := logEntry(t, evs, "errand"); e.GetStepId() != "temple" {
		t.Fatalf("quest log after the yard: %v", e)
	}
}

// A step onto stairs inside a reach place does not count: the player never stands on
// the entrance, it lands below. Its reward, which does not fit, would drop on the stairs.
// Walking into the place afterwards does count, and the reward lands on that tile.
func TestReachSkipsPortalEntrances(t *testing.T) {
	q, err := content.ParseQuest([]byte(`
id: landing
name: quest.landing.name
steps:
  - { id: by_stairs, description: quest.landing.step, complete_when: { reach: { x: 6, y: 1, z: 7, radius: 1 } } }
rewards:
  - { item: test_sword }
`))
	if err != nil {
		t.Fatal(err)
	}
	h := reachHarness(t, func(c *session.Config) { c.Quests = content.Quests{q.ID: q} })
	cl, p := h.join("Stairs", at(4, 3)) // no backpack: the sword goes to the floor
	h.sim.Command(gameFunc(func() { h.w.StartQuestForTest(p, "landing") }))
	h.sim.Step()
	state := func() quest.State { s, _ := h.w.QuestState(p, "landing"); return s }
	if state() != quest.InProgress {
		t.Fatalf("not started: %v", state())
	}
	h.step(cl, NE) // onto the stairs (5,2,7), in the place, and down to floor 8
	if p.Pos().Z != 8 || state() != quest.InProgress || len(h.w.GroundAt(stairsDown)) != 0 {
		t.Fatalf("through the stairs at %v: quest %v, %d items on the stairs", p.Pos(), state(), len(h.w.GroundAt(stairsDown)))
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(p, at3(5, 3, 7)) }))
	h.sim.Step()
	h.step(cl, NE) // (6,2,7): in the place
	if p.Pos() != at3(6, 2, 7) || state() != quest.Completed || len(h.w.GroundAt(at3(6, 2, 7))) != 1 {
		t.Fatalf("walked in at %v: quest %v, %d items there", p.Pos(), state(), len(h.w.GroundAt(p.Pos())))
	}
}

// The server refuses to start with a reach place it cannot resolve on the map, or whose
// every tile is the entrance of stairs, a hole or a teleport (nobody stands there).
func TestReachPlaceChecksAtStart(t *testing.T) {
	stairsOnly := []world.ZoneRect{{X: stairsDown.X, Y: stairsDown.Y, W: 1, H: 1}}
	for _, tc := range []struct {
		name, reach string
		zone        []world.ZoneRect
		refused     string
	}{
		{"unknown zone", "{ zone: nowhere }", nil, "is no zone of the map"},
		{"off the island", "{ x: 40, y: 3, z: 7 }", nil, "is on no island"},
		{"floor not listed", "{ x: 3, y: 3, z: 9 }", nil, "is on no island"},
		{"the stairs alone", "{ x: 5, y: 2, z: 7 }", nil, "nobody stands"},
		{"a zone of the stairs alone", "{ zone: spot }", stairsOnly, "nobody stands"},
		{"the hole alone", "{ x: 8, y: 2, z: 7, radius: 0 }", nil, "nobody stands"},
		{"the stairs and around", "{ x: 5, y: 2, z: 7, radius: 1 }", nil, ""},
		{"a zone of the stairs and a tile", "{ zone: spot }", append(stairsOnly, world.ZoneRect{X: 1, Y: 1, W: 1, H: 1}), ""},
		{"a ladder (taken by use)", "{ x: 2, y: 5, z: 8 }", nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q, err := content.ParseQuest([]byte("{id: spot_quest, name: n, steps: [{id: s, complete_when: {reach: " + tc.reach + "}}]}"))
			if err != nil {
				t.Fatal(err)
			}
			m := portalMap(t)
			if tc.zone != nil {
				m.Islands()[0].Zones = []world.Zone{{ID: "spot", Floors: []uint8{7}, Rects: tc.zone}}
			}
			_, err = session.New(session.Config{Map: m, Balance: testBalance(), Vocations: testVocations, Items: testItems(),
				Quests: content.Quests{q.ID: q}, Save: func(session.Snapshot) bool { return true }})
			switch {
			case tc.refused == "" && err != nil:
				t.Fatalf("refused: %v", err)
			case tc.refused != "" && (err == nil || !strings.Contains(err.Error(), tc.refused)):
				t.Fatalf("err = %v, want %q", err, tc.refused)
			}
		})
	}
}
