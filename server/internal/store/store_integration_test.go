//go:build integration

package store_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

func hash(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }

func TestMigrationsUpDownUp(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_migrations", true)
	if err := st.MigrateDownAll(ctx); err != nil {
		t.Fatalf("down: %v", err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("up is idempotent: %v", err)
	}
}

func TestAccountsAndSessions(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_accounts", true)

	id, err := st.CreateAccount(ctx, "ana@example.org", "$argon2id$x")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateAccount(ctx, "ana@example.org", "h"); !errors.Is(err, store.ErrEmailTaken) {
		t.Fatalf("duplicate email: %v", err)
	}
	if _, err := st.CreateAccount(ctx, "Upper@example.org", "h"); err == nil {
		t.Fatal("non-lowercase email must be rejected by the schema")
	}
	acc, err := st.AccountByEmail(ctx, "ana@example.org")
	if err != nil || acc.ID != id || acc.PasswordHash != "$argon2id$x" || acc.Disabled {
		t.Fatalf("AccountByEmail = %+v, %v", acc, err)
	}
	if _, err := st.AccountByEmail(ctx, "nobody@example.org"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing account: %v", err)
	}
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	if err := st.TouchLogin(ctx, id, now); err != nil {
		t.Fatal(err)
	}

	sess := store.Session{TokenHash: hash("t1"), AccountID: id, Kind: store.SessionAccount, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	if err := st.CreateSession(ctx, sess); err != nil {
		t.Fatal(err)
	}
	got, err := st.ActiveSession(ctx, hash("t1"), store.SessionAccount, now.Add(59*time.Minute))
	if err != nil || got.AccountID != id || !got.ExpiresAt.Equal(sess.ExpiresAt) {
		t.Fatalf("ActiveSession = %+v, %v", got, err)
	}
	for name, check := range map[string]func() error{
		"expired": func() error {
			_, err := st.ActiveSession(ctx, hash("t1"), store.SessionAccount, now.Add(time.Hour))
			return err
		},
		"wrong kind": func() error { _, err := st.ActiveSession(ctx, hash("t1"), store.SessionPlay, now); return err },
		"unknown":    func() error { _, err := st.ActiveSession(ctx, hash("t2"), store.SessionAccount, now); return err },
	} {
		if err := check(); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A play session must name a character (schema check).
	bad := sess
	bad.TokenHash, bad.Kind = hash("t3"), store.SessionPlay
	if err := st.CreateSession(ctx, bad); err == nil {
		t.Fatal("play session without character must fail")
	}

	n, err := st.DeleteExpiredSessions(ctx, now.Add(2*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("DeleteExpiredSessions = %d, %v", n, err)
	}
	if err := st.DeleteSession(ctx, hash("t1")); err != nil {
		t.Fatalf("deleting a missing session is fine: %v", err)
	}
}

func TestCharacters(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_characters", true)
	a, _ := st.CreateAccount(ctx, "ana@example.org", "h")
	b, _ := st.CreateAccount(ctx, "bob@example.org", "h")

	c, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: a, Name: "Mira", Vocation: "guardian", Health: 150, Mana: 30}, 2)
	if err != nil || c.Name != "Mira" || c.Level != 1 {
		t.Fatalf("CreateCharacter = %+v, %v", c, err)
	}
	if _, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: b, Name: "MIRA", Vocation: "guardian", Health: 1}, 2); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("name taken ignoring case: %v", err)
	}
	if _, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: 999, Name: "Ghost", Vocation: "guardian", Health: 1}, 2); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown account: %v", err)
	}
	if _, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: a, Name: "Old Tom", Vocation: "arcanist", Health: 1}, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: a, Name: "Third", Vocation: "guardian", Health: 1}, 2); !errors.Is(err, store.ErrCharacterLimit) {
		t.Fatalf("limit: %v", err)
	}
	list, err := st.ListCharacters(ctx, a)
	if err != nil || len(list) != 2 || list[0].Name != "Mira" || list[1].Vocation != "arcanist" {
		t.Fatalf("ListCharacters = %+v, %v", list, err)
	}
	if empty, err := st.ListCharacters(ctx, b); err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty list must be non-nil: %#v, %v", empty, err)
	}
}

// TestCharacterLimitUnderConcurrency checks the account row lock: parallel creations
// never exceed the limit.
func TestCharacterLimitUnderConcurrency(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_concurrency", true)
	a, _ := st.CreateAccount(ctx, "ana@example.org", "h")
	names := []string{"Aa", "Bb", "Cc", "Dd", "Ee", "Ff", "Gg", "Hh"}
	var wg sync.WaitGroup
	for _, n := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = st.CreateCharacter(ctx, store.NewCharacter{AccountID: a, Name: n + "name", Vocation: "guardian", Health: 1}, 3)
		}()
	}
	wg.Wait()
	list, err := st.ListCharacters(ctx, a)
	if err != nil || len(list) != 3 {
		t.Fatalf("got %d characters, want 3 (%v)", len(list), err)
	}
}
