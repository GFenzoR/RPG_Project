package content

import (
	"path/filepath"
	"testing"
)

// A portal look shows its kind, and the way it leads when it says one (z grows going
// down); no look shows nothing.
func TestPortalLookShows(t *testing.T) {
	down := &PortalLook{Kind: "stairs", Leads: "down"}
	oneWay := &PortalLook{Kind: "teleport"}
	var none *PortalLook
	for _, c := range []struct {
		look     *PortalLook
		kind     string
		from, to uint8
		want     bool
	}{
		{down, "stairs", 7, 8, true},
		{down, "stairs", 8, 7, false}, // the wrong way
		{down, "ladder", 7, 8, false}, // another kind
		{oneWay, "teleport", 7, 7, true},
		{oneWay, "teleport", 7, 9, true},
		{none, "stairs", 7, 8, false},
	} {
		if got := c.look.Shows(c.kind, c.from, c.to); got != c.want {
			t.Errorf("%+v.Shows(%s, %d, %d) = %v", c.look, c.kind, c.from, c.to, got)
		}
	}
}

// The portal items of data/ declare what they show (docs/03 "Validación").
func TestRepositoryPortalLooks(t *testing.T) {
	items, err := LoadItems(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]PortalLook{
		"stairs_down": {Kind: "stairs", Leads: "down"},
		"stairs_up":   {Kind: "stairs", Leads: "up"},
		"ladder_up":   {Kind: "ladder", Leads: "up"},
		"ladder_down": {Kind: "ladder", Leads: "down"},
		"hole":        {Kind: "hole"},
		"rope_spot":   {Kind: "rope_spot"},
		"teleport":    {Kind: "teleport"},
	} {
		it := items[id]
		if it == nil || it.Portal == nil || *it.Portal != want || it.CanPickUp() || it.BlocksMovement() {
			t.Errorf("item %q: %+v", id, it)
		}
	}
}
