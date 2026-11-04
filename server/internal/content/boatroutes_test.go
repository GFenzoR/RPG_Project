package content_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

func TestBoatRoutesLoadAndCheck(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "data")
	npcs, err := content.LoadNPCs(dir)
	if err != nil {
		t.Fatal(err)
	}
	quests, err := content.LoadQuests(dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := content.LoadItems(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		filepath.Join(dir, "boat_routes.yaml"),
		filepath.Join("..", "..", "..", "client", "e2e", "fixtures", "boat_routes.yaml"),
	} {
		rs, err := content.LoadBoatRoutesFile(path, false)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if err := rs.Check(npcs, quests, items); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}

	if rs, err := content.LoadBoatRoutes(t.TempDir()); err != nil || rs != nil {
		t.Fatalf("missing file: %v, %v", rs, err)
	}
	if _, err := content.LoadBoatRoutesFile(filepath.Join(t.TempDir(), "x.yaml"), false); err == nil {
		t.Fatal("a missing -boat-routes file was accepted")
	}
	dup := filepath.Join(t.TempDir(), "dup.yaml")
	route := "- { id: a, captain: harbor_master, text: dialog.bye, from: { x: 1, y: 1, z: 7 }, to: { x: 1, y: 1, z: 7 }, price: 1 }\n"
	if err := os.WriteFile(dup, []byte(route+route), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := content.LoadBoatRoutesFile(dup, false); err == nil {
		t.Fatal("duplicate ids accepted")
	}
	bad := content.BoatRoutes{{ID: "x", Captain: "puerto_priest", Text: "dialog.bye"}}
	if err := bad.Check(npcs, quests, items); err == nil {
		t.Fatal("a captain without a boat_routes node was accepted")
	}
}
