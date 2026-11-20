package session_test

import (
	"fmt"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/quest"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

// Milestone quests (docs/02 "Quests de hito", sigil.go): every plate held in the same tick
// by a player that meets the requirements moves all of them to the reward room and
// completes the step for each; anyone missing something keeps everyone where they are.

// sigilMap has two rooms of plates: 1 and 2 (the pair) at 2,2 and 4,2; 1 to 4 (the four
// vocations) on row 6. The reward room is far east (dest 18,2 and 18,6).
var sigilMap = []string{
	"T...................",
	"....................",
	"..1.2...............",
	"....................",
	"....................",
	"....................",
	"..1.2.3.4...........",
	"....................",
}

const pairQuest = `
id: pair
name: quest.pair.name
milestone: true
title: quest.pair.title
requires: { level: 20, players: 2, gear: { item: test_tunic } }
steps:
  - id: plates
    description: quest.pair.plates
    complete_when: { sigils: { x: 3, y: 2, z: 7, radius: 1, to: { x: 18, y: 2, z: 7 } } }
rewards:
  - { xp: 500 }
`

const fourQuest = `
id: four
name: quest.four.name
milestone: true
title: quest.four.title
requires: { level: 30, players: 4, vocations: [guardian, arcanist, ranger, druid] }
steps:
  - id: plates
    description: quest.four.plates
    complete_when: { sigils: { x: 5, y: 6, z: 7, radius: 3, to: { x: 18, y: 6, z: 7 } } }
rewards:
  - { xp: 900 }
`

// sigilVocations are the four vocations of the test, guardian's numbers for all.
func sigilVocations() content.Vocations {
	vs := content.Vocations{}
	for _, id := range []string{"guardian", "arcanist", "ranger", "druid"} {
		v := testVocations["guardian"]
		v.ID = id
		vs[id] = v
	}
	return vs
}

func sigilHarness(t *testing.T) *harness {
	t.Helper()
	m := worldtest.Map(t, 0, 0, 7, sigilMap...)
	return newHarness(t, m, func(c *session.Config) {
		items := testItems()
		// The pair's plates are 1 and 2 with no vocation; the four's are 1 to 4 with one
		// each. Plate items are shared, so the pair room's 1 and 2 are the guardian's and
		// the arcanist's: the pair test pairs a guardian with an arcanist.
		for i, v := range []string{"guardian", "arcanist", "ranger", "druid"} {
			var it content.Item
			raw := fmt.Sprintf("{id: plate_%s, kind: decoration, pickupable: false, sigil: {vocation: %s}}", v, v)
			if err := yaml.Unmarshal([]byte(raw), &it); err != nil {
				t.Fatal(err)
			}
			it.Numeric = worldtest.Plate1 + uint16(i)
			items[it.ID] = &it
		}
		c.Items = items
		c.Vocations = sigilVocations()
		c.Balance.Travel.ArrivalRadius = 2
		qs := content.Quests{}
		for _, raw := range []string{strings.Replace(pairQuest, "players: 2,", "players: 2, vocations: [guardian, arcanist],", 1), fourQuest} {
			q, err := content.ParseQuest([]byte(raw))
			if err != nil {
				t.Fatal(err)
			}
			qs[q.ID] = q
		}
		c.Quests = qs
	})
}

// hero joins a character of vocation voc and level lvl at p, with a tunic in its pack
// when tunic, and starts quest id unless it is "".
func hero(h *harness, name, voc string, lvl int, p world.Pos, tunic bool, id string) (*fakeClient, *session.Player) {
	h.t.Helper()
	nextChar++
	var pack []session.ItemState
	if tunic {
		pack = append(pack, session.ItemState{ItemID: tunicID, Count: 1})
	}
	c := withPack(nextChar, p, pack...)
	c.Name, c.Vocation, c.Level, c.Experience = name, voc, lvl, experienceFor(lvl)
	cl, pl := h.joinChar(c)
	if id != "" {
		h.sim.Command(gameFunc(func() { h.w.StartQuestForTest(pl, id) }))
		h.sim.Step()
	}
	cl.take()
	return cl, pl
}

// experienceFor is the experience of level lvl in testBalance (enough to keep it).
func experienceFor(lvl int) int64 {
	if lvl <= 1 {
		return 0
	}
	return 50 * int64(lvl) * int64(lvl) * int64(lvl)
}

func questState(h *harness, p *session.Player, id string) quest.State {
	s, _ := h.w.QuestState(p, id)
	return s
}

// The pair: the first on a plate waits (1 of 2), the second completes it for both in that
// tick; both land in the reward room, hear who did it and are done, once.
func TestMilestoneTwoPlayers(t *testing.T) {
	h := sigilHarness(t)
	ca, a := hero(h, "Aldra", "guardian", 22, pos(2, 3), true, "pair")
	cb, b := hero(h, "Brune", "arcanist", 21, pos(4, 3), true, "pair")

	evs := h.step(ca, N)
	if a.Pos() != pos(2, 2) || !hasKey(evs, "milestone.waiting") {
		t.Fatalf("on the plate at %v: %v", a.Pos(), systemKeys(evs))
	}
	// Looking at a plate tells how many are held.
	evs = h.send(cb, lookAt(onTile(pos(2, 2)), worldtest.Plate1, 1))
	looks := find(evs, (*pb.ServerMessage).GetChatMessage)
	var plates *pb.LocalizedText
	for _, m := range looks {
		if strings.HasPrefix(m.GetLocalized().GetKey(), "milestone.plates") {
			plates = m.GetLocalized()
		}
	}
	if plates == nil || plates.GetParams()[1].GetNumber() != 1 || plates.GetParams()[2].GetNumber() != 2 {
		t.Fatalf("look: %v", plates)
	}

	evs = h.step(cb, N)
	ea := ca.take()
	if a.Pos().X < 16 || b.Pos().X < 16 || a.Pos() == b.Pos() {
		t.Fatalf("not moved together: %v %v", a.Pos(), b.Pos())
	}
	if questState(h, a, "pair") != quest.Completed || questState(h, b, "pair") != quest.Completed {
		t.Fatal("not completed for both")
	}
	if !hasKey(evs, "milestone.achieved") || !hasKey(ea, "milestone.achieved") {
		t.Fatalf("achieved: %v / %v", systemKeys(evs), systemKeys(ea))
	}
	for _, m := range find(evs, (*pb.ServerMessage).GetChatMessage) {
		if m.GetLocalized().GetKey() == "milestone.achieved" &&
			m.GetLocalized().GetParams()[1].GetText() != "Aldra, Brune" {
			t.Fatalf("names %v", m.GetLocalized().GetParams())
		}
	}
	// The quest log shows it done, with its title.
	if e := logEntry(t, evs, "pair"); e == nil || e.GetState() != pb.QuestLogState_QUEST_LOG_STATE_DONE ||
		e.GetMilestone().GetTitle() != "quest.pair.title" {
		t.Fatalf("log %v", e)
	}
}

// Before it is started the quest log lists a milestone with its requirements, and marks
// what the character meets.
func TestMilestoneInTheQuestLog(t *testing.T) {
	h := sigilHarness(t)
	nextChar++
	c := withPack(nextChar, pos(10, 4))
	c.Name, c.Vocation, c.Level, c.Experience = "Low", "ranger", 25, experienceFor(25)
	cl := &fakeClient{}
	h.sim.Command(h.joinCmd(c, cl))
	h.sim.Step()
	evs := cl.take()
	pair, four := logEntry(t, evs, "pair"), logEntry(t, evs, "four")
	if pair == nil || pair.GetState() != pb.QuestLogState_QUEST_LOG_STATE_OPEN || four == nil {
		t.Fatalf("open milestones: %v %v", pair, four)
	}
	m := pair.GetMilestone()
	if m.GetLevel() != 20 || !m.GetLevelMet() || m.GetGearItem() != tunicID || m.GetGearMet() || m.GetPlayers() != 2 ||
		m.GetVocationMet() {
		t.Fatalf("pair requirements %v", m)
	}
	if f := four.GetMilestone(); f.GetLevelMet() || !f.GetGearMet() || !f.GetVocationMet() || len(f.GetVocations()) != 4 {
		t.Fatalf("four requirements %v", f)
	}
}

// A player without the quest on the step (here, never started) keeps both where they are:
// it hears why, the other hears who is not ready.
func TestMilestoneSomeoneNotReady(t *testing.T) {
	h := sigilHarness(t)
	ca, a := hero(h, "Aldra", "guardian", 22, pos(2, 3), true, "pair")
	cb, b := hero(h, "Brune", "arcanist", 21, pos(4, 3), true, "") // no quest
	h.step(ca, N)
	evs := h.step(cb, N)
	ea := ca.take()
	if a.Pos() != pos(2, 2) || b.Pos() != pos(4, 2) {
		t.Fatalf("moved: %v %v", a.Pos(), b.Pos())
	}
	if !hasKey(evs, "milestone.fail_step") || !hasKey(ea, "milestone.not_ready") {
		t.Fatalf("messages %v / %v", systemKeys(evs), systemKeys(ea))
	}
	if questState(h, a, "pair") != quest.InProgress {
		t.Fatal("completed without the other")
	}
}

// Level and gear: a character under the level, or without the item, fails too.
func TestMilestoneLevelAndGear(t *testing.T) {
	for _, c := range []struct {
		name  string
		lvl   int
		tunic bool
		key   string
	}{{"low", 12, true, "milestone.fail_level"}, {"no gear", 25, false, "milestone.fail_gear"}} {
		t.Run(c.name, func(t *testing.T) {
			h := sigilHarness(t)
			ca, _ := hero(h, "Aldra", "guardian", 22, pos(2, 3), true, "pair")
			cb, b := hero(h, "Brune", "arcanist", c.lvl, pos(4, 3), c.tunic, "pair")
			h.step(ca, N)
			if evs := h.step(cb, N); !hasKey(evs, c.key) || b.Pos() != pos(4, 2) {
				t.Fatalf("%v at %v", systemKeys(evs), b.Pos())
			}
		})
	}
}

// A staff member on a plate never counts, and logging out on one is leaving it.
func TestMilestoneStaffAndLogout(t *testing.T) {
	h := sigilHarness(t)
	ca, a := hero(h, "Aldra", "guardian", 22, pos(2, 3), true, "pair")
	nextChar++
	gm := withPack(nextChar, pos(4, 3), session.ItemState{ItemID: tunicID, Count: 1})
	gm.Name, gm.Vocation, gm.Level, gm.Experience, gm.Role = "Gm", "arcanist", 30, experienceFor(30), session.RoleGM
	cg, g := h.joinChar(gm)
	h.sim.Command(gameFunc(func() { h.w.StartQuestForTest(g, "pair") }))
	h.sim.Step()
	h.step(ca, N)
	evs := h.step(cg, N)
	if a.Pos() != pos(2, 2) || g.Pos() != pos(4, 2) || !hasKey(evs, "milestone.staff") {
		t.Fatalf("staff counted: %v %v %v", a.Pos(), g.Pos(), systemKeys(evs))
	}
	// Aldra logs out on her plate; Brune steps on the other one and waits alone.
	h.sim.Command(h.w.Leave(ca))
	h.sim.Step()
	h.sim.Command(h.w.Leave(cg))
	h.sim.Step()
	cb, b := hero(h, "Brune", "arcanist", 21, pos(4, 3), true, "pair")
	evs = h.step(cb, N)
	if b.Pos() != pos(4, 2) || !hasKey(evs, "milestone.waiting") || questState(h, b, "pair") != quest.InProgress {
		t.Fatalf("after the logout: %v %v", b.Pos(), systemKeys(evs))
	}
}

// Four players, one of each vocation: a ranger on the druid's plate keeps everyone in
// place; once each stands on its own plate, all four move and are done.
func TestMilestoneFourVocations(t *testing.T) {
	h := sigilHarness(t)
	vocs := []string{"guardian", "arcanist", "ranger", "druid"}
	cls := make([]*fakeClient, 4)
	ps := make([]*session.Player, 4)
	for i, v := range vocs {
		voc := v
		if i == 3 {
			voc = "ranger" // on the druid's plate
		}
		cls[i], ps[i] = hero(h, "Hero"+v, voc, 31, pos(2+2*i, 7), false, "four")
	}
	for i := range 3 {
		h.step(cls[i], N)
	}
	evs := h.step(cls[3], N)
	if !hasKey(evs, "milestone.fail_vocation") || ps[0].Pos() != pos(2, 6) {
		t.Fatalf("wrong vocation: %v at %v", systemKeys(evs), ps[0].Pos())
	}
	// The ranger leaves; a druid takes the plate.
	h.step(cls[3], S)
	h.sim.Command(h.w.Leave(cls[3]))
	h.sim.Step()
	cd, d := hero(h, "Druida", "druid", 31, pos(8, 7), false, "four")
	h.step(cd, N)
	for i, p := range append(ps[:3], d) {
		if p.Pos().X < 15 || questState(h, p, "four") != quest.Completed {
			t.Fatalf("player %d at %v, %v", i, p.Pos(), questState(h, p, "four"))
		}
	}
}
