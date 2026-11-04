package content

import (
	"os"
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
		if c := s.Effect.Conjure; c != nil && (items[c.Item] == nil || items[c.Item].Rune == nil && !items[c.Item].Stackable) {
			t.Errorf("%s conjures %q, neither a rune nor a stack", s.ID, c.Item)
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
		{ID: "a", Group: "nope", Effect: SpellEffect{Heal: &SpellHeal{}}},
		{ID: "b", Group: SpellGroupAttack},
		{ID: "c", Group: SpellGroupAttack, Effect: SpellEffect{Damage: &SpellDamage{}}},
		{ID: "d", Group: SpellGroupSupport, Effect: SpellEffect{Light: map[string]any{}}},
	}
	for _, s := range bad {
		if err := s.check(); err == nil {
			t.Errorf("spell %s accepted", s.ID)
		}
	}
}

func TestLoadSpellsRejectsDuplicateWords(t *testing.T) {
	dir := t.TempDir()
	src := `
- { id: a, words: "vita lumen", group: healing, effect: { heal: { base: 1 } } }
- { id: b, words: "Vita  Lumen", group: healing, effect: { heal: { base: 1 } } }
`
	if err := os.WriteFile(filepath.Join(dir, "spells.yaml"), []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadSpells(dir); err == nil {
		t.Fatal("duplicate words accepted")
	}
}
