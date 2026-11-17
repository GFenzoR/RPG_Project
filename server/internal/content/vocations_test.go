package content

import (
	"path/filepath"
	"testing"
)

func TestLoadVocationsRepoData(t *testing.T) {
	vs, err := LoadVocations(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatalf("LoadVocations: %v", err)
	}
	g, ok := vs["guardian"]
	if !ok {
		t.Fatalf("guardian missing; got %v", vs)
	}
	if g.Start.Health <= 0 {
		t.Errorf("guardian start health = %d, want > 0", g.Start.Health)
	}
}

func TestParseVocationsErrors(t *testing.T) {
	cases := map[string]string{
		"empty":      "[]",
		"missing id": "- start: {health: 1, mana: 0}",
		"duplicate":  "- {id: a, start: {health: 1, mana: 0}}\n- {id: a, start: {health: 1, mana: 0}}",
		"bad health": "- {id: a, start: {health: 0, mana: 0}}",
		"not yaml":   "- {id: [",
	}
	for name, src := range cases {
		if _, err := ParseVocations([]byte(src)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

// One regeneration tick with the food bonus (content audit m2): an integer formula,
// rounded down, the same in the server and in the balance simulation.
func TestRegenTick(t *testing.T) {
	r := Regen{Health: 3, Mana: 1, IntervalMs: 7000}
	for _, c := range []struct{ pct, hp, mp int }{
		{0, 3, 1},
		{100, 6, 2},
		{50, 4, 1}, // 4.5 and 1.5, rounded down
		{33, 3, 1},
	} {
		if hp, mp := r.Tick(c.pct); hp != c.hp || mp != c.mp {
			t.Errorf("Tick(%d) = %d, %d; want %d, %d", c.pct, hp, mp, c.hp, c.mp)
		}
	}
}
