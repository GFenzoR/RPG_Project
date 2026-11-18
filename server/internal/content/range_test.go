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
