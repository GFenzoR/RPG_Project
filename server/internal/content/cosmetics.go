package content

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"go.yaml.in/yaml/v3"
)

// Cosmetic kinds (data/cosmetics.yaml kind, the cosmetics.kind CHECK of migration 00004;
// "mount" is reserved there and not sold yet).
const (
	CosmeticOutfit     = "outfit"
	CosmeticColor      = "outfit_color"
	CosmeticNameEffect = "name_effect"
)

// CosmeticKinds are the kinds a player can equip, in protocol order (Cosmetics fields).
var CosmeticKinds = []string{CosmeticOutfit, CosmeticColor, CosmeticNameEffect}

// Cosmetic is a look bought with premium currency (T5.7, docs/02 "Tienda cosmética").
// Nothing here is read by a game rule: it only changes what clients draw.
type Cosmetic struct {
	ID   string `yaml:"id"`
	Kind string `yaml:"kind"`
	// Price is in premium currency.
	Price int64 `yaml:"price"`
	// Outfit (kind outfit) is the look id in data/outfits.yaml.
	Outfit string `yaml:"outfit"`
	// Tint (kind outfit_color) is "#rrggbb".
	Tint string `yaml:"tint"`
	// Style (kind name_effect) is the name label style the client draws.
	Style string `yaml:"style"`
	Notes string `yaml:"notes"`
}

// PremiumPack is premium currency sold for real money through the payment provider.
type PremiumPack struct {
	ID string `yaml:"id"`
	// Amount is the premium currency credited when the payment is confirmed.
	Amount int64 `yaml:"amount"`
	// Price is the real price in the minor unit of Currency (ISO 4217 exponent: CLP has
	// none, so 1990 = $1.990; USD 499 = $4.99). It is what the provider must confirm.
	Price    int64  `yaml:"price"`
	Currency string `yaml:"currency"`
	Notes    string `yaml:"notes"`
}

// ShopLimits are the shop's bounds (data/cosmetics.yaml limits, docs/02 "Tienda cosmética").
type ShopLimits struct {
	// DailyPremium is the most premium currency one account may buy with money in any
	// 24 hours. A checkout that would go over it is refused before the player pays; a
	// payment that arrives anyway (two checkouts paid together) is still credited.
	DailyPremium int64 `yaml:"daily_premium"`
	// EquipBurst and EquipRefillMs are the equip anti-flood (every change is broadcast
	// to the watchers): a burst of EquipBurst changes, then one every EquipRefillMs.
	EquipBurst    int `yaml:"equip_burst"`
	EquipRefillMs int `yaml:"equip_refill_ms"`
	// MaxPremiumGrant bounds one staff /premium change (either sign).
	MaxPremiumGrant int64 `yaml:"max_premium_grant"`
}

// DefaultOutfit is the free look of every new character (data/outfits.yaml): never sold.
const DefaultOutfit = "citizen"

// CosmeticShop is data/cosmetics.yaml: the premium currency's packs and the cosmetic catalog.
type CosmeticShop struct {
	Currency struct {
		ID string `yaml:"id"`
	} `yaml:"currency"`
	Limits    ShopLimits     `yaml:"limits"`
	Packs     []*PremiumPack `yaml:"packs"`
	Cosmetics []*Cosmetic    `yaml:"cosmetics"`

	packByID map[string]*PremiumPack
	cosByID  map[string]*Cosmetic
	// packNames: lang → pack id → cosmetic_pack.<id>.name (LoadTexts).
	packNames map[string]map[string]string
}

// DefaultTextLang is the language of the texts the server shows when the request's is
// unknown (like the account emails).
const DefaultTextLang = "es"

// LoadTexts reads cosmetic_pack.<id>.name of every pack from i18n/<lang>/cosmetics.yaml
// for every language directory of i18nDir (the server shows it on the provider's
// checkout page). Every pack needs its name in DefaultTextLang.
func (s *CosmeticShop) LoadTexts(i18nDir string) error {
	entries, err := os.ReadDir(i18nDir)
	if err != nil {
		return fmt.Errorf("cosmetics texts: %w", err)
	}
	names := map[string]map[string]string{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(i18nDir, e.Name(), "cosmetics.yaml"))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("cosmetics texts: %w", err)
		}
		texts := map[string]string{}
		if err := yaml.Unmarshal(raw, &texts); err != nil {
			return fmt.Errorf("cosmetics texts %s: %w", e.Name(), err)
		}
		m := map[string]string{}
		for _, p := range s.Packs {
			if n := texts["cosmetic_pack."+p.ID+".name"]; n != "" {
				m[p.ID] = n
			}
		}
		names[e.Name()] = m
	}
	for _, p := range s.Packs {
		if names[DefaultTextLang][p.ID] == "" {
			return fmt.Errorf("cosmetics texts: missing cosmetic_pack.%s.name in %s/cosmetics.yaml", p.ID, DefaultTextLang)
		}
	}
	s.packNames = names
	return nil
}

// PackName is the name of pack id in lang (DefaultTextLang if lang has none; the id
// without LoadTexts).
func (s *CosmeticShop) PackName(lang, id string) string {
	if n := s.packNames[lang][id]; n != "" {
		return n
	}
	if n := s.packNames[DefaultTextLang][id]; n != "" {
		return n
	}
	return id
}

// Pack returns the pack with id, or nil.
func (s *CosmeticShop) Pack(id string) *PremiumPack {
	if s == nil {
		return nil
	}
	return s.packByID[id]
}

// Cosmetic returns the cosmetic with id, or nil.
func (s *CosmeticShop) Cosmetic(id string) *Cosmetic {
	if s == nil {
		return nil
	}
	return s.cosByID[id]
}

// CosmeticIDs returns every cosmetic id, sorted.
func (s *CosmeticShop) CosmeticIDs() []string {
	if s == nil {
		return nil
	}
	out := make([]string, 0, len(s.cosByID))
	for id := range s.cosByID {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

var (
	contentID = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	tintRe    = regexp.MustCompile(`^#[0-9a-f]{6}$`)
	currRe    = regexp.MustCompile(`^[A-Z]{3}$`)
)

// nameStyles are the name_effect styles the client draws (the schema's enum).
var nameStyles = map[string]bool{"gold": true, "ember": true, "frost": true}

// MaxCosmeticPrice bounds prices and pack amounts (the schema's maximum).
const MaxCosmeticPrice = 100000

// Index validates the shop and builds its lookups. LoadCosmetics calls it; tests that build a
// CosmeticShop in code call it too.
func (s *CosmeticShop) Index() error {
	if s.Currency.ID != "premium" {
		return errors.New("cosmetics: currency.id must be premium")
	}
	l := s.Limits
	if l.DailyPremium < 1 || l.DailyPremium > 10*MaxCosmeticPrice || l.EquipBurst < 1 || l.EquipBurst > 100 ||
		l.EquipRefillMs < 50 || l.EquipRefillMs > 60_000 || l.MaxPremiumGrant < 1 || l.MaxPremiumGrant > 10*MaxCosmeticPrice {
		return fmt.Errorf("cosmetics: limits: daily_premium and max_premium_grant in 1..%d, equip_burst in 1..100, equip_refill_ms in 50..60000",
			10*MaxCosmeticPrice)
	}
	s.packByID = make(map[string]*PremiumPack, len(s.Packs))
	s.cosByID = make(map[string]*Cosmetic, len(s.Cosmetics))
	for _, p := range s.Packs {
		switch {
		case p == nil || !contentID.MatchString(p.ID) || s.packByID[p.ID] != nil:
			return fmt.Errorf("cosmetics: pack: missing, invalid or duplicate id")
		case p.Amount < 1 || p.Amount > MaxCosmeticPrice || p.Price < 1 || p.Price > 100_000_000 || !currRe.MatchString(p.Currency):
			return fmt.Errorf("cosmetics: pack %s: amount in 1..%d, price in 1..1e8 and an ISO 4217 currency", p.ID, MaxCosmeticPrice)
		case p.Amount > l.DailyPremium:
			return fmt.Errorf("cosmetics: pack %s: amount %d is over limits.daily_premium %d (it could never be bought)",
				p.ID, p.Amount, l.DailyPremium)
		}
		s.packByID[p.ID] = p
	}
	for _, c := range s.Cosmetics {
		if c == nil || !contentID.MatchString(c.ID) || s.cosByID[c.ID] != nil {
			return fmt.Errorf("cosmetics: missing, invalid or duplicate cosmetic id")
		}
		if c.Price < 1 || c.Price > MaxCosmeticPrice {
			return fmt.Errorf("cosmetics: %s: price in 1..%d", c.ID, MaxCosmeticPrice)
		}
		switch c.Kind {
		case CosmeticOutfit:
			if !contentID.MatchString(c.Outfit) {
				return fmt.Errorf("cosmetics: %s: an outfit needs outfit (data/outfits.yaml id)", c.ID)
			}
			if c.Outfit == DefaultOutfit {
				return fmt.Errorf("cosmetics: %s: %s is the free default look, it cannot be sold", c.ID, DefaultOutfit)
			}
		case CosmeticColor:
			if !tintRe.MatchString(c.Tint) {
				return fmt.Errorf("cosmetics: %s: an outfit_color needs tint #rrggbb", c.ID)
			}
		case CosmeticNameEffect:
			if !nameStyles[c.Style] {
				return fmt.Errorf("cosmetics: %s: unknown name_effect style %q", c.ID, c.Style)
			}
		default:
			return fmt.Errorf("cosmetics: %s: unknown kind %q", c.ID, c.Kind)
		}
		s.cosByID[c.ID] = c
	}
	return nil
}

// CheckOutfits fails if an outfit cosmetic names a look that is not in outfits (the ids
// of data/outfits.yaml).
func (s *CosmeticShop) CheckOutfits(outfits []string) error {
	known := make(map[string]bool, len(outfits))
	for _, id := range outfits {
		known[id] = true
	}
	for _, c := range s.Cosmetics {
		if c.Kind == CosmeticOutfit && !known[c.Outfit] {
			return fmt.Errorf("cosmetics: %s: unknown outfit %q in data/outfits.yaml", c.ID, c.Outfit)
		}
	}
	return nil
}

// LoadCosmetics reads <dataDir>/cosmetics.yaml. No file means no shop (nil, nil).
func LoadCosmetics(dataDir string) (*CosmeticShop, error) {
	return LoadCosmeticsFile(filepath.Join(dataDir, "cosmetics.yaml"))
}

// LoadCosmeticsFile reads a cosmetics file; a missing file is (nil, nil). Its outfits are
// checked against outfits.yaml in the same directory (required when one is sold).
func LoadCosmeticsFile(path string) (*CosmeticShop, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read cosmetics: %w", err)
	}
	var s CosmeticShop
	if err := yaml.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("decode cosmetics: %w", err)
	}
	if err := s.Index(); err != nil {
		return nil, err
	}
	outfits, err := loadOutfitIDs(filepath.Join(filepath.Dir(path), "outfits.yaml"))
	if err != nil {
		return nil, err
	}
	if err := s.CheckOutfits(outfits); err != nil {
		return nil, err
	}
	return &s, nil
}

// loadOutfitIDs reads the ids of an outfits file (none if it does not exist).
func loadOutfitIDs(path string) ([]string, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read outfits: %w", err)
	}
	var list []struct {
		ID string `yaml:"id"`
	}
	if err := yaml.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("decode outfits: %w", err)
	}
	ids := make([]string, len(list))
	for i, o := range list {
		ids[i] = o.ID
	}
	return ids, nil
}
