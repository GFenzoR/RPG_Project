package content

import (
	"strings"
	"testing"
)

// repeatableNPCs are the NPCs of the repeatable-quest checks: giver starts quest task
// (accept → accepted) and takes tails at deliver (one option takes 3, another 1, at
// deliver_one); other only talks.
func repeatableNPCs(t *testing.T) NPCs {
	t.Helper()
	giver, err := ParseNPC([]byte(`
id: giver
dialog:
  start: greet
  nodes:
    greet:
      text: t
      options:
        - { text: accept, action: { start_quest: task }, goto: accepted }
        - { text: hand, action: { take_item: { item: tail, count: 3 } }, goto: deliver }
        - { text: hand_one, action: { take_item: { item: tail } }, goto: deliver_one }
        - { text: bye, action: close }
    accepted: { text: t, options: [{ text: bye, action: close }] }
    deliver: { text: t, options: [{ text: bye, action: close }] }
    deliver_one: { text: t, options: [{ text: bye, action: close }] }
`))
	if err != nil {
		t.Fatal(err)
	}
	other, err := ParseNPC([]byte(`
id: other
dialog:
  start: greet
  nodes:
    greet: { text: t, options: [{ text: hi, goto: hello }, { text: bye, action: close }] }
    hello: { text: t, options: [{ text: bye, action: close }] }
`))
	if err != nil {
		t.Fatal(err)
	}
	return NPCs{"giver": giver, "other": other}
}

// A repeatable quest cannot have a step that lets a turn be done, and paid, with no effort
// (docs/06 "Quests repetibles"): a has_item whose items stay (no delivery that takes them
// all), a flag_equals its own rewards set, or, among the steps that may hold right when it
// starts, a dialog_action with an NPC that gives it or a reach next to one. A quest that is
// not repeatable may (it pays once).
func TestCheckRepeatable(t *testing.T) {
	npcs := repeatableNPCs(t)
	const (
		kill      = "{ id: hunt, complete_when: { kill: { monster: wolf, count: 3 } } }"
		report    = "{ id: report, complete_when: { dialog_action: { npc: giver, node: accepted } } }"
		tails     = "{ id: tails, complete_when: { has_item: { item: tail, count: 3 } } }"
		deliver   = "{ id: give, complete_when: { dialog_action: { npc: giver, node: deliver } } }"
		deliver1  = "{ id: give, complete_when: { dialog_action: { npc: giver, node: deliver_one } } }"
		flag      = "{ id: flag, complete_when: { flag_equals: { key: seal, value: 1 } } }"
		reach     = "{ id: walk, complete_when: { reach: { x: 10, y: 10, z: 7 } } }"
		talkOther = "{ id: talk, complete_when: { dialog_action: { npc: other, node: hello } } }"
		ownSeal   = "rewards: [{ set_flag: { key: seal, value: 1 } }]\n"
		otherSeal = "rewards: [{ set_flag: { key: seal, value: 2 } }]\n"
	)
	// nearGiver takes every reach place as next to the giver; nearOther as next to other.
	nearGiver := func(_ *Reach, npc string) bool { return npc == "giver" }
	nearOther := func(_ *Reach, npc string) bool { return npc == "other" }
	for _, c := range []struct {
		name    string
		steps   []string
		rewards string
		near    func(*Reach, string) bool
		refused string // "" = accepted
	}{
		{"hunt and report", []string{kill, report}, "", nil, ""},
		{"tails handed in", []string{tails, deliver}, "", nil, ""},
		{"tails kept", []string{tails}, "", nil, "has_item must be followed by its delivery"},
		{"tails then a hunt", []string{tails, kill, deliver}, "", nil, "has_item must be followed by its delivery"},
		{"one tail taken of three", []string{tails, deliver1}, "", nil, "has_item must be followed by its delivery"},
		{"its own flag", []string{kill, flag}, ownSeal, nil, "own rewards set"},
		{"a flag it sets to another value", []string{kill, flag}, otherSeal, nil, ""},
		{"talk to the giver at once", []string{report, kill}, "", nil, "cannot start with a dialog_action of npc \"giver\""},
		{"a flag, then the giver", []string{flag, report}, "", nil, "cannot start with a dialog_action of npc \"giver\""},
		{"talk to someone else first", []string{talkOther, report}, "", nil, ""},
		{"a reach by the giver first", []string{reach, kill}, "", nearGiver, "within talk range of npc \"giver\""},
		{"a flag, then a reach by the giver", []string{flag, reach}, "", nearGiver, "within talk range of npc \"giver\""},
		{"a reach by someone else", []string{reach, kill}, "", nearOther, ""},
		{"a reach without the map", []string{reach, kill}, "", nil, ""},
		{"a hunt, then back to the giver", []string{kill, reach}, "", nearGiver, ""},
	} {
		for _, repeatable := range []bool{true, false} {
			src := "id: task\nname: n\n"
			if repeatable {
				src += "repeatable: { cooldown_hours: 1 }\n"
			}
			src += "steps:\n"
			for _, s := range c.steps {
				src += "  - " + s + "\n"
			}
			src += c.rewards
			q, err := ParseQuest([]byte(src))
			if err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			err = CheckRepeatable(Quests{"task": q}, npcs, c.near)
			switch {
			case !repeatable || c.refused == "":
				if err != nil {
					t.Errorf("%s (repeatable %v): refused: %v", c.name, repeatable, err)
				}
			case err == nil || !strings.Contains(err.Error(), c.refused):
				t.Errorf("%s: err = %v, want %q", c.name, err, c.refused)
			}
		}
	}
	// CheckRefs runs it (without the map).
	q, err := ParseQuest([]byte("id: task\nname: n\nrepeatable: { cooldown_hours: 1 }\nsteps:\n  - " + tails + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	items := Items{"tail": &Item{ID: "tail"}}
	if err := CheckRefs(npcs, Quests{"task": q}, items, nil, nil); err == nil || !strings.Contains(err.Error(), "its delivery") {
		t.Fatalf("CheckRefs: err = %v", err)
	}
	if got := Givers(npcs, "task"); len(got) != 1 || got[0] != "giver" {
		t.Fatalf("givers %v", got)
	}
}

// quest_not_started, or quest_state not_started, of a repeatable quest holds only before
// its first turn: the server warns of it (make validate too).
func TestRefWarnings(t *testing.T) {
	task, err := ParseQuest([]byte("{id: task, name: n, repeatable: {cooldown_hours: 1}, steps: [{id: s, complete_when: {kill: {monster: wolf, count: 1}}}]}"))
	if err != nil {
		t.Fatal(err)
	}
	once, err := ParseQuest([]byte("{id: once, name: n, steps: [{id: s, complete_when: {kill: {monster: wolf, count: 1}}}]}"))
	if err != nil {
		t.Fatal(err)
	}
	quests := Quests{"task": task, "once": once}
	warns := func(cond string) []string {
		n, err := ParseNPC([]byte("{id: a, dialog: {start: g, nodes: {g: {text: t, options: [{text: x, if: " + cond + ", action: close}]}}}}"))
		if err != nil {
			t.Fatal(err)
		}
		return RefWarnings(NPCs{"a": n}, quests)
	}
	for _, cond := range []string{"{quest_not_started: task}", "{quest_state: {quest: task, state: not_started}}"} {
		if w := warns(cond); len(w) != 1 || !strings.Contains(w[0], `repeatable quest "task"`) {
			t.Errorf("%s: warnings %v", cond, w)
		}
	}
	for _, cond := range []string{"{quest_not_started: once}", "{quest_state: {quest: task, state: available}}", "{quest_state: {quest: once, state: not_started}}"} {
		if w := warns(cond); len(w) != 0 {
			t.Errorf("%s: warnings %v", cond, w)
		}
	}
}
