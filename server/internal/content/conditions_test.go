package content

import (
	"path/filepath"
	"testing"
)

// data/balance.yaml has the six conditions of T3.2 (and keen_eye), and every condition a
// spell or a monster applies is one of them (a boss's phases' attacks_add too).
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
		for _, a := range m.AllAttacks() {
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

// Range aims a condition at someone else, which against a player is an attack (T5.2):
// only a harmful condition (damage or a slow) may have it.
func TestConditionApplyRangeOnlyHarmful(t *testing.T) {
	cs := ConditionDefs{
		"poison":    {Kind: ConditionDamage, Element: "earth", Stacking: StackAdd, IntervalMs: 1000, MaxTicks: 3},
		"slowed":    {Kind: ConditionSpeed, SpeedPct: -40, MaxMs: 1000, Stacking: StackRefresh},
		"hasted":    {Kind: ConditionSpeed, SpeedPct: 30, MaxMs: 1000, Stacking: StackRefresh},
		"keen_eye":  {Kind: ConditionSkill, Skill: "distance", Amount: 2, MaxMs: 1000, Stacking: StackRefresh},
		"invisible": {Kind: ConditionInvisible, MaxMs: 1000, Stacking: StackRefresh},
	}
	if err := cs.check(); err != nil {
		t.Fatal(err)
	}
	for _, a := range []*ConditionApply{
		{ID: "poison", Ticks: 1, Damage: 1, Range: 3},
		{ID: "slowed", DurationMs: 500, Range: 3},
		{ID: "hasted", DurationMs: 500}, // on the caster
	} {
		if err := a.Check(cs); err != nil {
			t.Errorf("%+v: %v", a, err)
		}
	}
	for _, a := range []*ConditionApply{
		{ID: "hasted", DurationMs: 500, Range: 3},
		{ID: "keen_eye", DurationMs: 500, Range: 3},
		{ID: "invisible", DurationMs: 500, Range: 3},
		{ID: "slowed", DurationMs: 500, Range: -1},
	} {
		if err := a.Check(cs); err == nil {
			t.Errorf("%+v accepted", a)
		}
	}
}

// A regen condition (food, content audit m2) needs a positive regen_pct and a max_ms.
func TestRegenConditionCheck(t *testing.T) {
	for i, c := range []*ConditionDef{
		{Kind: ConditionRegen, Stacking: StackAdd, MaxMs: 1000},                // no regen_pct
		{Kind: ConditionRegen, Stacking: StackAdd, MaxMs: 1000, RegenPct: -50}, // negative
		{Kind: ConditionRegen, Stacking: StackAdd, RegenPct: 100},              // no max_ms
	} {
		if err := (ConditionDefs{"well_fed": c}).check(); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	ok := ConditionDefs{"well_fed": {Kind: ConditionRegen, Stacking: StackAdd, MaxMs: 1000, RegenPct: 100}}
	if err := ok.check(); err != nil {
		t.Fatal(err)
	}
}
