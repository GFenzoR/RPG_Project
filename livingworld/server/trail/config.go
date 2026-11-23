// Package trail is the living world's trail wear (livingworld/README.md "Desgaste de
// senderos"): grass that many players walk over shows the dirt under it, and recovers when
// nobody walks there any more. It is shared world state, so it lives on the server: the
// game loop owns a Map, tells it every counted step (OnStep) and every tick (OnTick), and
// sends the players who see a tile the level changes it drains (TakeChanges). A copy of
// the Map (Snapshot) leaves the loop to be written to the database; Restore reads it back
// at start.
//
// Every method runs on the game loop goroutine: no locks, no wall clock (time is the tick
// number the loop passes), no I/O. The package never imports server/: the glue
// (server/internal/session/trailwear.go) turns the server's map and creatures into Pos,
// surfaces and walkers.
package trail

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"slices"

	"go.yaml.in/yaml/v3"
)

// Levels: what the client draws (0 none, 1 trampled, 2 worn, 3 bare dirt).
const (
	LevelNone uint8 = iota
	LevelTrampled
	LevelWorn
	LevelBare
	// MaxLevel is the highest level.
	MaxLevel = LevelBare
)

// Config is data/livingworld/wear.yaml (schema livingworld-wear.schema.json). Wear is an
// integer per tile: a step adds PlayerStep (or MonsterStep) up to Max; every DecayEveryMs
// it loses Decay. Levels are the thresholds of levels 1, 2 and 3.
type Config struct {
	// Surfaces are the ground surfaces (data/items ground.surface) that wear.
	Surfaces []string `yaml:"surfaces"`
	// PlayerStep and MonsterStep are the wear points of one step of a player and of a
	// monster (0: monsters leave no trail). NPCs never wear.
	PlayerStep  int `yaml:"player_step"`
	MonsterStep int `yaml:"monster_step"`
	// Max caps a tile's wear: how long a beaten path takes to recover.
	Max int `yaml:"max"`
	// Levels are the wear of levels 1, 2 and 3, ascending, in 1..Max.
	Levels [3]int `yaml:"levels"`
	// DecayEveryMs and Decay: every DecayEveryMs each worn tile loses Decay points.
	DecayEveryMs int `yaml:"decay_every_ms"`
	Decay        int `yaml:"decay"`
	// SaveEveryMs is how often the loop hands a Snapshot to persistence.
	SaveEveryMs int `yaml:"save_every_ms"`
}

// ParseConfig decodes data/livingworld/wear.yaml and checks it.
func ParseConfig(raw []byte) (Config, error) {
	var c Config
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return Config{}, fmt.Errorf("decode trail wear: %w", err)
	}
	if err := c.Check(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// LoadConfig reads and checks the file at path.
func LoadConfig(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read trail wear: %w", err)
	}
	c, err := ParseConfig(raw)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

// Check reports a config the Map cannot run with.
func (c Config) Check() error {
	switch {
	case len(c.Surfaces) == 0:
		return errors.New("trail wear: surfaces must name at least one ground surface")
	case c.PlayerStep < 1 || c.MonsterStep < 0:
		return errors.New("trail wear: player_step must be >= 1 and monster_step >= 0")
	case c.Max < 1 || c.Max > 0xFFFF:
		return errors.New("trail wear: max must be in 1..65535")
	case c.Levels[0] < 1 || c.Levels[0] >= c.Levels[1] || c.Levels[1] >= c.Levels[2] || c.Levels[2] > c.Max:
		return errors.New("trail wear: levels must be ascending, in 1..max")
	case c.DecayEveryMs < 1 || c.Decay < 1:
		return errors.New("trail wear: decay_every_ms and decay must be >= 1")
	case c.SaveEveryMs < 1:
		return errors.New("trail wear: save_every_ms must be >= 1")
	}
	return nil
}

// Wears reports whether ground surface s wears.
func (c Config) Wears(s string) bool { return s != "" && slices.Contains(c.Surfaces, s) }

// Level quantizes wear v to a level (0..3).
func (c Config) Level(v int) uint8 {
	l := LevelNone
	for _, t := range c.Levels {
		if v >= t {
			l++
		}
	}
	return l
}
