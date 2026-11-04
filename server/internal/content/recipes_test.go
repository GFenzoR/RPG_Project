package content

import (
	"path/filepath"
	"testing"
)

// data/recipes.yaml checks against data/items, and each trade of T3.4 has recipes.
func TestRecipesFromData(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "data")
	items, err := LoadItems(dir)
	if err != nil {
		t.Fatal(err)
	}
	rs, err := LoadRecipes(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := rs.Check(items); err != nil {
		t.Fatal(err)
	}
	b, err := LoadBalance(dir)
	if err != nil {
		t.Fatal(err)
	}
	per := map[string]int{}
	for _, r := range rs {
		if _, ok := b.Skills.Base[r.Craft]; !ok {
			t.Errorf("%s: craft %q not in balance.yaml", r.ID, r.Craft)
		}
		if c := r.SuccessChance(r.Level); c <= 0 || c > 1 {
			t.Errorf("%s: chance at its level = %v", r.ID, c)
		}
		per[r.Craft]++
	}
	if per["smithing"] < 2 || per["cooking"] < 2 {
		t.Errorf("recipes per craft = %v", per)
	}
}

func TestRecipeSuccessChance(t *testing.T) {
	r := Recipe{Level: 3, BaseSuccess: 0.5, SuccessPerLevel: 0.1, MaxSuccess: 0.8}
	for _, c := range []struct {
		level int
		want  float64
	}{{2, 0}, {3, 0.5}, {5, 0.7}, {10, 0.8}} {
		if got := r.SuccessChance(c.level); got < c.want-1e-9 || got > c.want+1e-9 {
			t.Errorf("level %d: %v, want %v", c.level, got, c.want)
		}
	}
}
