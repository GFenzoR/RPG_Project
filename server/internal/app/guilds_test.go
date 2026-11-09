package app

import (
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/guild"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// The loop's guild changes and the store's ops are the same numbers (T5.1).
func TestGuildOpsMatch(t *testing.T) {
	pairs := map[session.GuildOp]store.GuildOp{
		session.GuildCreate: store.GuildCreate, session.GuildRename: store.GuildRename, session.GuildMotd: store.GuildMotd,
		session.GuildDisband: store.GuildDisband, session.GuildJoin: store.GuildJoin, session.GuildRemove: store.GuildRemove,
		session.GuildRank: store.GuildRank, session.GuildTransfer: store.GuildTransfer, session.GuildInvite: store.GuildInvite,
		session.GuildUninvite: store.GuildUninvite,
	}
	for s, st := range pairs {
		if got := guildChange(session.GuildChange{Op: s}).Op; got != st {
			t.Errorf("session op %d → store op %d, want %d", s, got, st)
		}
	}
	if store.GuildRankLeader != int(guild.Leader) || store.GuildRankVice != int(guild.Vice) || store.GuildRankMember != int(guild.Member) {
		t.Error("store ranks differ from guild.Rank")
	}
}

// What the store loads becomes the World's guilds, members and invitations by guild.
func TestGuildData(t *testing.T) {
	now := time.Unix(100, 0)
	d := guildData(store.GuildRows{
		Guilds:  []store.GuildRow{{ID: 2, Name: "A"}, {ID: 5, Name: "B", Motd: "m"}},
		Members: []store.GuildMemberRow{{GuildID: 5, CharacterID: 9, Name: "Ana", Rank: 3}, {GuildID: 7, CharacterID: 1}},
		Invites: []store.GuildInviteRow{{GuildID: 2, CharacterID: 4, Name: "Bea", Expires: now}},
	})
	if len(d.Guilds) != 2 || d.Guilds[1].Motd != "m" || len(d.Guilds[1].Members) != 1 ||
		d.Guilds[1].Members[0].Rank != guild.Leader || len(d.Guilds[0].Invites) != 1 || !d.Guilds[0].Invites[0].Expires.Equal(now) {
		t.Fatalf("guildData = %+v", d)
	}
}
