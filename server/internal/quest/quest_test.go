package quest

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

type host struct {
	items   map[string]int
	rewards []content.QuestReward
	events  []EventKind
}

func (h *host) ItemCount(item string) int                      { return h.items[item] }
func (h *host) Reward(_ *content.Quest, r content.QuestReward) { h.rewards = append(h.rewards, r) }
func (h *host) Notify(e Event)                                 { h.events = append(h.events, e.Kind) }

func testQuests(t *testing.T) content.Quests {
	t.Helper()
	q, err := content.ParseQuest([]byte(`
id: q
name: n
steps:
  - { id: wolves, description: d, complete_when: { kill: { monster: wolf, count: 2 } } }
  - { id: pelt, description: d, complete_when: { has_item: { item: pelt, count: 2 } } }
  - { id: talk, description: d, complete_when: { dialog_action: { npc: a, node: done } } }
  - { id: flag, description: d, complete_when: { flag_equals: { key: f, value: 3 } } }
rewards:
  - { xp: 10 }
  - { set_flag: { key: route, value: 1 } }
`))
	if err != nil {
		t.Fatal(err)
	}
	return content.Quests{"q": q}
}

func TestQuestRunsStepsInOrder(t *testing.T) {
	e := NewEngine(testQuests(t))
	l := NewLog(nil)
	h := &host{items: map[string]int{}}
	if s, _ := e.State(l, "q"); s != NotStarted {
		t.Fatalf("state %v", s)
	}
	// Events before the quest or the step is current do not count.
	e.Killed(l, "wolf", h)
	e.ReachedNode(l, "a", "done", h)
	if !e.Start(l, "q", h) || e.Start(l, "q", h) {
		t.Fatal("Start should work once")
	}
	e.Killed(l, "rat", h)
	e.Killed(l, "wolf", h)
	if _, step := e.State(l, "q"); step != "wolves" {
		t.Fatalf("step %q after 1 wolf", step)
	}
	h.items["pelt"] = 2 // already carried when the step becomes current: completes on enter
	e.Killed(l, "wolf", h)
	if _, step := e.State(l, "q"); step != "talk" {
		t.Fatalf("step %q, want talk (pelts already held)", step)
	}
	h.items["pelt"] = 0 // a completed step never goes back
	e.Recheck(l, h)
	e.ReachedNode(l, "a", "other", h)
	e.ReachedNode(l, "a", "done", h)
	if _, step := e.State(l, "q"); step != "flag" {
		t.Fatalf("step %q, want flag", step)
	}
	e.SetFlag(l, "f", 2, h)
	if s, _ := e.State(l, "q"); s != InProgress {
		t.Fatal("wrong flag value completed the step")
	}
	e.SetFlag(l, "f", 3, h)
	if s, _ := e.State(l, "q"); s != Completed {
		t.Fatalf("state %v, want completed", s)
	}
	if len(h.rewards) != 1 || h.rewards[0].XP != 10 || l.Get(FlagKey("route")) != 1 {
		t.Fatalf("rewards %+v, route flag %d", h.rewards, l.Get(FlagKey("route")))
	}
	if h.events[len(h.events)-1] != Done {
		t.Fatalf("events %v", h.events)
	}
	vals := l.Values()
	if vals["quest.q"] != int64(Completed) || len(vals) != 3 { // quest.q, flag.f, flag.route
		t.Fatalf("values %v", vals)
	}
	// Persisted and loaded back.
	l2 := NewLog(vals)
	if s, _ := e.State(l2, "q"); s != Completed {
		t.Fatal("state lost in the round trip")
	}
}

func TestSetStepAndKillCountReset(t *testing.T) {
	e := NewEngine(testQuests(t))
	l := NewLog(nil)
	h := &host{items: map[string]int{}}
	if e.SetStep(l, "q", "talk", h) {
		t.Fatal("SetStep on a quest not started")
	}
	e.Start(l, "q", h)
	e.Killed(l, "wolf", h)
	e.SetStep(l, "q", "wolves", h) // re-entering resets the kill count
	e.Killed(l, "wolf", h)
	if _, step := e.State(l, "q"); step != "wolves" {
		t.Fatalf("step %q: kills before re-entering counted", step)
	}
}
