package auth_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// countingRepo counts the session lookups and deletions that reach the database.
type countingRepo struct {
	*authtest.Repo
	lookups int
}

func (c *countingRepo) ActiveSession(ctx context.Context, hash []byte, kind store.SessionKind, now time.Time) (store.Session, error) {
	c.lookups++
	return c.Repo.ActiveSession(ctx, hash, kind, now)
}

func (c *countingRepo) DeleteSession(ctx context.Context, hash []byte) error {
	c.lookups++
	return c.Repo.DeleteSession(ctx, hash)
}

func (c *countingRepo) ConsumeSession(ctx context.Context, hash []byte, kind store.SessionKind, now time.Time) (store.Session, error) {
	c.lookups++
	return c.Repo.ConsumeSession(ctx, hash, kind, now)
}

// Lote 16: a token newToken could not have produced (43 base64url characters) is
// refused before any lookup, so a flood of junk credentials costs no database work.
func TestMalformedTokensAreNotLookedUp(t *testing.T) {
	ctx := context.Background()
	repo := &countingRepo{Repo: authtest.NewRepo()}
	svc, err := auth.New(auth.Config{
		Repo: repo, Clock: clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Vocations: testVocations, Hash: auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, tok := range []string{"", "x", strings.Repeat("a", 42), strings.Repeat("a", 44),
		strings.Repeat("a", 42) + "!", strings.Repeat("a", 42) + "=", strings.Repeat("a", 128)} {
		if _, err := svc.Authenticate(ctx, tok); !errors.Is(err, auth.ErrUnauthorized) {
			t.Errorf("Authenticate(%q): %v", tok, err)
		}
		if err := svc.Logout(ctx, tok); err != nil {
			t.Errorf("Logout(%q): %v", tok, err)
		}
		if _, _, err := svc.RedeemPlayToken(ctx, tok); !errors.Is(err, auth.ErrUnauthorized) {
			t.Errorf("RedeemPlayToken(%q): %v", tok, err)
		}
	}
	if repo.lookups != 0 {
		t.Fatalf("%d lookups for malformed tokens", repo.lookups)
	}
	// A well-formed unknown token is looked up (once).
	if _, err := svc.Authenticate(ctx, strings.Repeat("A", 43)); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatal(err)
	}
	if repo.lookups != 1 {
		t.Fatalf("%d lookups for a well-formed token", repo.lookups)
	}
}

func TestNPCReservedNames(t *testing.T) {
	got := auth.NPCReservedNames([]string{
		"Gisla, la curtidora", "Gisla the tanner", "Maren Holt, jefa del puerto",
		"Sister Liora", "forge echo", "Casia Hollín, keeper of records",
	})
	want := []string{"Gisla", "Gisla the tanner", "Maren Holt", "Maren", "Holt", "Sister Liora",
		"Liora", "forge echo", "Casia Hollín", "Casia", "Hollín"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

// The names as i18n/*/npcs.yaml writes them since lote 20b: the name alone, its trade in
// the role text. One word reserves itself; lower-case words reserve only the whole name.
func TestNPCReservedNamesWithoutTrades(t *testing.T) {
	got := auth.NPCReservedNames([]string{
		"Maren Holt", "Corvo", "Gisla", "Sister Liora", "Hermana Liora", "forge echo",
		"eco de la forja", "Casia Hollín", "Maren Holt",
	})
	want := []string{"Maren Holt", "Maren", "Holt", "Corvo", "Gisla", "Sister Liora", "Liora",
		"Hermana Liora", "forge echo", "eco de la forja", "Casia Hollín", "Casia", "Hollín"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

// Lote 16: a character may not take an NPC's name (its full name or its first name), in
// any capitals or spacing.
func TestCharacterNamesCannotCopyNPCs(t *testing.T) {
	ctx := context.Background()
	repo := authtest.NewRepo()
	svc, err := auth.New(auth.Config{
		Repo: repo, Clock: clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Vocations: testVocations, Hash: auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
		MaxCharacters: 10,
		ReservedNames: auth.NPCReservedNames([]string{"Gisla, la curtidora", "Maren Holt, harbour master", "Tobías Muestra, proveedor", "Hermana Liora"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	id, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	// Accents are dropped ("Tobías"), but a title alone ("Hermana") stays free.
	for _, name := range []string{"Gisla", "Maren Holt", "maren holt", "MarenHolt", "Maren", "Holt", "Tobias", "Tobias Muestra", "Hermana Liora", "Liora"} {
		if _, err := svc.CreateCharacter(ctx, id, name, "guardian", nil); !errors.Is(err, auth.ErrReservedName) {
			t.Errorf("%q: %v, want reserved", name, err)
		}
	}
	for _, name := range []string{"Gislar", "Maren Holtz", "Gisla Stone", "Hermana"} {
		if _, err := svc.CreateCharacter(ctx, id, name, "guardian", nil); err != nil {
			t.Errorf("%q: %v", name, err)
		}
	}
}
