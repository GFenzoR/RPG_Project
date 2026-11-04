package content

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"go.yaml.in/yaml/v3"
)

// MaxDockDistance is the farthest (Chebyshev, same floor) a captain may stand from the
// dock of its routes (the same limit packages/map-format checks).
const MaxDockDistance = 8

// BoatRoute is an entry of data/boat_routes.yaml (T3.5): Captain sells a voyage from
// the dock From to the tile To for Price, to players that meet Requires.
type BoatRoute struct {
	ID      string `yaml:"id"`
	Captain string `yaml:"captain"`
	// Text is the i18n key of the dialog option.
	Text     string        `yaml:"text"`
	From     Position      `yaml:"from"`
	To       Position      `yaml:"to"`
	Price    int64         `yaml:"price"`
	Requires RouteRequires `yaml:"requires"`
}

// RouteRequires are a route's requirements (zero values mean none).
type RouteRequires struct {
	Level int `yaml:"level"`
	// Quest must be completed.
	Quest string     `yaml:"quest"`
	Item  *RouteItem `yaml:"item"`
}

// RouteItem is an item the player must carry; Consume takes it (a ticket).
type RouteItem struct {
	Item    string `yaml:"item"`
	Count   int    `yaml:"count"`
	Consume bool   `yaml:"consume"`
}

// N is the count, 1 when omitted.
func (r RouteItem) N() int { return max(r.Count, 1) }

// BoatRoutes are the routes in file order.
type BoatRoutes []*BoatRoute

// LoadBoatRoutes reads <dataDir>/boat_routes.yaml (no file means no routes).
func LoadBoatRoutes(dataDir string) (BoatRoutes, error) {
	return LoadBoatRoutesFile(filepath.Join(dataDir, "boat_routes.yaml"), true)
}

// LoadBoatRoutesFile reads a routes file; a missing file is an error unless optional.
func LoadBoatRoutesFile(path string, optional bool) (BoatRoutes, error) {
	raw, err := os.ReadFile(path)
	if optional && errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read boat routes: %w", err)
	}
	var list BoatRoutes
	if err := yaml.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decode boat routes: %w", err)
	}
	seen := map[string]bool{}
	for _, r := range list {
		if r == nil || r.ID == "" || seen[r.ID] {
			return nil, errors.New("boat routes: missing or duplicate id")
		}
		seen[r.ID] = true
	}
	return list, nil
}

// Check verifies what the routes reference (captain, quest, item) and their numbers.
// The map side (dock, arrival, where the captain stands) is checked by the session.
func (rs BoatRoutes) Check(npcs NPCs, quests Quests, items Items) error {
	for _, r := range rs {
		where := fmt.Sprintf("boat route %q", r.ID)
		if npcs[r.Captain] == nil {
			return fmt.Errorf("%s: unknown captain %q", where, r.Captain)
		}
		if r.Text == "" || r.Price < 0 || r.Price > 1_000_000_000 || r.Requires.Level < 0 {
			return fmt.Errorf("%s: needs text, price in 0..1000000000 and level >= 0", where)
		}
		if q := r.Requires.Quest; q != "" && quests[q] == nil {
			return fmt.Errorf("%s: unknown quest %q", where, q)
		}
		if it := r.Requires.Item; it != nil && (items[it.Item] == nil || it.Count < 0) {
			return fmt.Errorf("%s: unknown item %q or negative count", where, it.Item)
		}
		hasNode := false
		for _, n := range npcs[r.Captain].Dialog.Nodes {
			hasNode = hasNode || n.BoatRoutes
		}
		if !hasNode {
			return fmt.Errorf("%s: captain %q has no dialog node with boat_routes: true", where, r.Captain)
		}
	}
	return nil
}
