// Package guild holds the pure rules of guilds (T5.1, docs/02-game-design.md
// "Gremios"): ranks, what each rank may do, and the name rules. The guilds themselves
// live in the game loop (session/guild.go) and in Postgres (store/guilds.go).
package guild

import (
	"strings"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// Rank is a member's rank. The values are stored in guild_members.rank.
type Rank uint8

// Ranks, from lowest to highest.
const (
	Member Rank = 1
	Vice   Rank = 2
	Leader Rank = 3
)

// Valid reports whether r is a known rank.
func (r Rank) Valid() bool { return r >= Member && r <= Leader }

// String is the rank's id ("member", "vice", "leader"): the i18n key suffix and the
// public API value.
func (r Rank) String() string {
	switch r {
	case Leader:
		return "leader"
	case Vice:
		return "vice"
	default:
		return "member"
	}
}

// Action is something a member does to the guild or to another member.
type Action uint8

// Actions that need a rank. Leaving needs none (but the leader must transfer or
// disband first).
const (
	Invite Action = iota + 1
	Kick
	Promote
	Demote
	SetMotd
	Disband
	Transfer
	Revoke // withdraw a pending invitation
)

// Can reports whether a member of rank actor may do a to a member of rank target
// (target is ignored by actions on the guild: Invite, SetMotd, Disband, Revoke).
//
//   - leader: everything.
//   - vice: invite and revoke invitations, kick members (not other vices), set the
//     message of the day.
//   - member: nothing but leave.
func Can(actor Rank, a Action, target Rank) bool {
	switch a {
	case Invite, Revoke, SetMotd:
		return actor >= Vice
	case Kick:
		return actor == Leader && target < Leader || actor == Vice && target == Member
	case Promote:
		return actor == Leader && target == Member
	case Demote:
		return actor == Leader && target == Vice
	case Transfer:
		return actor == Leader && target != Leader && target.Valid()
	case Disband:
		return actor == Leader
	}
	return false
}

// NameError is why a name is refused; its value is the suffix of the i18n key
// guild.name_<code>.
type NameError string

// Name errors.
const (
	NameOK       NameError = ""
	NameLength   NameError = "length"
	NameChars    NameError = "chars"
	NameReserved NameError = "reserved"
)

// CleanName collapses runs of spaces and trims the ends: what a player typed, before
// ValidName.
func CleanName(s string) string { return strings.Join(strings.Fields(s), " ") }

// ValidName checks a cleaned name against the rules of g: name_min..name_max
// characters, 1..name_max_words words of ASCII letters (at least two letters each)
// separated by single spaces, the first word capitalized, and no reserved part or
// word. ASCII only avoids look-alike names.
func ValidName(g content.Guild, name string) NameError {
	if len(name) < g.NameMin || len(name) > g.NameMax || len(name) > content.MaxGuildName {
		return NameLength
	}
	words := strings.Split(name, " ")
	if len(words) > g.NameMaxWords {
		return NameChars
	}
	for _, w := range words {
		if len(w) < 2 {
			return NameChars
		}
		for i := 0; i < len(w); i++ {
			c := w[i]
			if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') {
				return NameChars
			}
		}
	}
	if c := name[0]; c < 'A' || c > 'Z' {
		return NameChars
	}
	joined := strings.ToLower(strings.Join(words, ""))
	for _, part := range g.ReservedParts {
		if part != "" && strings.Contains(joined, part) {
			return NameReserved
		}
	}
	for _, w := range words {
		lw := strings.ToLower(w)
		for _, r := range g.ReservedWords {
			if lw == r {
				return NameReserved
			}
		}
	}
	return NameOK
}

// Key is the case-insensitive identity of a name: two guilds whose names differ only in
// case cannot coexist (the database has the same unique index, on lower(name)).
func Key(name string) string { return strings.ToLower(name) }
