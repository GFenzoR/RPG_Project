package session_test

import (
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// The forge gate on the real map (world/islands/volcan, floor 8; docs/02 "Puertas con
// llave"): it shuts the forge room off the mine until the ember key opens it, and it does
// not lock again on a player without the key in the forge, while one in the mine does not
// count.
func TestForgeGateOnTheMap(t *testing.T) {
	m, err := compile.Compile(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	at8 := func(x, y int) world.Pos { return world.Pos{X: uint16(x), Y: uint16(y), Z: 8} }
	gate, mine, forge := at8(3692, 5832), at8(3688, 5826), at8(3692, 5845)
	h := dataHarnessWith(t, func(cfg *session.Config) {
		cfg.Map = m
		for _, is := range m.Islands() {
			is.Spawns = nil // no monsters: this is about the gate
		}
	})
	shut, open := h.w.ItemForTest("forge_gate"), h.w.ItemForTest("forge_gate_open")
	if st := m.Stack(gate); len(st) != 1 || st[0] != shut.Numeric || m.Walkable(gate) || m.LineOfSight(at8(3692, 5830), at8(3692, 5834)) {
		t.Fatalf("the forge gate is not shut at %v: stack %v", gate, st)
	}

	clA, a := h.joinFresh(session.Character{ID: 9301, AccountID: 9301, Name: "Keyholder", Vocation: "guardian", Level: 40, Health: 1000, Mana: 100}, at8(3692, 5831))
	_, b := h.joinFresh(session.Character{ID: 9302, AccountID: 9302, Name: "Stray", Vocation: "guardian", Level: 40, Health: 1000, Mana: 100}, forge)
	h.sim.Command(gameFunc(func() { h.w.GiveForTest(a, "ember_key", 1) }))
	h.sim.Step()
	clA.take()

	if evs := h.send(clA, useItem(onTile(gate), uint32(shut.Numeric), 1)); !hasKey(evs, "door.unlocked") || !m.Walkable(gate) {
		t.Fatalf("open with the ember key: %v", systemKeys(evs))
	}
	if evs := h.send(clA, useItem(onTile(gate), uint32(open.Numeric), 1)); !hasKey(evs, "door.shut_in") || !m.Walkable(gate) {
		t.Fatalf("lock with a keyless player in the forge: %v", systemKeys(evs))
	}
	h.sim.Command(gameFunc(func() { h.w.Teleport(b, mine) }))
	h.sim.Step()
	clA.take()
	if evs := h.send(clA, useItem(onTile(gate), uint32(open.Numeric), 1)); !hasKey(evs, "door.relocked") || m.Walkable(gate) {
		t.Fatalf("lock with the keyless player in the mine: %v", systemKeys(evs))
	}
}
