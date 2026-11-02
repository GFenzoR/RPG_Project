package content

import (
	"path/filepath"
	"strings"
	"testing"
)

// data/npcs and data/quests load and every reference between them resolves.
func TestLoadNPCsAndQuestsFromData(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "data")
	npcs, err := LoadNPCs(dir)
	if err != nil {
		t.Fatal(err)
	}
	quests, err := LoadQuests(dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := LoadItems(dir)
	if err != nil {
		t.Fatal(err)
	}
	monsters, err := LoadMonsters(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckRefs(npcs, quests, items, monsters, nil); err != nil {
		t.Fatal(err)
	}
	hm := npcs["harbor_master"]
	if hm == nil || quests["ch1_shipwreck"] == nil {
		t.Fatal("harbor_master or ch1_shipwreck missing")
	}
	opt := hm.Dialog.Nodes["greet"].Options[4] // logbook, guardian branch
	if len(opt.If) != 3 || opt.If[2].VocationIn[0] != "guardian" || len(opt.Action) != 2 || opt.Action[1].GiveItem != "iron_sword" {
		t.Fatalf("logbook option decoded as %+v", opt)
	}
	if !hm.Dialog.Nodes["greet"].Options[len(hm.Dialog.Nodes["greet"].Options)-1].Action[0].Close {
		t.Fatal("bye option should close")
	}
}

func TestParseNPCRejectsBrokenTrees(t *testing.T) {
	for name, src := range map[string]string{
		"missing goto": "id: a\ndialog:\n  start: g\n  nodes:\n    g:\n      text: t\n      options:\n        - { text: x, goto: nope }\n",
		"bad start":    "id: a\ndialog:\n  start: x\n  nodes:\n    g:\n      text: t\n      options:\n        - { text: x, action: close }\n",
		"other shop":   "id: a\ndialog:\n  start: g\n  nodes:\n    g:\n      text: t\n      options:\n        - { text: x, action: { open_shop: s } }\n",
		"bad action":   "id: a\ndialog:\n  start: g\n  nodes:\n    g:\n      text: t\n      options:\n        - { text: x, action: dance }\n",
	} {
		if _, err := ParseNPC([]byte(src)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := ParseQuest([]byte("id: q\nsteps:\n  - { id: a, complete_when: {} }\n")); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Errorf("quest without completion: err = %v", err)
	}
}
