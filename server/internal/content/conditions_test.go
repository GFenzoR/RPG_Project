package content

import (
	"path/filepath"
	"testing"
)

// data/balance.yaml has the six conditions of T3.2 (and keen_eye), and every condition a
// spell or a monster applies is one of them.
func TestConditionsFromData(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "data")
	b, err := LoadBalance(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"poison", "burning", "shocked", "slowed", "hasted", "invisible", "keen_eye"} {
		if b.Conditions[id] == nil || b.Conditions[id].ID != id {
			t.Errorf("condition %s missing", id)
		}
	}
	spells, err := LoadSpells(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := spells.CheckConditions(b.Conditions); err != nil {
		t.Fatal(err)
	}
	monsters, err := LoadMonsters(dir)
	if err != nil {
		t.Fatal(err)
	}
	poisoners := 0
	for _, m := range monsters {
		for _, a := range m.Attacks {
			if err := a.Condition.Check(b.Conditions); err != nil {
				t.Errorf("%s: %v", m.ID, err)
			}
			if a.Condition != nil && a.Condition.ID == "poison" {
				poisoners++
			}
		}
	}
	if poisoners < 2 {
		t.Errorf("%d poisoning attacks, want some monsters that poison", poisoners)
	}
}

func TestConditionDefsCheck(t *testing.T) {
	bad := []ConditionDefs{
		{"a": {Kind: ConditionDamage, Stacking: StackAdd, IntervalMs: 1000, MaxTicks: 3}},                       // no element
		{"a": {Kind: ConditionSpeed, Stacking: StackRefresh, MaxMs: 1000}},                                      // no speed_pct
		{"a": {Kind: ConditionSpeed, Stacking: "stack", MaxMs: 1000, SpeedPct: 10}},                             // stacking
		{"a": {Kind: ConditionInvisible, Stacking: StackRefresh}},                                               // no max_ms
		{"a": {Kind: ConditionSkill, Stacking: StackRefresh, MaxMs: 1000, Skill: "distance"}},                   // no amount
		{"a": {Kind: ConditionSpeed, Stacking: StackRefresh, MaxMs: 1000, SpeedPct: 5, Cancels: []string{"b"}}}, // unknown
		{"a": {Kind: "sleep", Stacking: StackRefresh, MaxMs: 1000}},
	}
	for i, cs := range bad {
		if err := cs.check(); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	cs := ConditionDefs{"poison": {Kind: ConditionDamage, Element: "earth", Stacking: StackAdd, IntervalMs: 1000, MaxTicks: 3}}
	if err := cs.check(); err != nil {
		t.Fatal(err)
	}
	for _, a := range []*ConditionApply{{ID: "nope"}, {ID: "poison", Ticks: 2}, {ID: "poison", Damage: 2}, {ID: "poison", Ticks: 1, Damage: 1, Chance: 2}} {
		if err := a.Check(cs); err == nil {
			t.Errorf("%+v accepted", a)
		}
	}
}
