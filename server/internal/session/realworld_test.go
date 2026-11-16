package session_test

import (
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// TestRealWorldStarts: the real world/ and data/, with every NPC dialog teleport and the
// boat routes of data/boat_routes.yaml, start a session both as the production image
// compiles the map (no dev-only islands) and as make mapcompile does (-dev: with the
// sandbox island, docs/16-probar-el-juego.md). There the practice gate shuts its vault.
func TestRealWorldStarts(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	dir := filepath.Join(root, "data")
	for _, dev := range []bool{false, true} {
		m, err := compile.Build(root, compile.Options{DevIslands: dev})
		if err != nil {
			t.Fatalf("dev islands %v: %v", dev, err)
		}
		if got := m.Island("pruebas") != nil; got != dev {
			t.Fatalf("dev islands %v: the sandbox island is in the map: %v", dev, got)
		}
		npcs, err := content.LoadNPCs(dir)
		if err != nil {
			t.Fatal(err)
		}
		routes, err := content.LoadBoatRoutes(dir)
		if err != nil {
			t.Fatal(err)
		}
		cfg := dataConfig(t, routes)
		cfg.Map, cfg.NPCs = m, npcs
		w, err := session.New(cfg)
		if err != nil {
			t.Fatalf("dev islands %v: %v", dev, err)
		}
		if !dev {
			continue
		}
		at := func(x, y int) world.Pos { return world.Pos{X: uint16(x), Y: uint16(y), Z: 7} }
		gate := at(2117, 2101)
		if !w.InDoorRoom(gate, at(2117, 2103)) || w.InDoorRoom(gate, at(2117, 2099)) {
			t.Fatal("the practice gate does not shut the vault off the yard of portals")
		}
	}
}
