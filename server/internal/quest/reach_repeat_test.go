package quest

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

func parseQuest(t *testing.T, src string) *content.Quest {
	t.Helper()
	q, err := content.ParseQuest([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	return q
}

// reach: the step completes when the character stands in its place, on a move (Moved) or
// right when it becomes current; only the current step counts, and Reaches lists the
// places the session must watch.
func TestReachStep(t *testing.T) {
	q := parseQuest(t, `
id: walk
name: n
steps:
  - { id: rats, description: d, complete_when: { kill: { monster: rat, count: 1 } } }
  - { id: shrine, description: d, complete_when: { reach: { x: 10, y: 10, z: 7, radius: 1 } } }
  - { id: cove, description: d, complete_when: { reach: { zone: cove } } }
rewards:
  - { xp: 5 }
`)
	shrine, cove := q.Steps[1].CompleteWhen.Reach, q.Steps[2].CompleteWhen.Reach
	e := NewEngine(content.Quests{"walk": q})
	l := NewLog(nil)
	h := &host{items: map[string]int{}, inside: map[*content.Reach]bool{}}
	h.inside[shrine] = true // standing at the shrine before its step is current
	e.Moved(l, h)
	if s, _ := e.State(l, "walk"); s != NotStarted {
		t.Fatal("a move started the quest")
	}
	e.Start(l, "walk", h)
	if got := e.Reaches(l, nil); len(got) != 0 {
		t.Fatalf("reach places before the reach step: %v", got)
	}
	e.Moved(l, h) // the kill step is current: standing at the shrine counts for nothing
	if _, step := e.State(l, "walk"); step != "rats" {
		t.Fatalf("step %q", step)
	}
	// The kill makes the shrine current while the character stands there: done on enter.
	e.Killed(l, "rat", h)
	if _, step := e.State(l, "walk"); step != "cove" {
		t.Fatalf("step %q, want cove (already at the shrine)", step)
	}
	if got := e.Reaches(l, nil); len(got) != 1 || got[0] != cove {
		t.Fatalf("reach places %v, want the cove", got)
	}
	e.Moved(l, h) // still not in the cove
	if _, step := e.State(l, "walk"); step != "cove" {
		t.Fatalf("step %q", step)
	}
	h.inside[cove] = true
	e.Moved(l, h)
	if s, _ := e.State(l, "walk"); s != Completed || len(h.rewards) != 1 {
		t.Fatalf("state %v, rewards %v", s, h.rewards)
	}
	if got := e.Reaches(l, nil); len(got) != 0 {
		t.Fatalf("reach places after the quest: %v", got)
	}
}

// A repeatable quest: refused while it cools down, available again after its cooldown from
// the first step with no kills counted, and rewarded every time; done_at goes away while it
// runs again.
func TestRepeatableQuest(t *testing.T) {
	q := parseQuest(t, `
id: bounty
name: n
repeatable: { cooldown_hours: 2 }
steps:
  - { id: hunt, description: d, complete_when: { kill: { monster: wolf, count: 2 } } }
  - { id: report, description: d, complete_when: { dialog_action: { npc: a, node: paid } } }
rewards:
  - { gold: 30 }
  - { set_flag: { key: bounties, value: 1 } }
`)
	once := parseQuest(t, `
id: once
name: n
steps:
  - { id: talk, description: d, complete_when: { dialog_action: { npc: a, node: paid } } }
`)
	e := NewEngine(content.Quests{"bounty": q, "once": once})
	l := NewLog(nil)
	const t0 = 1_800_000_000
	h := &host{items: map[string]int{}, now: t0}
	run := func() {
		t.Helper()
		if !e.Start(l, "bounty", h) {
			t.Fatal("Start refused an available bounty")
		}
		e.Killed(l, "wolf", h)
		e.Killed(l, "wolf", h)
		e.ReachedNode(l, "a", "paid", h)
		if s, _ := e.State(l, "bounty"); s != Completed {
			t.Fatalf("state %v", s)
		}
	}
	if !e.Available(l, "bounty", t0) || e.CoolingDown(l, "bounty", t0) {
		t.Fatal("a bounty never started is not available")
	}
	run()
	if got := l.Get("quest.bounty.done_at"); got != t0 {
		t.Fatalf("done_at %d, want %d", got, t0)
	}
	// One second short of the cooldown: refused, cooling down.
	h.now = t0 + 2*3600 - 1
	if e.Start(l, "bounty", h) || e.Available(l, "bounty", h.now) || !e.CoolingDown(l, "bounty", h.now) {
		t.Fatal("the bounty restarted before its cooldown")
	}
	if en := e.Entries(l); len(en) != 1 || en[0].State != Completed || en[0].AvailableAt != t0+2*3600 {
		t.Fatalf("entries while cooling down: %+v", en)
	}
	// The cooldown passed: it starts again from the first step, kills reset.
	h.now = t0 + 2*3600
	if !e.Available(l, "bounty", h.now) || e.CoolingDown(l, "bounty", h.now) {
		t.Fatal("not available after the cooldown")
	}
	if !e.Start(l, "bounty", h) || e.Start(l, "bounty", h) {
		t.Fatal("Start after the cooldown should work once")
	}
	if s, step := e.State(l, "bounty"); s != InProgress || step != "hunt" || l.Get("quest.bounty.kills") != 0 || l.Get("quest.bounty.done_at") != 0 {
		t.Fatalf("restart: %v at %q, kills %d, done_at %d", s, step, l.Get("quest.bounty.kills"), l.Get("quest.bounty.done_at"))
	}
	e.Killed(l, "wolf", h)
	if en := e.Entries(l); len(en) != 1 || en[0].State != InProgress || en[0].Step.ID != "hunt" || en[0].Kills != 1 || en[0].AvailableAt != 0 {
		t.Fatalf("entries in progress: %+v", en)
	}
	e.Killed(l, "wolf", h)
	e.ReachedNode(l, "a", "paid", h)
	if len(h.rewards) != 2 || h.rewards[0].Gold != 30 || h.rewards[1].Gold != 30 {
		t.Fatalf("rewards %+v: one per completion", h.rewards)
	}
	if l.Get("quest.bounty.done_at") != h.now {
		t.Fatal("done_at not moved to the second completion")
	}
	// A quest that is not repeatable stays done for good.
	e.Start(l, "once", h)
	e.ReachedNode(l, "a", "paid", h)
	h.now += 1_000_000
	if e.Start(l, "once", h) || e.Available(l, "once", h.now) || e.CoolingDown(l, "once", h.now) {
		t.Fatal("a quest that is not repeatable started again")
	}
	if en := e.Entries(l); len(en) != 2 || en[0].Quest.ID != "bounty" || en[1].Quest.ID != "once" || en[1].AvailableAt != 0 {
		t.Fatalf("entries: %+v", en)
	}
	// Completed before it was repeatable (no done_at): available at once.
	l2 := NewLog(map[string]int64{"quest.bounty": int64(Completed)})
	if !e.Available(l2, "bounty", t0) {
		t.Fatal("a bounty done without done_at is not available")
	}
}

// Content checks of the new fields.
func TestParseReachAndRepeatable(t *testing.T) {
	for _, c := range []struct{ name, src string }{
		{"zone and point", `{ zone: cove, x: 1, y: 1, z: 7 }`},
		{"zone and radius", `{ zone: cove, radius: 2 }`},
		{"no z", `{ x: 1, y: 1 }`},
		{"empty", `{}`},
		{"negative radius", `{ x: 1, y: 1, z: 7, radius: -1 }`},
		{"huge radius", `{ x: 1, y: 1, z: 7, radius: 99 }`},
		{"floor 16", `{ x: 1, y: 1, z: 16 }`},
	} {
		src := "id: q\nname: n\nsteps:\n  - { id: s, description: d, complete_when: { reach: " + c.src + " } }\n"
		if _, err := content.ParseQuest([]byte(src)); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
	}
	for _, h := range []string{"0", "-1", "9000", ".nan"} {
		src := "id: q\nname: n\nrepeatable: { cooldown_hours: " + h + " }\nsteps:\n  - { id: s, description: d, complete_when: { reach: { zone: cove } } }\n"
		if _, err := content.ParseQuest([]byte(src)); err == nil {
			t.Errorf("cooldown_hours %s: accepted", h)
		}
	}
	q := parseQuest(t, "id: q\nname: n\nrepeatable: { cooldown_hours: 0.05 }\nsteps:\n  - { id: s, description: d, complete_when: { reach: { x: 0, y: 0, z: 0 } } }\n")
	if q.Repeatable.CooldownSeconds() != 180 {
		t.Fatalf("0.05 h = %d s, want 180", q.Repeatable.CooldownSeconds())
	}
	// Whole seconds, whatever float64 makes of the product (1.1 × 3600 is 3960.0000000000005).
	for h, want := range map[float64]int64{0.07: 252, 1.1: 3960, 0.3: 1080, 20: 72000, 0.0001: 1} {
		if got := (&content.Repeatable{CooldownHours: h}).CooldownSeconds(); got != want {
			t.Errorf("%v h = %d s, want %d", h, got, want)
		}
	}
}
