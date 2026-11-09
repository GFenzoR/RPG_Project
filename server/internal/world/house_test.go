package world

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
)

func testHouse() House {
	return House{ID: "cottage", Name: "house.cottage.name", Rent: 500,
		Rects: []HouseRect{{X: 31, Y: 31, Z: 7, W: 3, H: 2}},
		Doors: []Pos{pt(32, 32)}, Exit: pt(32, 33)}
}

func houseMap(t *testing.T, houses ...House) (*Map, error) {
	t.Helper()
	m := asciiMap(t, 30, 30, 7,
		".....",
		".....",
		".....",
		".....",
	)
	is := m.Islands()[0]
	is.Houses = houses
	return NewMap([]*Island{is}, map[string][]*Sector{is.ID: is.Sectors()}, testSpeeds)
}

func TestHouseTilesAndRoundTrip(t *testing.T) {
	m, err := houseMap(t, testHouse())
	if err != nil {
		t.Fatal(err)
	}
	h := m.HouseAt(pt(33, 32))
	if h == nil || h.ID != "cottage" || h.Island != "test" {
		t.Fatalf("HouseAt = %+v", h)
	}
	if m.HouseAt(pt(32, 33)) != nil || m.HouseAt(pt(30, 30)) != nil {
		t.Fatal("tiles outside the house belong to it")
	}
	if f := m.Flags(pt(31, 31)); f&FlagHouse == 0 || f&FlagProtection == 0 {
		t.Fatalf("house tile flags = %b, want house and protection", f)
	}
	if f := m.Flags(pt(32, 33)); f&(FlagHouse|FlagProtection) != 0 {
		t.Fatalf("exit flags = %b", f)
	}
	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	back, err := Decode(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back.Houses(), m.Houses()) || back.HouseAt(pt(33, 32)).ID != "cottage" {
		t.Fatalf("houses after decode = %+v", back.Houses())
	}
	var again bytes.Buffer
	if err := Encode(&again, back); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf.Bytes(), again.Bytes()) {
		t.Fatal("re-encoding changed the bytes")
	}
}

func TestHouseChecks(t *testing.T) {
	mod := func(f func(h *House)) House {
		h := testHouse()
		f(&h)
		return h
	}
	cases := []struct {
		name   string
		houses []House
		want   string
	}{
		{"no rent", []House{mod(func(h *House) { h.Rent = 0 })}, "rent > 0"},
		{"twice", []House{testHouse(), mod(func(h *House) { h.Rects = []HouseRect{{X: 30, Y: 30, Z: 7, W: 1, H: 1}} })}, "unique id"},
		{"overlap", []House{testHouse(), mod(func(h *House) { h.ID, h.Name = "other", "house.other.name" })}, "shares tile"},
		{"own overlap", []House{mod(func(h *House) { h.Rects = append(h.Rects, HouseRect{X: 32, Y: 31, Z: 7, W: 1, H: 2}) })}, "shares tile"},
		{"name", []House{mod(func(h *House) { h.Name = "house.other.name" })}, "house.<id>.name"},
		{"outside", []House{mod(func(h *House) { h.Rects[0].X = 70 })}, "outside the island"},
		{"floor", []House{mod(func(h *House) { h.Rects[0].Z = 8 })}, "floor"},
		{"door out", []House{mod(func(h *House) { h.Doors = []Pos{pt(30, 30)} })}, "door"},
		{"exit in", []House{mod(func(h *House) { h.Exit = pt(31, 31) })}, "exit"},
		{"exit far", []House{mod(func(h *House) { h.Exit = pt(34, 34) })}, "exit"},
		{"no door", []House{mod(func(h *House) { h.Doors = nil })}, "doors"},
	}
	for _, c := range cases {
		if _, err := houseMap(t, c.houses...); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
}
