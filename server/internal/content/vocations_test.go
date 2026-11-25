package content

import (
	"path/filepath"
	"strings"
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

// A start_kit entry without a count, or with 0, is one unit; a negative count or no item
// is refused, and the error says what is accepted.
func TestParseVocationsStartKit(t *testing.T) {
	const head = "- id: v\n  start: {health: 10, mana: 0, capacity: 1, speed: 100}\n  start_kit:\n"
	vs, err := ParseVocations([]byte(head + "    - {item: a}\n    - {item: b, count: 0}\n    - {item: c, count: 7}\n"))
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []int{1, 1, 7} {
		if got := vs["v"].StartKit[i].Units(); got != want {
			t.Errorf("entry %d: %d units, want %d", i, got, want)
		}
	}
	for _, bad := range []string{"    - {item: a, count: -1}\n", "    - {count: 2}\n"} {
		_, err := ParseVocations([]byte(head + bad))
		if err == nil || !strings.Contains(err.Error(), "not negative") || strings.Contains(err.Error(), ">= 1") {
			t.Errorf("%q: error %v, want one that asks for a count that is not negative", bad, err)
		}
	}
}
