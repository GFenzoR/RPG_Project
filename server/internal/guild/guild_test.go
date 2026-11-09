package guild_test

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/guild"
)

func rules() content.Guild {
	return content.Guild{NameMin: 3, NameMax: 24, NameMaxWords: 4,
		ReservedParts: []string{"admin", "staff", "mierda"}, ReservedWords: []string{"gm", "mod"}}
}

func TestValidName(t *testing.T) {
	cases := map[string]guild.NameError{
		"Lanterns":                      guild.NameOK,
		"Order of the Salt":             guild.NameOK,
		"Ab":                            guild.NameLength,
		"A Very Long Guild Name Indeed": guild.NameLength,
		"lowercase":                     guild.NameChars,
		"Two  Spaces":                   guild.NameChars,
		"Digits9":                       guild.NameChars,
		"Ñandú Riders":                  guild.NameChars,
		"One Two Three Four Five":       guild.NameChars,
		"Solo X":                        guild.NameChars,
		"The Admins":                    guild.NameReserved,
		"Sta Ff Club":                   guild.NameReserved, // spaces removed
		"Gm Squad":                      guild.NameReserved,
		"Gmork Riders":                  guild.NameOK, // a reserved word only as a whole word
		"Mod Squad":                     guild.NameReserved,
	}
	for name, want := range cases {
		if got := guild.ValidName(rules(), name); got != want {
			t.Errorf("ValidName(%q) = %q, want %q", name, got, want)
		}
	}
	if got := guild.CleanName("  Order   of  Salt "); got != "Order of Salt" {
		t.Errorf("CleanName = %q", got)
	}
}

func TestCan(t *testing.T) {
	L, V, M := guild.Leader, guild.Vice, guild.Member
	cases := []struct {
		actor  guild.Rank
		a      guild.Action
		target guild.Rank
		want   bool
	}{
		{L, guild.Invite, 0, true}, {V, guild.Invite, 0, true}, {M, guild.Invite, 0, false},
		{L, guild.SetMotd, 0, true}, {V, guild.SetMotd, 0, true}, {M, guild.SetMotd, 0, false},
		{L, guild.Revoke, 0, true}, {M, guild.Revoke, 0, false},
		{L, guild.Kick, V, true}, {L, guild.Kick, M, true}, {L, guild.Kick, L, false},
		{V, guild.Kick, M, true}, {V, guild.Kick, V, false}, {V, guild.Kick, L, false}, {M, guild.Kick, M, false},
		{L, guild.Promote, M, true}, {L, guild.Promote, V, false}, {V, guild.Promote, M, false},
		{L, guild.Demote, V, true}, {L, guild.Demote, M, false}, {V, guild.Demote, V, false},
		{L, guild.Transfer, V, true}, {L, guild.Transfer, M, true}, {V, guild.Transfer, M, false},
		{L, guild.Disband, 0, true}, {V, guild.Disband, 0, false},
	}
	for _, c := range cases {
		if got := guild.Can(c.actor, c.a, c.target); got != c.want {
			t.Errorf("Can(%v, %d, %v) = %v, want %v", c.actor, c.a, c.target, got, c.want)
		}
	}
}
