package content

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Every aimed range of the content (weapon.range, a damage or heal spell's range, a
// condition's range) stops at MaxRange, what a monster notices: a monster hit from as far
// as a player aims fights back (session TestMaxRangeIsTheClassicWindow).
func TestAimedRangesStopAtMaxRange(t *testing.T) {
	for rng, ok := range map[int]bool{0: true, 1: true, MaxRange: true, MaxRange + 1: false} {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, "items"), 0o750); err != nil {
			t.Fatal(err)
		}
		src := fmt.Sprintf("- { id: bow, kind: weapon, weapon: { type: distance, attack: 1, range: %d } }\n", rng)
		if err := os.WriteFile(filepath.Join(dir, "items", "weapons.yaml"), []byte(src), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "ids.lock.yaml"), []byte("items: { bow: 100 }\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadItems(dir); (err == nil) != ok {
			t.Errorf("weapon.range %d: accepted %v, want %v (%v)", rng, err == nil, ok, err)
		}
	}

	cs := ConditionDefs{"poison": {Kind: ConditionDamage, Element: "earth", Stacking: StackAdd, IntervalMs: 1000, MaxTicks: 3}}
	if err := cs.check(); err != nil {
		t.Fatal(err)
	}
	for rng, ok := range map[int]bool{1: true, MaxRange: true, MaxRange + 1: false} {
		bolt := Spell{ID: "bolt", Group: SpellGroupAttack, Effect: SpellEffect{Damage: &SpellDamage{Element: "fire", Range: rng}}}
		if err := bolt.check(); (err == nil) != ok {
			t.Errorf("damage range %d: accepted %v, want %v (%v)", rng, err == nil, ok, err)
		}
		mend := Spell{ID: "mend", Group: SpellGroupHealing, Effect: SpellEffect{Heal: &SpellHeal{Range: rng}}}
		if err := mend.check(); (err == nil) != ok {
			t.Errorf("heal range %d: accepted %v, want %v (%v)", rng, err == nil, ok, err)
		}
		a := &ConditionApply{ID: "poison", Ticks: 1, Damage: 1, Range: rng}
		if err := a.Check(cs); (err == nil) != ok {
			t.Errorf("condition range %d: accepted %v, want %v (%v)", rng, err == nil, ok, err)
		}
	}

	// An area spell's radius too: it hits every monster within it, and one hit at
	// radius 7 straight north would not notice the caster (session.InSight).
	for radius, ok := range map[int]bool{1: true, MaxRange: true, MaxRange + 1: false} {
		wave := Spell{ID: "wave", Group: SpellGroupAttack, Effect: SpellEffect{Damage: &SpellDamage{Element: "fire", Radius: radius}}}
		if err := wave.check(); (err == nil) != ok {
			t.Errorf("damage radius %d: accepted %v, want %v (%v)", radius, err == nil, ok, err)
		}
	}
	bad := Spell{ID: "bad", Group: SpellGroupAttack, Effect: SpellEffect{Damage: &SpellDamage{Element: "fire", Range: 3, Radius: -1}}}
	if bad.check() == nil {
		t.Error("a negative radius with a range was accepted")
	}
}

// A monster's attack stops at MaxRange too (review of the monster abilities): its range,
// and a circle around its target as far as that range plus the radius (1 + the radius for
// a melee one). Past it the area would hurt a player who does not even know the monster.
func TestMonsterReachStopsAtMaxRange(t *testing.T) {
	for src, ok := range map[string]bool{
		"{type: distance, min: 1, max: 2, interval_ms: 2000, range: 6}":                                                                  true,
		"{type: distance, min: 1, max: 2, interval_ms: 2000, range: 7}":                                                                  false,
		"{type: spell, min: 1, max: 2, interval_ms: 2000, range: -1}":                                                                    false,
		"{type: distance, min: 1, max: 2, interval_ms: 2000, range: 5, area: {shape: circle, radius: 1, center: target}}":                true,
		"{type: distance, min: 1, max: 2, interval_ms: 2000, range: 5, area: {shape: circle, radius: 2, center: target}}":                false,
		"{type: spell, min: 1, max: 2, interval_ms: 2000, range: 6, area: {shape: circle, radius: 6, center: target}}":                   false,
		"{type: melee, min: 1, max: 2, interval_ms: 2000, area: {shape: circle, radius: 5, center: target}}":                             true,
		"{type: melee, min: 1, max: 2, interval_ms: 2000, area: {shape: circle, radius: 6, center: target}}":                             false,
		"{type: spell, min: 1, max: 2, interval_ms: 2000, area: {shape: circle, radius: 6}}":                                             true,
		"{type: spell, min: 1, max: 2, interval_ms: 2000, below_hp_pct: 50, area: {shape: circle, radius: 3, center: target}, range: 4}": false,
	} {
		if _, err := ParseMonster([]byte(atk(src))); (err == nil) != ok {
			t.Errorf("%s: accepted %v, want %v (%v)", src, err == nil, ok, err)
		}
	}
}
