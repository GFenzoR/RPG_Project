package content

import (
	"path/filepath"
	"testing"
)

// data/spells.yaml loads, every rune names a spell and every conjured item exists.
func TestLoadSpellsFromData(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "data")
	spells, err := LoadSpells(dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := LoadItems(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(spells) < 4 {
		t.Fatalf("%d spells, want at least 4", len(spells))
	}
	groups := map[string]bool{}
	for _, s := range spells {
		groups[s.Group] = true
		if c := s.Effect.Conjure; c != nil && (items[c.Item] == nil || items[c.Item].Rune == nil) {
			t.Errorf("%s conjures %q, not a rune", s.ID, c.Item)
		}
		if spells.ByWords()[NormalizeWords(s.Words)] != s {
			t.Errorf("%s: words %q do not index it", s.ID, s.Words)
		}
	}
	if !groups[SpellGroupAttack] || !groups[SpellGroupHealing] || !groups[SpellGroupSupport] {
		t.Errorf("groups %v", groups)
	}
	for _, it := range items {
		if it.Rune != nil && spells[it.Rune.Spell] == nil {
			t.Errorf("rune %s casts unknown spell %q", it.ID, it.Rune.Spell)
		}
	}
}

func TestSpellCheck(t *testing.T) {
	bad := []Spell{
		{ID: "a", Group: "nope", Effect: SpellEffect{Heal: &Scaling{}}},
		{ID: "b", Group: SpellGroupAttack},
		{ID: "c", Group: SpellGroupAttack, Effect: SpellEffect{Damage: &SpellDamage{}}},
		{ID: "d", Group: SpellGroupSupport, Effect: SpellEffect{Haste: map[string]any{}}},
	}
	for _, s := range bad {
		if err := s.check(); err == nil {
			t.Errorf("spell %s accepted", s.ID)
		}
	}
}
