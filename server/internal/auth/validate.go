package auth

import (
	"net/mail"
	"strings"
	"unicode"
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
func ValidCharacterName(name string) bool { return CharacterNameError(name) == nil }

// CharacterNameError says why name breaks the naming rules: ErrReservedName when it has a
// reserved word or part, whatever its capitals ("GM Tester"), else ErrInvalidName when it
// breaks the rest of them (ValidCharacterName); nil for a valid name.
func CharacterNameError(name string) error {
	if len(name) < MinNameLen || len(name) > MaxNameLen {
		return ErrInvalidName
	}
	words := strings.Split(name, " ")
	joined := strings.ToLower(strings.Join(words, ""))
	for _, part := range reservedNameParts {
		if strings.Contains(joined, part) {
			return ErrReservedName
		}
	}
	for _, w := range words {
		if reservedNameWords[strings.ToLower(w)] {
			return ErrReservedName
		}
	}
	if len(words) > maxNameWords {
		return ErrInvalidName
	}
	for _, w := range words {
		if len(w) < 2 || w[0] < 'A' || w[0] > 'Z' {
			return ErrInvalidName
		}
		for i := 1; i < len(w); i++ {
			if w[i] < 'a' || w[i] > 'z' {
				return ErrInvalidName
			}
		}
	}
	return nil
}

// nameKey is the form reserved names are compared in: lowercased, without spaces, so
// "Maren Holt", "maren holt" and "MarenHolt" are one name.
func nameKey(name string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(name), " ", ""))
}

// NPCReservedNames turns NPC display names ("Maren Holt, jefa del puerto", "Sister
// Liora", "Gisla the tanner") into the names a character may not take: the name before
// a comma ("Maren Holt") and each of its capitalized words of at least MinNameLen
// letters ("Maren", "Holt"; "Sister", "Liora"; "Gisla"). A player cannot then pose as
// an NPC, in any language its name is shown in.
func NPCReservedNames(displayNames []string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(n string) {
		if k := nameKey(n); k != "" && !seen[k] {
			seen[k] = true
			out = append(out, n)
		}
	}
	for _, d := range displayNames {
		name, _, _ := strings.Cut(d, ",")
		name = strings.TrimSpace(name)
		add(name)
		for _, w := range strings.Fields(name) {
			if r, _ := utf8.DecodeRuneInString(w); unicode.IsUpper(r) && utf8.RuneCountInString(w) >= MinNameLen {
				add(w)
			}
		}
	}
	return out
}
