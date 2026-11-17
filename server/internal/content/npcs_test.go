package content

import (
	"encoding/json"
	"fmt"
	"os"
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

// A shop that buys an item for more than another sells it is a money printer.
func TestCheckRefsRejectsProfitableLoops(t *testing.T) {
	a, err := ParseNPC([]byte("id: a\nshop: { id: sa, sells: [{ item: rope, price: 10 }] }\n"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := ParseNPC([]byte("id: b\nshop: { id: sb, buys: [{ item: rope, price: 11 }] }\n"))
	if err != nil {
		t.Fatal(err)
	}
	items := Items{"rope": &Item{ID: "rope"}}
	if err := CheckRefs(NPCs{"a": a, "b": b}, Quests{}, items, nil, nil); err == nil || !strings.Contains(err.Error(), "buys \"rope\"") {
		t.Fatalf("err = %v", err)
	}
	if _, err := ParseNPC([]byte("id: c\nshop: { id: sc, sells: [{ item: rope, price: 2000000000 }] }\n")); err == nil {
		t.Fatal("a price over MaxPrice was accepted")
	}
}

// train_skill and restore_mana are dev-only: an NPC with one may only stand on a dev-only
// island (the server checks every placement with CheckDevPlacement), and a train_skill
// needs a known skill and a level in 1..MaxSkillLevel.
func TestDevOnlyActions(t *testing.T) {
	npcs, err := LoadNPCs(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range npcs.IDs() {
		got := npcs[id].DevOnlyAction()
		if want := id == "pruebas_trainer"; (got != "") != want {
			t.Errorf("npc %s: dev-only action %q", id, got)
		}
	}
	trainer := npcs["pruebas_trainer"]
	if err := CheckDevPlacement(trainer, "pruebas", true); err != nil {
		t.Fatal(err)
	}
	if err := CheckDevPlacement(trainer, "puerto", false); err == nil || !strings.Contains(err.Error(), "dev-only") {
		t.Fatalf("the instructor in Puerto: err = %v", err)
	}
	if err := CheckDevPlacement(npcs["puerto_priest"], "puerto", false); err != nil {
		t.Fatalf("the priest's heal is not dev-only: %v", err)
	}
	mana, err := ParseNPC([]byte("id: a\ndialog:\n  start: g\n  nodes:\n    g:\n      text: t\n      options:\n        - { text: x, action: { restore_mana: true } }\n"))
	if err != nil {
		t.Fatal(err)
	}
	if mana.DevOnlyAction() != "restore_mana" || CheckDevPlacement(mana, "puerto", false) == nil {
		t.Fatalf("restore_mana: %q", mana.DevOnlyAction())
	}
	train := func(skill string, level int) string {
		return fmt.Sprintf("id: a\ndialog:\n  start: g\n  nodes:\n    g:\n      text: t\n      options:\n        - { text: x, action: { train_skill: { skill: %s, level: %d } } }\n", skill, level)
	}
	for _, bad := range []string{train("sword", 0), train("sword", MaxSkillLevel+1), train(`""`, 10)} {
		if _, err := ParseNPC([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	unknown, err := ParseNPC([]byte(train("juggling", 10)))
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckRefs(NPCs{"a": unknown}, Quests{}, Items{}, nil, []string{"sword"}); err == nil || !strings.Contains(err.Error(), "juggling") {
		t.Fatalf("unknown skill: err = %v", err)
	}
}

// The schema of make validate bounds a train_skill level as ParseNPC does.
func TestTrainSkillLevelBoundMatchesTheSchema(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "content-schema", "schemas", "common.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Defs struct {
			Action struct {
				AnyOf []struct {
					Properties map[string]struct {
						Properties map[string]struct {
							Minimum *int `json:"minimum"`
							Maximum *int `json:"maximum"`
						} `json:"properties"`
					} `json:"properties"`
				} `json:"anyOf"`
			} `json:"action"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	for _, alt := range schema.Defs.Action.AnyOf {
		if ts, ok := alt.Properties["train_skill"]; ok {
			lvl := ts.Properties["level"]
			if lvl.Minimum == nil || *lvl.Minimum != 1 || lvl.Maximum == nil || *lvl.Maximum != MaxSkillLevel {
				t.Fatalf("schema train_skill.level %v..%v, want 1..%d", lvl.Minimum, lvl.Maximum, MaxSkillLevel)
			}
			return
		}
	}
	t.Fatal("no train_skill in the schema's action")
}
