package world

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
)

func at(x, y, z int) Pos { return Pos{X: uint16(x), Y: uint16(y), Z: uint8(z)} }

// portalMap is a 5x4 island on floors 7 and 8 (grass, a wall at 34,33 on both floors and
// a house at 30..31,30 on floor 7) with the portals given.
func portalMap(t *testing.T, portals ...Portal) (*Map, error) {
	t.Helper()
	rows := []string{
		".....",
		".....",
		".....",
		"....#",
	}
	up, down := asciiMap(t, 30, 30, 7, rows...), asciiMap(t, 30, 30, 8, rows...)
	is := *up.Islands()[0]
	is.Floors = []uint8{7, 8}
	is.Houses = []House{{ID: "shed", Name: "house.shed.name", Rent: 10,
		Rects: []HouseRect{{X: 30, Y: 30, Z: 7, W: 2, H: 1}}, Doors: []Pos{pt(30, 30)}, Exit: pt(30, 31)}}
	is.Portals = portals
	sectors := append(up.Islands()[0].Sectors(), down.Islands()[0].Sectors()...)
	return NewMap([]*Island{&is}, map[string][]*Sector{is.ID: sectors}, testSpeeds)
}

func testPortals() []Portal {
	return []Portal{
		{ID: "down", Kind: PortalStairs, From: at(33, 31, 7), To: at(33, 32, 8)},
		{ID: "up", Kind: PortalStairs, From: at(33, 31, 8), To: at(33, 32, 7)},
		{ID: "pit", Kind: PortalHole, From: at(32, 32, 7), To: at(32, 32, 8)},
		{ID: "climb", Kind: PortalLadder, From: at(31, 32, 8), To: at(31, 32, 7)},
		{ID: "rope", Kind: PortalRopeSpot, From: at(32, 33, 8), To: at(32, 33, 7)},
		{ID: "gate", Kind: PortalTeleport, From: at(31, 33, 7), To: at(34, 30, 7)},
		{ID: "ferry", Kind: PortalBoat, From: at(34, 31, 7), To: at(34, 32, 7)},
	}
}

func TestPortalsIndexAndRoundTrip(t *testing.T) {
	m, err := portalMap(t, testPortals()...)
	if err != nil {
		t.Fatal(err)
	}
	if pt := m.PortalAt(at(33, 31, 7)); pt == nil || pt.ID != "down" || pt.To != at(33, 32, 8) {
		t.Fatalf("PortalAt(33,31,7) = %+v", pt)
	}
	if m.PortalAt(at(33, 32, 8)) != nil {
		t.Fatal("a portal leaves from a destination tile")
	}
	for p, want := range map[Pos]bool{
		at(33, 31, 7): true, at(32, 32, 7): true, at(31, 33, 7): true, // stairs, hole, teleport
		at(31, 32, 8): false, at(32, 33, 8): false, at(34, 31, 7): false, // ladder, rope, boat
		at(30, 31, 7): false,
	} {
		if got := m.MovesOnStep(p); got != want {
			t.Errorf("MovesOnStep(%v) = %v, want %v", p, got, want)
		}
	}
	if n := len(m.Portals()); n != 7 {
		t.Fatalf("%d portals", n)
	}
	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	back, err := Decode(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, m) || back.PortalAt(at(31, 32, 8)).Kind != PortalLadder {
		t.Fatalf("portals after decode = %+v", back.Portals())
	}
	var again bytes.Buffer
	if err := Encode(&again, back); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf.Bytes(), again.Bytes()) {
		t.Fatal("re-encoding changed the bytes")
	}
}

func TestPortalChecks(t *testing.T) {
	one := func(f func(p *Portal)) []Portal {
		p := Portal{ID: "down", Kind: PortalStairs, From: at(33, 31, 7), To: at(33, 32, 8)}
		f(&p)
		return []Portal{p}
	}
	cases := []struct {
		name    string
		portals []Portal
		want    string
	}{
		{"no id", one(func(p *Portal) { p.ID = "" }), "unique id"},
		{"bad id", one(func(p *Portal) { p.ID = "Down" }), "unique id"},
		{"twice", append(one(func(*Portal) {}), one(func(p *Portal) { p.From = at(32, 31, 7) })...), "unique id"},
		{"kind", one(func(p *Portal) { p.Kind = 9 }), "unknown portal kind 9"},
		{"no kind", one(func(p *Portal) { p.Kind = 0 }), "unknown"},
		{"from outside", one(func(p *Portal) { p.From = at(90, 31, 7) }), "entrance"},
		{"from floor", one(func(p *Portal) { p.From = at(33, 31, 9) }), "entrance"},
		{"from wall", one(func(p *Portal) { p.From = at(34, 33, 7) }), "entrance"},
		{"to wall", one(func(p *Portal) { p.To = at(34, 33, 8) }), "destination"},
		{"to nowhere", one(func(p *Portal) { p.To = at(300, 300, 8) }), "destination"},
		{"own tile", one(func(p *Portal) { p.Kind, p.To = PortalTeleport, p.From }), "own tile"},
		{"same floor", one(func(p *Portal) { p.To = at(33, 32, 7) }), "must change floor"},
		{"ladder floor", one(func(p *Portal) { p.Kind, p.To = PortalLadder, at(33, 32, 7) }), "must change floor"},
		{"hole up", one(func(p *Portal) { p.Kind, p.From, p.To = PortalHole, at(33, 31, 8), at(33, 32, 7) }), "leads down"},
		{"rope down", one(func(p *Portal) { p.Kind = PortalRopeSpot }), "leads up"},
		{"same tile", append(one(func(*Portal) {}), one(func(p *Portal) { p.ID = "other" })...), "same tile"},
		{"from house", one(func(p *Portal) { p.From = at(31, 30, 7) }), "house"},
		{"to house", one(func(p *Portal) { p.From, p.To = at(31, 30, 8), at(31, 30, 7) }), "house"},
	}
	for _, c := range cases {
		if _, err := portalMap(t, c.portals...); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
	if _, err := portalMap(t, one(func(p *Portal) { p.Kind, p.To = PortalTeleport, at(30, 33, 7) })...); err != nil {
		t.Fatalf("a teleport on its own floor: %v", err)
	}
}

func TestParsePortalKind(t *testing.T) {
	for _, name := range []string{"stairs", "ladder", "hole", "rope_spot", "teleport", "boat"} {
		k, ok := ParsePortalKind(name)
		if !ok || k.String() != name {
			t.Errorf("ParsePortalKind(%q) = %v, %v", name, k, ok)
		}
	}
	if _, ok := ParsePortalKind("ramp"); ok {
		t.Error("ramp is a portal kind")
	}
	if _, ok := ParsePortalKind(""); ok {
		t.Error("the empty name is a portal kind")
	}
}
