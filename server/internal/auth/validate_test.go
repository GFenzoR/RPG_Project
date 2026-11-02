package auth

import (
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
		"Mira":                  true,
		"Old Tom":               true,
		"Ana Del Mar":           true,
		"Al":                    false, // too short
		"mira":                  false, // lowercase first letter
		"MIRA":                  false,
		"Mi  Ra":                false, // double space
		" Mira":                 false,
		"Mira ":                 false,
		"Ana De La Mar":         false, // 4 words
		"Mira1":                 false,
		"Ñandú":                 false, // ASCII only
		"Mira O":                false, // one-letter word
		"Gm Mira":               false, // reserved whole word
		"Mira Admin":            false,
		"Admin Bob":             false,
		"Gamemaster Bob":        false, // reserved substrings
		"Game Master Bob":       false, // spaces do not hide them
		"Soporte":               false,
		"Support Team":          false,
		"Staff":                 false,
		"Moderador":             false,
		"Moderator Ann":         false,
		"Sistema":               false,
		"The System":            false,
		"Tutor Ana":             false,
		"Cm Lia":                false,
		"Gmork":                 true, // "gm" only as a whole word
		"Godric":                true, // "god" only as a whole word
		"Modesto":               true,
		"Abcdefghijklmnopqrstu": false, // 21 chars
		"Abcdefghijklmnopqrst":  true,  // 20 chars
	}
	for name, want := range cases {
		if got := ValidCharacterName(name); got != want {
			t.Errorf("ValidCharacterName(%q) = %v, want %v", name, got, want)
		}
	}
}
