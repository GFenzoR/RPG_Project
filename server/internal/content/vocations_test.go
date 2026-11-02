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
