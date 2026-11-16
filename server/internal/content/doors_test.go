package content

import (
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func doorItems(t *testing.T, src string) Items {
	t.Helper()
	var list []*Item
	if err := yaml.Unmarshal([]byte(src), &list); err != nil {
		t.Fatal(err)
	}
	out := Items{}
	for _, it := range list {
		out[it.ID] = it
	}
	return out
}

const goodDoors = `
- {id: gate, kind: decoration, pickupable: false, blocks_movement: true, blocks_sight: true, door: {key: lock, open: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, door: {closed: gate}}
- {id: hatch, kind: wall, pickupable: false, door: {open: hatch_open}}
- {id: hatch_open, kind: wall, pickupable: false, blocks_movement: false, blocks_sight: false, door: {closed: hatch}}
- {id: lock_key, kind: material, key: lock}
`

func TestCheckDoors(t *testing.T) {
	if err := CheckDoors(doorItems(t, goodDoors)); err != nil {
		t.Fatalf("good doors: %v", err)
	}
	items := doorItems(t, goodDoors)
	if g := items["gate"]; !g.BlocksMovement() || !g.BlocksSight() || items["gate_open"].BlocksMovement() {
		t.Fatal("blocks flags of the gate pair")
	}
	// kind: wall blocks by default, and says otherwise explicitly.
	if !items["hatch"].BlocksMovement() || !items["hatch"].BlocksSight() || items["hatch_open"].BlocksSight() {
		t.Fatal("blocks flags of the hatch pair")
	}

	bad := map[string]string{
		"both ends": `
- {id: gate, kind: decoration, pickupable: false, blocks_movement: true, door: {open: gate_open, closed: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, door: {closed: gate}}`,
		"pickupable": `
- {id: gate, kind: decoration, blocks_movement: true, door: {open: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, door: {closed: gate}}`,
		"not paired back": `
- {id: gate, kind: decoration, pickupable: false, blocks_movement: true, door: {open: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, door: {closed: other}}
- {id: other, kind: decoration, pickupable: false, blocks_movement: true, door: {open: gate_open}}`,
		"unknown pair": `
- {id: gate, kind: decoration, pickupable: false, blocks_movement: true, door: {open: nowhere}}`,
		"open blocks": `
- {id: gate, kind: decoration, pickupable: false, blocks_movement: true, door: {open: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, blocks_movement: true, door: {closed: gate}}`,
		"closed walkable": `
- {id: gate, kind: decoration, pickupable: false, door: {open: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, door: {closed: gate}}`,
		"key on the open one": `
- {id: gate, kind: decoration, pickupable: false, blocks_movement: true, door: {open: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, door: {key: lock, closed: gate}}
- {id: lock_key, kind: material, key: lock}`,
		"lock without key": `
- {id: gate, kind: decoration, pickupable: false, blocks_movement: true, door: {key: lock, open: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, door: {closed: gate}}`,
		"door is a key": `
- {id: gate, kind: decoration, pickupable: false, blocks_movement: true, key: lock, door: {key: lock, open: gate_open}}
- {id: gate_open, kind: decoration, pickupable: false, door: {closed: gate}}`,
	}
	for name, src := range bad {
		if err := CheckDoors(doorItems(t, src)); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// The doors and keys of data/ pass, and the forge gate of Chapter 3 opens with the key
// the forge echo gives (docs/02 "Puertas con llave").
func TestDataDoors(t *testing.T) {
	items, err := LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckDoors(items); err != nil {
		t.Fatal(err)
	}
	gate, key := items["forge_gate"], items["ember_key"]
	if gate == nil || gate.Door == nil || key == nil || key.Key == "" || gate.Door.Key != key.Key {
		t.Fatal("forge_gate is not locked with the ember key")
	}
	if key.Tradeable || !strings.HasPrefix(gate.Door.Open, "forge_gate") {
		t.Fatalf("ember key tradeable %v, gate opens into %q", key.Tradeable, gate.Door.Open)
	}
}
