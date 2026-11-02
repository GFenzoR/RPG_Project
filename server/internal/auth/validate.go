package auth

import (
	"net/mail"
	"strings"
	"unicode/utf8"
)

// Limits for account and character input.
const (
	MinPasswordLen = 8   // runes
	MaxPasswordLen = 128 // runes; bounds the hashing input
	MaxEmailLen    = 254
	MinNameLen     = 3
	MaxNameLen     = 20
	maxNameWords   = 3
)

// Character names must not pose as staff or the game itself. reservedNameParts are
// matched as substrings of the lowercased name with spaces removed ("Game Master Bob",
// "Admin Bob", "Soporte"); reservedNameWords are too short for that and are matched only
// as whole words ("Gm Bob", but not "Gmork").
var (
	reservedNameParts = []string{
		"admin", "gamemaster", "moderat", "moderad", "soporte", "support",
		"staff", "tutor", "sistema", "system", "official", "oficial",
	}
	reservedNameWords = map[string]bool{"gm": true, "cm": true, "god": true, "mod": true, "dev": true}
)

// NormalizeEmail trims and lowercases an email and reports whether it is a plain valid
// address ("user@example.org", without display name or angle brackets).
func NormalizeEmail(raw string) (string, bool) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if email == "" || len(email) > MaxEmailLen {
		return "", false
	}
	// ASCII only: avoids look-alike (homoglyph) and Unicode-normalization duplicates.
	for i := 0; i < len(email); i++ {
		if email[i] < 0x21 || email[i] > 0x7e {
			return "", false
		}
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Name != "" || addr.Address != email {
		return "", false
	}
	at := strings.LastIndexByte(email, '@')
	if at <= 0 || !strings.Contains(email[at+1:], ".") {
		return "", false
	}
	return email, true
}

// ValidPassword reports whether a password meets the length rules.
func ValidPassword(p string) bool {
	if !utf8.ValidString(p) {
		return false
	}
	n := utf8.RuneCountInString(p)
	return n >= MinPasswordLen && n <= MaxPasswordLen
}

// ValidCharacterName reports whether name follows the naming rules: 3–20 characters,
// 1–3 words of ASCII letters separated by single spaces, each word capitalized
// ("Mira", "Old Tom"), and no reserved word. ASCII only avoids look-alike names.
func ValidCharacterName(name string) bool {
	if len(name) < MinNameLen || len(name) > MaxNameLen {
		return false
	}
	words := strings.Split(name, " ")
	if len(words) > maxNameWords {
		return false
	}
	joined := strings.ToLower(strings.Join(words, ""))
	for _, part := range reservedNameParts {
		if strings.Contains(joined, part) {
			return false
		}
	}
	for _, w := range words {
		if len(w) < 2 || reservedNameWords[strings.ToLower(w)] {
			return false
		}
		if w[0] < 'A' || w[0] > 'Z' {
			return false
		}
		for i := 1; i < len(w); i++ {
			if w[i] < 'a' || w[i] > 'z' {
				return false
			}
		}
	}
	return true
}
