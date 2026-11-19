package content

import (
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func TestLoadAttributesOfTheRepository(t *testing.T) {
	data := filepath.Join("..", "..", "..", "data")
	as, err := LoadAttributes(data)
	if err != nil {
		t.Fatal(err)
	}
	items, err := LoadItems(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(as) == 0 {
		t.Fatal("empty attribute pool")
	}
	// Every equipable of the catalog rolls one; ammo, containers and materials never.
	for id, def := range items {
		switch {
		case def.Weapon != nil || def.Armor != nil || def.Shield != nil:
			if len(as.For(def)) == 0 {
				t.Errorf("equipable %s has no attribute to roll", id)
			}
		case Rolls(def):
			t.Errorf("%s (%s) rolls an attribute", id, def.Kind)
		}
	}
	for _, id := range []string{"arrow", "bolt", "backpack", "wolf_pelt", "fishing_rod"} {
		if def := items[id]; def != nil && Rolls(def) {
			t.Errorf("%s rolls an attribute", id)
		}
	}
}

// The line of a skill attribute names the skill as the game itself does (skill.<id>.name,
// the skills panel) and nothing else: no wording of another game's skill names (the
// legal rule of CLAUDE.md). Only "+{value}" and a connector word may go around it. The
// magic level's line names the level, as the card's requirement does.
func TestAttributeSkillLinesUseOurSkillNames(t *testing.T) {
	as, err := LoadAttributes(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	connectors := map[string]bool{"a": true, "de": true, "to": true, "skill": true}
	for _, lang := range []string{"es", "en"} {
		texts := i18nTexts(t, lang)
		for _, a := range as {
			if a.Effect != EffectSkill || a.Skill == "magic" {
				continue
			}
			line, name := texts[a.Text], texts["skill."+a.Skill+".name"]
			if line == "" || name == "" {
				t.Fatalf("%s: %s %q, skill name %q", lang, a.Text, line, name)
			}
			rest := strings.ToLower(strings.ReplaceAll(line, "+{value}", ""))
			if !strings.Contains(rest, strings.ToLower(name)) {
				t.Errorf("%s: %s = %q does not name the skill %q", lang, a.Text, line, name)
				continue
			}
			for _, word := range strings.Fields(strings.Replace(rest, strings.ToLower(name), "", 1)) {
				if !connectors[word] {
					t.Errorf("%s: %s = %q: %q is not our skill's name", lang, a.Text, line, word)
				}
			}
		}
	}
}

// i18nTexts reads every key of i18n/<lang>/*.yaml (flat "key: text" files).
func i18nTexts(t *testing.T, lang string) map[string]string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("..", "..", "..", "i18n", lang, "*.yaml"))
	if err != nil || len(files) == 0 {
		t.Fatalf("i18n %s: %v", lang, err)
	}
	out := map[string]string{}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := yaml.Unmarshal(raw, &m); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		for k, v := range m {
			if s, ok := v.(string); ok {
				out[k] = s
			}
		}
	}
	return out
}

func TestAttributeBandAndRoll(t *testing.T) {
	a := &Attribute{ID: "x", Effect: EffectMaxHealth, Text: "attribute.x", On: []string{"body"}, Weight: 1,
		Bands: []AttributeBand{{1, 1, 2}, {10, 5, 6}, {30, 9, 9}}}
	for _, c := range []struct{ level, min int }{{0, 1}, {1, 1}, {9, 1}, {10, 5}, {29, 5}, {30, 9}, {200, 9}} {
		if b := a.Band(c.level); b.Min != c.min {
			t.Errorf("Band(%d) = %+v, want min %d", c.level, b, c.min)
		}
	}
	b := &Attribute{ID: "y", Effect: EffectArmor, Text: "attribute.y", On: []string{"body", "head"}, Weight: 3,
		Bands: []AttributeBand{{1, 1, 3}}}
	pool := Attributes{a, b}
	body := &Item{ID: "coat", Kind: "armor"}
	body.Armor = &struct {
		Slot  string `yaml:"slot"`
		Armor int    `yaml:"armor"`
	}{Slot: "body", Armor: 2}
	body.Requires.Level = 12
	head := &Item{ID: "cap", Kind: "armor"}
	head.Armor = &struct {
		Slot  string `yaml:"slot"`
		Armor int    `yaml:"armor"`
	}{Slot: "head", Armor: 1}
	r := rand.New(rand.NewPCG(1, 2))
	count := map[string]int{}
	for range 4000 {
		got, v, ok := pool.Roll(r, body)
		if !ok {
			t.Fatal("no roll")
		}
		count[got.ID]++
		lo, hi := got.Band(12).Min, got.Band(12).Max
		if v < lo || v > hi {
			t.Fatalf("%s = %d outside [%d, %d]", got.ID, v, lo, hi)
		}
	}
	// Weights 1:3.
	if count["x"] < 800 || count["x"] > 1200 {
		t.Errorf("rolls %v, want about 1000 x", count)
	}
	for range 100 {
		if got, _, _ := pool.Roll(r, head); got.ID != "y" {
			t.Fatalf("a head rolled %s", got.ID)
		}
	}
	if _, _, ok := pool.Roll(r, &Item{ID: "pelt", Kind: "material"}); ok {
		t.Error("a material rolled")
	}
	mean := pool.Mean(body)
	if mean["x"] != 0.25*5.5 || mean["y"] != 0.75*2 {
		t.Errorf("Mean = %v", mean)
	}
}

func TestLoadAttributesRejects(t *testing.T) {
	ok := "- id: a\n  effect: max_health\n  text: attribute.a\n  on: [body]\n  weight: 1\n  bands:\n    - { level: 1, min: 1, max: 2 }\n"
	for name, c := range map[string]string{
		"effect":       strings.Replace(ok, "max_health", "gold", 1),
		"skill":        strings.Replace(ok, "effect: max_health", "effect: skill", 1),
		"stray skill":  strings.Replace(ok, "weight: 1", "weight: 1\n  skill: sword", 1),
		"element":      strings.Replace(ok, "effect: max_health", "effect: protection\n  element: air", 1),
		"kind":         strings.Replace(ok, "[body]", "[cape]", 1),
		"weight":       strings.Replace(ok, "weight: 1", "weight: 0", 1),
		"first band":   strings.Replace(ok, "level: 1,", "level: 2,", 1),
		"band order":   ok + "    - { level: 1, min: 1, max: 2 }\n",
		"band range":   strings.Replace(ok, "min: 1, max: 2", "min: 3, max: 2", 1),
		"duplicate id": ok + strings.TrimPrefix(ok, ""),
	} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "attributes.yaml"), []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadAttributes(dir); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	dir := t.TempDir()
	if as, err := LoadAttributes(dir); err != nil || as != nil {
		t.Errorf("no file: %v, %v", as, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "attributes.yaml"), []byte(ok), 0o600); err != nil {
		t.Fatal(err)
	}
	if as, err := LoadAttributes(dir); err != nil || len(as) != 1 {
		t.Errorf("valid file: %v, %v", as, err)
	}
}
