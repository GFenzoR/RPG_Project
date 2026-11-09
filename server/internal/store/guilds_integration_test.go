//go:build integration

package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// Guild changes as the loop writes them, what LoadGuilds reads back, the public pages,
// and the safety net: one guild per character, one leader per guild and names unique
// ignoring case, also under concurrent writes (T5.1).
func TestGuilds(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_guilds"
	st := storetest.Open(t, schema, true)
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

	acc, err := st.CreateAccount(ctx, "guilds@example.org", "h")
	if err != nil {
		t.Fatal(err)
	}
	char := func(name string) int64 {
		t.Helper()
		c, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: name, Vocation: "guardian", Health: 1}, 20)
		if err != nil {
			t.Fatal(err)
		}
		return c.ID
	}
	ana, bea, ciro, dora := char("Ana"), char("Bea"), char("Ciro"), char("Dora")
	apply := func(c store.GuildChange) error {
		t.Helper()
		c.At = now
		return st.ApplyGuild(ctx, c, nil)
	}
	must := func(c store.GuildChange) {
		t.Helper()
		if err := apply(c); err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
	}

	// An invitation to a missing guild breaks a foreign key: permanent.
	if err := apply(store.GuildChange{Op: store.GuildInvite, GuildID: 99, CharacterID: bea, Expires: now.Add(time.Hour)}); !store.Permanent(err) {
		t.Fatalf("invite to a missing guild: %v", err)
	}
	must(store.GuildChange{Op: store.GuildCreate, GuildID: 1, CharacterID: ana, Name: "Salt Lanterns"})
	must(store.GuildChange{Op: store.GuildInvite, GuildID: 1, CharacterID: bea, InvitedBy: ana, Expires: now.Add(time.Hour)})
	must(store.GuildChange{Op: store.GuildInvite, GuildID: 1, CharacterID: ciro, InvitedBy: ana, Expires: now.Add(-time.Minute)})
	must(store.GuildChange{Op: store.GuildJoin, GuildID: 1, CharacterID: bea, Rank: store.GuildRankMember})
	must(store.GuildChange{Op: store.GuildMotd, GuildID: 1, Text: "dock at dawn"})
	must(store.GuildChange{Op: store.GuildRank, GuildID: 1, CharacterID: bea, Rank: store.GuildRankVice})
	must(store.GuildChange{Op: store.GuildTransfer, GuildID: 1, CharacterID: ana, OtherID: bea, Rank: store.GuildRankVice})

	// Names are unique ignoring case; a character is in one guild at most.
	if err := apply(store.GuildChange{Op: store.GuildCreate, GuildID: 2, CharacterID: dora, Name: "SALT LANTERNS"}); !errors.Is(err, store.ErrGuildConflict) {
		t.Fatalf("duplicate name: %v", err)
	}
	if err := apply(store.GuildChange{Op: store.GuildCreate, GuildID: 2, CharacterID: ana, Name: "Other"}); !errors.Is(err, store.ErrGuildConflict) {
		t.Fatalf("a member founded a second guild: %v", err)
	}
	// One leader per guild.
	if err := apply(store.GuildChange{Op: store.GuildRank, GuildID: 1, CharacterID: ana, Rank: store.GuildRankLeader}); !store.Permanent(err) {
		t.Fatalf("two leaders: %v", err)
	}

	rows, err := st.LoadGuilds(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows.Guilds) != 1 || rows.Guilds[0].Name != "Salt Lanterns" || rows.Guilds[0].Motd != "dock at dawn" {
		t.Fatalf("guilds %+v", rows.Guilds)
	}
	if len(rows.Members) != 2 || rows.Members[0].CharacterID != bea || rows.Members[0].Rank != store.GuildRankLeader ||
		rows.Members[1].CharacterID != ana || rows.Members[1].Rank != store.GuildRankVice || rows.Members[1].Name != "Ana" {
		t.Fatalf("members %+v", rows.Members)
	}
	// Bea's invitation went with her joining; Ciro's expired and was deleted.
	if len(rows.Invites) != 0 {
		t.Fatalf("invites %+v", rows.Invites)
	}

	list, err := st.PublicGuilds(ctx, 10)
	if err != nil || len(list) != 1 || list[0].Leader != "Bea" || list[0].Members != 2 {
		t.Fatalf("PublicGuilds = %+v, %v", list, err)
	}
	page, err := st.PublicGuild(ctx, 1)
	if err != nil || len(page.Members) != 2 || page.Members[0].Name != "Bea" || page.Members[0].Rank != store.GuildRankLeader {
		t.Fatalf("PublicGuild = %+v, %v", page, err)
	}
	if _, err := st.PublicGuild(ctx, 42); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing guild: %v", err)
	}

	// Concurrency: two guilds try to take Dora at once (and two foundings the same name):
	// exactly one of each wins.
	must(store.GuildChange{Op: store.GuildCreate, GuildID: 2, CharacterID: ciro, Name: "Iron Wake"})
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i, c := range []store.GuildChange{
		{Op: store.GuildJoin, GuildID: 1, CharacterID: dora, Rank: store.GuildRankMember},
		{Op: store.GuildJoin, GuildID: 2, CharacterID: dora, Rank: store.GuildRankMember},
	} {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = apply(c) }()
	}
	eve, finn := char("Eve"), char("Finn")
	for i, c := range []store.GuildChange{
		{Op: store.GuildCreate, GuildID: 3, CharacterID: eve, Name: "Twin Name"},
		{Op: store.GuildCreate, GuildID: 4, CharacterID: finn, Name: "twin name"},
	} {
		wg.Add(1)
		go func() { defer wg.Done(); errs[2+i] = apply(c) }()
	}
	wg.Wait()
	for _, pair := range [][2]error{{errs[0], errs[1]}, {errs[2], errs[3]}} {
		if (pair[0] == nil) == (pair[1] == nil) {
			t.Fatalf("concurrent writes: %v / %v (exactly one must win)", pair[0], pair[1])
		}
		for _, e := range pair {
			if e != nil && !errors.Is(e, store.ErrGuildConflict) {
				t.Fatalf("loser error %v", e)
			}
		}
	}

	// Disbanding deletes members and invitations with the guild.
	must(store.GuildChange{Op: store.GuildInvite, GuildID: 2, CharacterID: eve, Expires: now.Add(time.Hour)})
	must(store.GuildChange{Op: store.GuildDisband, GuildID: 2})
	rows, err = st.LoadGuilds(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range rows.Members {
		if m.GuildID == 2 {
			t.Fatalf("member of a disbanded guild %+v", m)
		}
	}
	for _, i := range rows.Invites {
		if i.GuildID == 2 {
			t.Fatalf("invitation of a disbanded guild %+v", i)
		}
	}
	// A renamed guild keeps its members.
	must(store.GuildChange{Op: store.GuildRename, GuildID: 1, Name: "Fine Name"})
	if p, _ := st.PublicGuild(ctx, 1); p.Name != "Fine Name" || len(p.Members) < 2 {
		t.Fatalf("renamed %+v", p)
	}
}
