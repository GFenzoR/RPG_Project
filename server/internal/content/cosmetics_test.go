package content

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadCosmeticsRepoData(t *testing.T) {
	s, err := LoadCosmetics(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	if s == nil {
		t.Skip("no data/cosmetics.yaml")
	}
	if len(s.Packs) == 0 || len(s.CosmeticIDs()) == 0 {
		t.Fatal("empty shop")
	}
	for _, id := range s.CosmeticIDs() {
		if c := s.Cosmetic(id); c.Price <= 0 {
			t.Errorf("%s: price %d", id, c.Price)
		}
	}
	if s.Pack(s.Packs[0].ID) == nil {
		t.Fatal("pack lookup")
	}
	if l := s.Limits; l.DailyPremium <= 0 || l.EquipBurst <= 0 || l.EquipRefillMs <= 0 || l.MaxPremiumGrant <= 0 {
		t.Fatalf("limits %+v", l)
	}
}

const limitsYAML = "limits: {daily_premium: 5000, equip_burst: 5, equip_refill_ms: 500, max_premium_grant: 100000}\n"

func TestLoadCosmeticsRejects(t *testing.T) {
	cases := map[string]string{
		"currency":  limitsYAML + "currency: {id: gold}\npacks: []\ncosmetics: []\n",
		"kind":      limitsYAML + "currency: {id: premium}\npacks: []\ncosmetics: [{id: a, kind: mount, price: 1}]\n",
		"tint":      limitsYAML + "currency: {id: premium}\npacks: []\ncosmetics: [{id: a, kind: outfit_color, price: 1, tint: red}]\n",
		"style":     limitsYAML + "currency: {id: premium}\npacks: []\ncosmetics: [{id: a, kind: name_effect, price: 1, style: neon}]\n",
		"outfit":    limitsYAML + "currency: {id: premium}\npacks: []\ncosmetics: [{id: a, kind: outfit, price: 1}]\n",
		"citizen":   limitsYAML + "currency: {id: premium}\npacks: []\ncosmetics: [{id: a, kind: outfit, price: 1, outfit: citizen}]\n",
		"unknown":   limitsYAML + "currency: {id: premium}\npacks: []\ncosmetics: [{id: a, kind: outfit, price: 1, outfit: pirate}]\n",
		"price":     limitsYAML + "currency: {id: premium}\npacks: []\ncosmetics: [{id: a, kind: name_effect, price: 0, style: gold}]\n",
		"duplicate": limitsYAML + "currency: {id: premium}\npacks: [{id: p, amount: 1, price: 1, currency: CLP}, {id: p, amount: 1, price: 1, currency: CLP}]\ncosmetics: []\n",
		"pack":      limitsYAML + "currency: {id: premium}\npacks: [{id: p, amount: 0, price: 1, currency: CLP}]\ncosmetics: []\n",
		"no limits": "currency: {id: premium}\npacks: []\ncosmetics: []\n",
		"limit":     "limits: {daily_premium: 0, equip_burst: 5, equip_refill_ms: 500, max_premium_grant: 1}\ncurrency: {id: premium}\npacks: []\ncosmetics: []\n",
		"refill":    "limits: {daily_premium: 10, equip_burst: 5, equip_refill_ms: 1, max_premium_grant: 1}\ncurrency: {id: premium}\npacks: []\ncosmetics: []\n",
		"over daily": "limits: {daily_premium: 500, equip_burst: 5, equip_refill_ms: 500, max_premium_grant: 1}\n" +
			"currency: {id: premium}\npacks: [{id: p, amount: 501, price: 1, currency: CLP}]\ncosmetics: []\n",
	}
	for name, body := range cases {
		dir := t.TempDir()
		path := filepath.Join(dir, "cosmetics.yaml")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "outfits.yaml"), []byte("- {id: citizen}\n- {id: sailor}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadCosmeticsFile(path); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if s, err := LoadCosmeticsFile(filepath.Join(t.TempDir(), "none.yaml")); s != nil || err != nil {
		t.Fatalf("missing file: %v %v", s, err)
	}
	// An outfit needs outfits.yaml next to the catalog.
	dir := t.TempDir()
	path := filepath.Join(dir, "cosmetics.yaml")
	ok := limitsYAML + "currency: {id: premium}\npacks: []\ncosmetics: [{id: a, kind: outfit, price: 1, outfit: sailor}]\n"
	if err := os.WriteFile(path, []byte(ok), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCosmeticsFile(path); err == nil {
		t.Error("outfit without outfits.yaml accepted")
	}
	if err := os.WriteFile(filepath.Join(dir, "outfits.yaml"), []byte("- {id: citizen}\n- {id: sailor}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s, err := LoadCosmeticsFile(path); err != nil || s.Limits.DailyPremium != 5000 || s.Limits.EquipBurst != 5 {
		t.Fatalf("valid catalog: %+v %v", s, err)
	}
}

func TestCosmeticPackNames(t *testing.T) {
	s, err := LoadCosmetics(filepath.Join("..", "..", "..", "data"))
	if err != nil || s == nil {
		t.Fatalf("load: %v", err)
	}
	if got := s.PackName("es", "pack_small"); got != "pack_small" {
		t.Fatalf("without texts %q", got)
	}
	if err := s.LoadTexts(filepath.Join("..", "..", "..", "i18n")); err != nil {
		t.Fatal(err)
	}
	es, en := s.PackName("es", "pack_small"), s.PackName("en", "pack_small")
	if es == "" || es == "pack_small" || en == "" || en == es {
		t.Fatalf("names es %q en %q", es, en)
	}
	if got := s.PackName("fr", "pack_small"); got != es {
		t.Fatalf("unknown language %q, want the Spanish %q", got, es)
	}
	// A pack without its Spanish name is refused.
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "es"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "es", "cosmetics.yaml"), []byte("premium.name: x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.LoadTexts(dir); err == nil {
		t.Fatal("missing pack name accepted")
	}
}
