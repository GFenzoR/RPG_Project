package content_test

import (
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

const looksYAML = `
limits: { change_burst: 3, change_refill_ms: 1000 }
builds: [sturdy, slender]
skins:
  fair: { color: "#ecc4a2" }
  ashen: { color: "#b2aaa6", creatures_only: true }
  tan: { color: "#d8a47c" }
hair_styles: [bald, short, long]
beards: [none, full]
hair_colors:
  black: "#2e2a30"
  red: "#b8502c"
shapes:
  head: [cap]
  torso: [tunic]
  legs: [trousers]
  feet: [boots]
  shield: [round]
  weapon: [sword]
tints:
  iron: "#a8aeb6"
  linen: "#ece2c8"
`

func TestParseLooks(t *testing.T) {
	l, err := content.ParseLooks([]byte(looksYAML))
	if err != nil {
		t.Fatal(err)
	}
	// File order, the creatures-only skins apart.
	if strings.Join(l.Skins, ",") != "fair,tan" || strings.Join(l.CreatureSkins, ",") != "ashen" {
		t.Fatalf("skins %v, creature skins %v", l.Skins, l.CreatureSkins)
	}
	if strings.Join(l.HairColors, ",") != "black,red" || l.Limits.ChangeBurst != 3 || l.Limits.ChangeRefillMs != 1000 {
		t.Fatalf("hair colours %v, limits %+v", l.HairColors, l.Limits)
	}

	ok := content.Look{Body: "slender", Skin: "tan", Hair: "long", HairColor: "red", Beard: "none"}
	if !l.PlayerLook(ok) {
		t.Fatalf("%+v refused", ok)
	}
	for name, bad := range map[string]content.Look{
		"a creatures-only skin": {Body: "sturdy", Skin: "ashen", Hair: "short", HairColor: "black", Beard: "none"},
		"an unknown build":      {Body: "giant", Skin: "fair", Hair: "short", HairColor: "black", Beard: "none"},
		"an unknown hair":       {Body: "sturdy", Skin: "fair", Hair: "mohawk", HairColor: "black", Beard: "none"},
		"an unknown colour":     {Body: "sturdy", Skin: "fair", Hair: "short", HairColor: "blue", Beard: "none"},
		"an unknown beard":      {Body: "sturdy", Skin: "fair", Hair: "short", HairColor: "black", Beard: "goatee"},
		"empty":                 {},
	} {
		if l.PlayerLook(bad) {
			t.Errorf("%s accepted: %+v", name, bad)
		}
	}

	// NPCs and monsters may have the creatures-only skins; what they wear must be drawn.
	npc := content.CreatureLook{Look: content.Look{Body: "sturdy", Skin: "ashen", Hair: "bald", HairColor: "black", Beard: "full"},
		Worn: map[string]content.WornPiece{"torso": {Shape: "tunic", Tint: "linen"}, "weapon": {Shape: "sword", Tint: "iron"}}}
	if err := l.CheckCreature(npc); err != nil {
		t.Fatal(err)
	}
	npc.Worn["weapon"] = content.WornPiece{Shape: "tunic", Tint: "iron"}
	if l.CheckCreature(npc) == nil {
		t.Fatal("a tunic in the weapon slot accepted")
	}
	npc.Worn["weapon"] = content.WornPiece{Shape: "sword", Tint: "gold"}
	if l.CheckCreature(npc) == nil {
		t.Fatal("an unknown tint accepted")
	}
}

func TestParseLooksNeedsChoicesAndLimits(t *testing.T) {
	noSkins := strings.Replace(looksYAML, `  fair: { color: "#ecc4a2" }`, `  fair: { color: "#ecc4a2", creatures_only: true }`, 1)
	noSkins = strings.Replace(noSkins, `  tan: { color: "#d8a47c" }`, `  tan: { color: "#d8a47c", creatures_only: true }`, 1)
	if _, err := content.ParseLooks([]byte(noSkins)); err == nil {
		t.Fatal("looks without a skin a player can choose accepted")
	}
	noLimits := strings.Replace(looksYAML, "limits: { change_burst: 3, change_refill_ms: 1000 }", "", 1)
	if _, err := content.ParseLooks([]byte(noLimits)); err == nil {
		t.Fatal("looks without limits accepted")
	}
}

// A character without a look gets one from its id: always the same, always a player's
// choice, and neighbouring ids do not all look alike.
func TestDefaultLook(t *testing.T) {
	l, err := content.ParseLooks([]byte(looksYAML))
	if err != nil {
		t.Fatal(err)
	}
	seen := map[content.Look]bool{}
	for id := int64(1); id <= 200; id++ {
		look := l.DefaultLook(id)
		if look != l.DefaultLook(id) {
			t.Fatalf("id %d: two looks", id)
		}
		if !l.PlayerLook(look) {
			t.Fatalf("id %d: %+v is not a player's look", id, look)
		}
		seen[look] = true
	}
	// 2 builds x 2 skins x 3 hairs x 2 colours x 2 beards = 48 looks: 200 ids find most.
	if len(seen) < 40 {
		t.Fatalf("200 ids got only %d looks", len(seen))
	}
}

// The real data: every NPC and monster look of data/ is one the engine draws.
func TestDataLooks(t *testing.T) {
	l, err := content.LoadLooks("../../../data")
	if err != nil || l == nil {
		t.Fatalf("looks: %v", err)
	}
	npcs, err := content.LoadNPCs("../../../data")
	if err != nil {
		t.Fatal(err)
	}
	monsters, err := content.LoadMonsters("../../../data")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for id, def := range npcs {
		if def.Look != nil {
			n++
			if err := l.CheckCreature(*def.Look); err != nil {
				t.Errorf("npc %s: %v", id, err)
			}
		}
	}
	for id, def := range monsters {
		if def.Look != nil {
			n++
			if err := l.CheckCreature(*def.Look); err != nil {
				t.Errorf("monster %s: %v", id, err)
			}
		}
	}
	if n == 0 {
		t.Fatal("no NPC or monster has a look")
	}
}
