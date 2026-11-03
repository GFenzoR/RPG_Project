package main

import (
	"fmt"

	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
)

// area is a part of the island where a bot spends the test: it wanders within radius of
// center and fights the monsters and talks to the NPCs it sees there.
type area struct {
	name   string
	center bot.Pos
	radius int
}

// scenario describes where the bots play (docs/07-performance-budget.md, "Pruebas de carga").
type scenario struct {
	name  string
	areas []area
	// fight enables attacking monsters (the town is a protection zone).
	fight bool
}

// Isla del Puerto (world/islands/puerto): new characters appear in the temple of Farol.
// The areas follow the spawns, NPCs and zones of the island's YAML, all on floor 7.
var (
	puertoTown = area{"town", bot.Pos{X: 3166, Y: 6386, Z: 7}, 8}

	scenarios = map[string]scenario{
		// base: bots spread over the island (town, harbour, fields, wreck, forest).
		"base": {name: "base", fight: true, areas: []area{
			puertoTown,
			{"harbour", bot.Pos{X: 3192, Y: 6430, Z: 7}, 6},
			{"wolves-north", bot.Pos{X: 3212, Y: 6372, Z: 7}, 6},
			{"wolves-south", bot.Pos{X: 3220, Y: 6394, Z: 7}, 6},
			{"boars", bot.Pos{X: 3118, Y: 6378, Z: 7}, 6},
			{"spiders", bot.Pos{X: 3124, Y: 6416, Z: 7}, 6},
			{"wreck", bot.Pos{X: 3122, Y: 6334, Z: 7}, 7},
			{"crabs-east", bot.Pos{X: 3236, Y: 6384, Z: 7}, 4},
			{"mine-entrance", bot.Pos{X: 3172, Y: 6329, Z: 7}, 5},
		}},
		// stress: every bot packed in the town (temple, plaza and depot).
		"stress": {name: "stress", fight: false, areas: []area{puertoTown}},
	}
)

func scenarioByName(name string) (scenario, error) {
	s, ok := scenarios[name]
	if !ok {
		return scenario{}, fmt.Errorf("unknown scenario %q (base, stress)", name)
	}
	return s, nil
}

// areaFor returns bot i's area: round robin, so every area gets bots.
func (s scenario) areaFor(i int) area { return s.areas[i%len(s.areas)] }
