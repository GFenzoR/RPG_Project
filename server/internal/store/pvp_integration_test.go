//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// PvP (T5.2): a snapshot's skull, kill counter and unjustified kills come back on the
// next login; guild wars go through their states and LoadGuilds reads the open ones;
// the safety net refuses a second open war between two guilds.
func TestPvPState(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_pvp"
	st := storetest.Open(t, schema, true)
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

	acc, err := st.CreateAccount(ctx, "pvp@example.org", "h")
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
	ana, bea := char("Ana"), char("Bea")

	until := now.Add(60 * time.Hour)
	kills := []time.Time{now.Add(-200 * 24 * time.Hour), now.Add(-time.Hour), now.Add(-time.Minute)}
	save := func(s store.PvPState) {
		t.Helper()
		if err := st.SaveCharacterState(ctx, store.CharacterState{ID: ana, Level: 30, Health: 1, X: 1, Y: 1, Z: 7, PvP: s,
			SavedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	save(store.PvPState{Skull: 2, SkullUntil: until, Kills: 7, Unjust: kills})
	pc, err := st.PlayCharacter(ctx, acc, ana, now)
	if err != nil {
		t.Fatal(err)
	}
	// Kills older than the longest window a balance can have are not read.
	if p := pc.PvP; p.Skull != 2 || !p.SkullUntil.Equal(until) || p.Kills != 7 || len(p.Unjust) != 2 ||
		!p.Unjust[0].Equal(kills[1]) || !p.Unjust[1].Equal(kills[2]) {
		t.Fatalf("loaded %+v", p)
	}
	save(store.PvPState{})
	if pc, err = st.PlayCharacter(ctx, acc, ana, now); err != nil || pc.PvP.Skull != 0 || !pc.PvP.SkullUntil.IsZero() ||
		len(pc.PvP.Unjust) != 0 {
		t.Fatalf("cleared: %+v %v", pc.PvP, err)
	}
	if err := st.SaveCharacterState(ctx, store.CharacterState{ID: ana, Level: 30, Health: 1, PvP: store.PvPState{Skull: 9},
		SavedAt: now}); !store.Permanent(err) {
		t.Fatalf("skull 9: %v", err)
	}

	// Guild wars.
	apply := func(c store.GuildChange) error {
		t.Helper()
		if c.At.IsZero() {
			c.At = now
		}
		return st.ApplyGuild(ctx, c, nil)
	}
	must := func(c store.GuildChange) {
		t.Helper()
		if err := apply(c); err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
	}
	must(store.GuildChange{Op: store.GuildCreate, GuildID: 1, CharacterID: ana, Name: "Alpha"})
	must(store.GuildChange{Op: store.GuildCreate, GuildID: 2, CharacterID: bea, Name: "Beta"})
	must(store.GuildChange{Op: store.GuildWarDeclare, WarID: 1, GuildID: 1, EnemyID: 2, Expires: now.Add(time.Hour), KillLimit: 30})
	// One open war per pair, whoever declares it.
	if err := apply(store.GuildChange{Op: store.GuildWarDeclare, WarID: 2, GuildID: 2, EnemyID: 1, Expires: now.Add(time.Hour),
		KillLimit: 30}); !errors.Is(err, store.ErrGuildConflict) {
		t.Fatalf("a second open war: %v", err)
	}
	must(store.GuildChange{Op: store.GuildWarStart, WarID: 1, GuildID: 1, Expires: now.Add(96 * time.Hour)})
	must(store.GuildChange{Op: store.GuildWarKills, WarID: 1, GuildID: 1, Kills: 3, EnemyKills: 1})
	rows, err := st.LoadGuilds(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if rows.WarIDHigh != 1 || len(rows.Wars) != 1 {
		t.Fatalf("wars %+v, high %d", rows.Wars, rows.WarIDHigh)
	}
	if w := rows.Wars[0]; !w.Active || w.GuildID != 1 || w.EnemyID != 2 || w.Kills != 3 || w.EnemyKills != 1 ||
		w.KillLimit != 30 || !w.Expires.Equal(now.Add(96*time.Hour)) {
		t.Fatalf("war %+v", w)
	}
	must(store.GuildChange{Op: store.GuildWarEnd, WarID: 1, GuildID: 1, Reason: store.WarEndSurrender, WinnerID: 1})
	if err := apply(store.GuildChange{Op: store.GuildWarEnd, WarID: 1, Reason: 42}); !errors.Is(err, store.ErrGuildConflict) {
		t.Fatalf("bad reason: %v", err)
	}
	// Ended: a new war between them may start; ids keep growing after a restart.
	must(store.GuildChange{Op: store.GuildWarDeclare, WarID: 2, GuildID: 2, EnemyID: 1, Expires: now.Add(time.Hour), KillLimit: 30})
	if rows, err = st.LoadGuilds(ctx, now); err != nil || rows.WarIDHigh != 2 || len(rows.Wars) != 1 || rows.Wars[0].Active {
		t.Fatalf("after the end: %+v %v", rows, err)
	}
	// Disbanding a guild deletes its wars with it.
	must(store.GuildChange{Op: store.GuildDisband, GuildID: 2})
	if rows, err = st.LoadGuilds(ctx, now); err != nil || len(rows.Wars) != 0 || rows.WarIDHigh != 2 {
		t.Fatalf("after disbanding: %+v %v", rows, err)
	}
}
