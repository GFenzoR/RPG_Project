package content_test

import (
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

const looksYAML = `
limits: { change_burst: 3, change_refill_ms: 1000 }
sexes: [male, female]
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

	ok := content.Look{Sex: "female", Body: "slender", Skin: "tan", Hair: "long", HairColor: "red", Beard: "none"}
	if !l.PlayerLook(ok) {
		t.Fatalf("%+v refused", ok)
	}
	for name, bad := range map[string]content.Look{
		"a creatures-only skin": {Sex: "male", Body: "sturdy", Skin: "ashen", Hair: "short", HairColor: "black", Beard: "none"},
		"an unknown build":      {Body: "giant", Skin: "fair", Hair: "short", HairColor: "black", Beard: "none"},
		"an unknown hair":       {Body: "sturdy", Skin: "fair", Hair: "mohawk", HairColor: "black", Beard: "none"},
		"an unknown colour":     {Body: "sturdy", Skin: "fair", Hair: "short", HairColor: "blue", Beard: "none"},
		"an unknown beard":      {Body: "sturdy", Skin: "fair", Hair: "short", HairColor: "black", Beard: "goatee"},
		"an unknown sex":        {Sex: "other", Body: "sturdy", Skin: "fair", Hair: "short", HairColor: "black", Beard: "none"},
		"no sex":                {Body: "sturdy", Skin: "fair", Hair: "short", HairColor: "black", Beard: "none"},
		"empty":                 {},
	} {
		if l.PlayerLook(bad) {
			t.Errorf("%s accepted: %+v", name, bad)
		}
	}

	// NPCs and monsters may have the creatures-only skins; what they wear must be drawn.
	npc := content.CreatureLook{Look: content.Look{Sex: "male", Body: "sturdy", Skin: "ashen", Hair: "bald", HairColor: "black", Beard: "full"},
		Worn: map[string]content.WornPiece{"torso": {Shape: "tunic", Tint: "linen"}, "weapon": {Shape: "sword", Tint: "iron"}}}
	if err := l.CheckCreature(npc); err != nil {
		t.Fatal(err)
	}
	npc.Sex = ""
	if l.CheckCreature(npc) == nil {
		t.Fatal("a creature without a sex accepted")
	}
	npc.Sex = "female"
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
	// 2 sexes x 2 builds x 2 skins x 3 hairs x 2 colours x 2 beards = 96 looks: 200 ids
	// find most.
	if len(seen) < 70 {
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

// Adding the sex (migration 00022) changed no existing default: the other fields of
// DefaultLook over the real data are the ones the code before it picked (computed with
// that code), and the sex is one of data/looks.yaml.
func TestDefaultLookStableAcrossTheSex(t *testing.T) {
	l, err := content.LoadLooks("../../../data")
	if err != nil || l == nil {
		t.Fatalf("looks: %v", err)
	}
	before := map[int64]content.Look{
		1:         {Body: "slender", Skin: "tan", Hair: "topknot", HairColor: "grey", Beard: "short"},
		2:         {Body: "sturdy", Skin: "deep", Hair: "long", HairColor: "red", Beard: "short"},
		3:         {Body: "slender", Skin: "brown", Hair: "bald", HairColor: "auburn", Beard: "none"},
		42:        {Body: "slender", Skin: "pale", Hair: "topknot", HairColor: "red", Beard: "full"},
		1000:      {Body: "sturdy", Skin: "tan", Hair: "crop", HairColor: "red", Beard: "short"},
		123456789: {Body: "slender", Skin: "tan", Hair: "bald", HairColor: "red", Beard: "short"},
	}
	sexes := map[string]int{}
	for id, want := range before {
		got := l.DefaultLook(id)
		sexes[got.Sex]++
		want.Sex = got.Sex
		if got != want {
			t.Errorf("id %d: %+v, before the sex %+v", id, got, want)
		}
		if !l.PlayerLook(got) {
			t.Errorf("id %d: %+v is not a player's look", id, got)
		}
	}
	// Both sexes come out of the ids (not every character became a man).
	for id := int64(1); id <= 50; id++ {
		sexes[l.DefaultLook(id).Sex]++
	}
	if sexes["male"] == 0 || sexes["female"] == 0 {
		t.Fatalf("sexes over 56 ids: %v", sexes)
	}
}

// At login a saved look is kept; one saved before the sex keeps its fields and gets the
// sex DefaultLook picks from the id; an invalid one is DefaultLook.
func TestSavedLook(t *testing.T) {
	l, err := content.ParseLooks([]byte(looksYAML))
	if err != nil {
		t.Fatal(err)
	}
	full := content.Look{Sex: "female", Body: "sturdy", Skin: "fair", Hair: "long", HairColor: "red", Beard: "none"}
	if got := l.SavedLook(7, full); got != full {
		t.Fatalf("a valid look changed: %+v", got)
	}
	old := full
	old.Sex = ""
	want := full
	want.Sex = l.DefaultLook(7).Sex
	if got := l.SavedLook(7, old); got != want {
		t.Fatalf("a look saved before the sex: %+v, want %+v", got, want)
	}
	if got := l.SavedLook(7, l.SavedLook(7, old)); got != want {
		t.Fatalf("not stable: %+v", got)
	}
	bad := old
	bad.Hair = "mohawk"
	if got := l.SavedLook(7, bad); got != l.DefaultLook(7) {
		t.Fatalf("an invalid look: %+v, want the default", got)
	}
	if got := l.SavedLook(7, content.Look{}); got != l.DefaultLook(7) {
		t.Fatalf("no look: %+v, want the default", got)
	}
}

// The NPCs and humanoid monsters are the sex their names and texts say (i18n/*/npcs.yaml,
// monsters.yaml), and no woman of data/ wears a beard.
func TestDataLookSexes(t *testing.T) {
	npcs, err := content.LoadNPCs("../../../data")
	if err != nil {
		t.Fatal(err)
	}
	monsters, err := content.LoadMonsters("../../../data")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"harbor_master": "female", "puerto_provisioner": "female", "puerto_priest": "female",
		"bosque_druid": "female", "bosque_merchant": "female", "volcan_keeper": "female",
		"volcan_priest": "female", "volcan_ferryman": "female", "pruebas_trainer": "female",
		"puerto_armorer": "male", "puerto_foreman": "male", "puerto_diver": "male",
		"bosque_ferryman": "male", "bosque_priest": "male", "bosque_hunter": "male",
		"volcan_smith": "male", "volcan_hunter": "male", "pruebas_merchant": "male",
		"pruebas_ferryman":     "male",
		"monster:wreck_looter": "male", "monster:drowned_miner": "male",
		"monster:obsidian_delver": "male", "monster:coffer_smuggler": "female",
	}
	got := map[string]content.Look{}
	for id, def := range npcs {
		if def.Look != nil {
			got[id] = def.Look.Look
		}
	}
	for id, def := range monsters {
		if def.Look != nil {
			got["monster:"+id] = def.Look.Look
		}
	}
	if len(got) != len(want) {
		t.Errorf("%d humanoids in data/, %d in this test: add the new one", len(got), len(want))
	}
	for id, look := range got {
		if look.Sex != want[id] {
			t.Errorf("%s: sex %q, want %q", id, look.Sex, want[id])
		}
		if look.Sex == "female" && look.Beard != "none" {
			t.Errorf("%s: a woman with beard %q", id, look.Beard)
		}
	}
}
