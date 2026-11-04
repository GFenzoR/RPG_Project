package content

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"go.yaml.in/yaml/v3"
)

// Recipe is an entry of data/recipes.yaml (T3.4): at a station item (anvil, forge,
// stove...) a player whose Craft skill is at least Level turns Inputs into Output
// (docs/02-game-design.md, "Oficios").
type Recipe struct {
	ID string `yaml:"id"`
	// Craft is the skill that sets the chance and gains XP tries with every attempt.
	Craft string `yaml:"craft"`
	// Station is the id of the map item to craft at.
	Station string `yaml:"station"`
	// Tool is the tool.use of an item the player must carry (empty = none).
	Tool  string `yaml:"tool"`
	Level int    `yaml:"level"`
	// TimeMs is how long an attempt takes: no other crafting or gathering attempt of
	// the player until then (never less than gathering.use_interval_ms).
	TimeMs int           `yaml:"time_ms"`
	Inputs []RecipeStack `yaml:"inputs"`
	Output RecipeStack   `yaml:"output"`
	// Success chance: min(MaxSuccess, BaseSuccess + SuccessPerLevel × (level − Level)).
	BaseSuccess     float64 `yaml:"base_success"`
	SuccessPerLevel float64 `yaml:"success_per_level"`
	MaxSuccess      float64 `yaml:"max_success"`
	// XP is the skill tries every attempt earns, success or not.
	XP int `yaml:"xp"`
}

// RecipeStack is Count units of Item.
type RecipeStack struct {
	Item  string `yaml:"item"`
	Count int    `yaml:"count"`
}

// SuccessChance is the chance of an attempt at skill level, in 0..1 (0 below Level).
func (r *Recipe) SuccessChance(level int) float64 {
	if level < r.Level {
		return 0
	}
	hi := r.MaxSuccess
	if hi == 0 {
		hi = 1
	}
	c := r.BaseSuccess + r.SuccessPerLevel*float64(level-r.Level)
	return max(0, min(c, hi))
}

// Recipes maps recipe id to its definition.
type Recipes map[string]*Recipe

// IDs returns the recipe ids, sorted.
func (rs Recipes) IDs() []string {
	ids := make([]string, 0, len(rs))
	for id := range rs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Check verifies every recipe against the items: known station, inputs and output,
// stackable inputs only once each, and the chance numbers.
func (rs Recipes) Check(items Items) error {
	for _, id := range rs.IDs() {
		if err := rs[id].check(items); err != nil {
			return fmt.Errorf("recipes: %s: %w", id, err)
		}
	}
	return nil
}

func (r *Recipe) check(items Items) error {
	if r.Craft == "" || r.Level < 0 || r.TimeMs < 0 || r.XP < 0 {
		return errors.New("craft required, level, time_ms and xp >= 0")
	}
	st := items[r.Station]
	if st == nil || st.CanPickUp() {
		return fmt.Errorf("station %q must be a known item that cannot be picked up", r.Station)
	}
	if r.MaxSuccess < 0 || r.MaxSuccess > 1 || r.BaseSuccess < 0 || r.BaseSuccess > 1 || r.SuccessPerLevel < 0 {
		return errors.New("base_success and max_success in 0..1, success_per_level >= 0")
	}
	if len(r.Inputs) == 0 {
		return errors.New("no inputs")
	}
	seen := map[string]bool{}
	for _, in := range r.Inputs {
		if items[in.Item] == nil || in.Count <= 0 || seen[in.Item] {
			return fmt.Errorf("input %q needs a known item, count > 0 and to appear once", in.Item)
		}
		seen[in.Item] = true
	}
	if items[r.Output.Item] == nil || r.Output.Count <= 0 {
		return fmt.Errorf("output %q needs a known item and count > 0", r.Output.Item)
	}
	return nil
}

// LoadRecipes reads <dataDir>/recipes.yaml (no file means no recipes).
func LoadRecipes(dataDir string) (Recipes, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, "recipes.yaml"))
	if errors.Is(err, fs.ErrNotExist) {
		return Recipes{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read recipes: %w", err)
	}
	var list []*Recipe
	if err := yaml.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decode recipes: %w", err)
	}
	out := Recipes{}
	for _, r := range list {
		if r.ID == "" || out[r.ID] != nil {
			return nil, fmt.Errorf("recipes: missing or duplicate id %q", r.ID)
		}
		out[r.ID] = r
	}
	return out, nil
}
