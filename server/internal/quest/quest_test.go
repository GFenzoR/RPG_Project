package quest

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

type host struct {
	items   map[string]int
	rewards []content.QuestReward
	events  []EventKind
	now     int64
	inside  map[*content.Reach]bool
}

func (h *host) ItemCount(item string) int                      { return h.items[item] }
func (h *host) Reward(_ *content.Quest, r content.QuestReward) { h.rewards = append(h.rewards, r) }
func (h *host) Notify(e Event)                                 { h.events = append(h.events, e.Kind) }
func (h *host) Now() int64                                     { return h.now }
func (h *host) Inside(r *content.Reach) bool                   { return h.inside[r] }

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

// Needs (content audit m9): a quest drop goes to whoever's quest in progress waits for the
// item at the current step or at the one just done, while its delivery is current (a lost
// one comes back), and never before its step, after its delivery (the quest goes on, as
// ch2_coffer after the tallies), after the quest is completed or to whoever holds enough.
func TestNeeds(t *testing.T) {
	parse := func(src string) *content.Quest {
		q, err := content.ParseQuest([]byte(src))
		if err != nil {
			t.Fatal(err)
		}
		return q
	}
	e := NewEngine(content.Quests{
		"warden": parse(`
id: warden
name: n
steps:
  - { id: defeat_warden, description: d, complete_when: { kill: { monster: warden, count: 1 } } }
  - { id: take_seal, description: d, complete_when: { has_item: { item: seal } } }
  - { id: return_seal, description: d, complete_when: { dialog_action: { npc: keeper, node: read } } }
`),
		"tusks": parse(`
id: tusks
name: n
steps:
  - { id: take_tusks, description: d, complete_when: { has_item: { item: tusk, count: 3 } } }
  - { id: hand_in, description: d, complete_when: { dialog_action: { npc: hunter, node: done } } }
`),
		"coffer": parse(`
id: coffer
name: n
steps:
  - { id: gather_tallies, description: d, complete_when: { has_item: { item: tally, count: 4 } } }
  - { id: deliver_tallies, description: d, complete_when: { dialog_action: { npc: druid, node: tallies } } }
  - { id: find_coffer, description: d, complete_when: { has_item: { item: coffer } } }
  - { id: return_coffer, description: d, complete_when: { dialog_action: { npc: druid, node: opened } } }
`),
	})
	at := func(quest string, state State, step int) *Log {
		return NewLog(map[string]int64{stateKey(quest): int64(state), stepKey(quest): int64(step)})
	}
	for _, c := range []struct {
		name string
		log  *Log
		item string
		have int
		want bool
	}{
		{"not started", NewLog(nil), "seal", 0, false},
		{"defeat_warden: before its step", at("warden", InProgress, 0), "seal", 0, false},
		{"take_seal without one", at("warden", InProgress, 1), "seal", 0, true},
		{"take_seal holding one", at("warden", InProgress, 1), "seal", 1, false},
		{"return_seal, lost it", at("warden", InProgress, 2), "seal", 0, true},
		{"return_seal holding it", at("warden", InProgress, 2), "seal", 1, false},
		{"completed: handed in", at("warden", Completed, 0), "seal", 0, false},
		{"another item", at("warden", InProgress, 1), "tusk", 0, false},
		{"count 3, holding 2", at("tusks", InProgress, 0), "tusk", 2, true},
		{"count 3, holding 3", at("tusks", InProgress, 0), "tusk", 3, false},
		{"count 3, handing in with 1 left", at("tusks", InProgress, 1), "tusk", 1, true},
		{"deliver_tallies, lost two", at("coffer", InProgress, 1), "tally", 2, true},
		{"find_coffer: tallies handed in", at("coffer", InProgress, 2), "tally", 0, false},
		{"return_coffer: tallies handed in", at("coffer", InProgress, 3), "tally", 0, false},
		{"find_coffer without it", at("coffer", InProgress, 2), "coffer", 0, true},
		{"deliver_tallies: before the coffer's step", at("coffer", InProgress, 1), "coffer", 0, false},
	} {
		if got := e.Needs(c.log, c.item, c.have); got != c.want {
			t.Errorf("%s: Needs(%s, %d) = %v, want %v", c.name, c.item, c.have, got, c.want)
		}
	}
}
