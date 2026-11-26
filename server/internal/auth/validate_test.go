package auth

import (
	"errors"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestNormalizeEmail(t *testing.T) {
	ok := map[string]string{
		"ana@example.org":      "ana@example.org",
		"\tAna@Example.ORG\n":  "ana@example.org",
		"a.b+tag@mail.co.uk":   "a.b+tag@mail.co.uk",
		"x@sub.example.studio": "x@sub.example.studio",
	}
	for in, want := range ok {
		got, valid := NormalizeEmail(in)
		if !valid || got != want {
			t.Errorf("NormalizeEmail(%q) = %q, %v; want %q", in, got, valid, want)
		}
	}
	for _, in := range []string{
		"", "ana", "ana@", "@example.org", "ana@localhost", "Ana <ana@example.org>",
		"<ana@example.org>", "ana@example.org, bob@example.org",
		strings.Repeat("a", 250) + "@example.org",
		"a@\u0435xample.org", // Cyrillic "е"
		"josé@example.org",
	} {
		if got, valid := NormalizeEmail(in); valid {
			t.Errorf("NormalizeEmail(%q) = %q, want invalid", in, got)
		}
	}
}

func TestValidPassword(t *testing.T) {
	cases := map[string]bool{
		"":                          false,
		"1234567":                   false,
		"12345678":                  true,
		"contraseña":                true,
		strings.Repeat("ñ", 128):    true,
		strings.Repeat("a", 129):    false,
		"bad\xffutf8 password long": false,
	}
	for pw, want := range cases {
		if got := ValidPassword(pw); got != want {
			t.Errorf("ValidPassword(%q) = %v, want %v", pw, got, want)
		}
	}
}

func TestValidCharacterName(t *testing.T) {
	cases := map[string]bool{
		"Mira":              true,
		"Old Tom":           true,
		"Ana Del Mar":       true,
		"Al":                false, // too short
		"mira":              false, // lowercase first letter
		"MIRA":              false,
		"Mi  Ra":            false, // double space
		" Mira":             false,
		"Mira ":             false,
		"Ana De La Mar":     false, // 4 words
		"Mira1":             false,
		"Ñandú":             false, // ASCII only
		"Mira O":            false, // one-letter word
		"Gm Mira":           false, // reserved whole word
		"Mira Admin":        false,
		"Admin Bob":         false,
		"Gamemaster Bob":    false, // reserved substrings
		"Game Master Bob":   false, // spaces do not hide them
		"Soporte":           false,
		"Support Team":      false,
		"Staff":             false,
		"Moderador":         false,
		"Moderator Ann":     false,
		"Sistema":           false,
		"The System":        false,
		"Tutor Ana":         false,
		"Cm Lia":            false,
		"Gmork":             true, // "gm" only as a whole word
		"Godric":            true, // "god" only as a whole word
		"Modesto":           true,
		"Abcdefghijklmnopq": false, // 17 chars
		"Abcdefghijklmnop":  true,  // 16 chars
	}
	for name, want := range cases {
		if got := ValidCharacterName(name); got != want {
			t.Errorf("ValidCharacterName(%q) = %v, want %v", name, got, want)
		}
	}
	// Why a name is refused: a reserved word or part has its own error, whatever its
	// capitals (the playtest's "GM Tester" got the rules of a malformed name).
	why := map[string]error{
		"GM Tester":   ErrReservedName,
		"Gm Mira":     ErrReservedName,
		"admin":       ErrReservedName,
		"Game Master": ErrReservedName,
		"Mira":        nil,
		"Gmork":       nil,
		"MIRA":        ErrInvalidName,
		"Al":          ErrInvalidName,
		"Mi  Ra":      ErrInvalidName,
		"Mira1":       ErrInvalidName,
	}
	for name, want := range why {
		if got := CharacterNameError(name); !errors.Is(got, want) || (want == nil) != (got == nil) {
			t.Errorf("CharacterNameError(%q) = %v, want %v", name, got, want)
		}
	}
}

// TestNameBoundMatchesTheLabel keeps the character-name limit equal to the one the client's
// labels and make validate use for every creature name (CREATURE_NAME_MAX_CHARS in
// packages/content-schema/src/npc-role.ts): a name always shows whole on one line.
func TestNameBoundMatchesTheLabel(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/content-schema/src/npc-role.ts")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`CREATURE_NAME_MAX_CHARS = (\d+);`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("CREATURE_NAME_MAX_CHARS not found in npc-role.ts")
	}
	if got, _ := strconv.Atoi(string(m[1])); got != MaxNameLen {
		t.Errorf("CREATURE_NAME_MAX_CHARS = %d, auth.MaxNameLen = %d: they must be equal", got, MaxNameLen)
	}
	// The hints players read say the same number.
	for _, lang := range []string{"es", "en"} {
		yml, err := os.ReadFile("../../../i18n/" + lang + "/client.yaml")
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(yml), "\n") {
			if strings.HasPrefix(line, "error.invalid_name:") && !strings.Contains(line, strconv.Itoa(MaxNameLen)) {
				t.Errorf("%s error.invalid_name does not mention %d: %s", lang, MaxNameLen, line)
			}
		}
	}
	long := strings.Repeat("a", MaxNameLen+1)
	if ValidCharacterName(strings.ToUpper(long[:1]) + long[1:]) {
		t.Errorf("a %d-letter name must be refused", MaxNameLen+1)
	}
}
