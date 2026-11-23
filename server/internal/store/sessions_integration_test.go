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

// Lote 17: last use of a session, idle purge, "sign out everywhere" and password change.
func TestSessionIdleRevokeAndChangePassword(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_sessions_l17", true)
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	acc, err := st.CreateAccount(ctx, "ana@example.org", "$argon2id$old")
	if err != nil {
		t.Fatal(err)
	}
	other, _ := st.CreateAccount(ctx, "bob@example.org", "$argon2id$x")
	c, err := st.CreateCharacter(ctx, store.NewCharacter{AccountID: acc, Name: "Mira", Vocation: "guardian", Health: 145, Mana: 20}, 10)
	if err != nil {
		t.Fatal(err)
	}
	mk := func(name string, id int64, kind store.SessionKind, charID int64) []byte {
		t.Helper()
		s := store.Session{TokenHash: hash(name), AccountID: id, Kind: kind, CharacterID: charID, CreatedAt: now, ExpiresAt: now.Add(12 * time.Hour)}
		if err := st.CreateSession(ctx, s); err != nil {
			t.Fatal(err)
		}
		return s.TokenHash
	}
	a1 := mk("a1", acc, store.SessionAccount, 0)
	a2 := mk("a2", acc, store.SessionAccount, 0)
	play := mk("play", acc, store.SessionPlay, c.ID)
	mk("b1", other, store.SessionAccount, 0)

	got, err := st.ActiveSession(ctx, a1, store.SessionAccount, now)
	if err != nil || !got.LastSeenAt.Equal(now) {
		t.Fatalf("new session last seen %v, %v; want created_at", got.LastSeenAt, err)
	}
	later := now.Add(20 * time.Minute)
	if err := st.TouchSession(ctx, a1, later); err != nil {
		t.Fatal(err)
	}
	if err := st.TouchSession(ctx, a1, now.Add(time.Minute)); err != nil { // never backwards
		t.Fatal(err)
	}
	if got, _ := st.ActiveSession(ctx, a1, store.SessionAccount, later); !got.LastSeenAt.Equal(later) {
		t.Fatalf("last seen %v, want %v", got.LastSeenAt, later)
	}
	// Idle purge at now+31 min with a 30 min timeout: a2 and b1 go, a1 and the play token stay.
	n, err := st.DeleteIdleSessions(ctx, now.Add(time.Minute))
	if err != nil || n != 2 {
		t.Fatalf("idle purge = %d, %v; want 2", n, err)
	}
	if _, err := st.ActiveSession(ctx, a2, store.SessionAccount, later); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("idle session survived: %v", err)
	}
	if _, err := st.ActiveSession(ctx, a1, store.SessionAccount, later); err != nil {
		t.Fatalf("active session purged: %v", err)
	}
	b1 := mk("b1-again", other, store.SessionAccount, 0)
	a2 = mk("a2-again", acc, store.SessionAccount, 0)

	// Password change: keeps a1, revokes a2 and the play token, kills reset links.
	if err := st.ReplaceAccountToken(ctx, store.AccountToken{TokenHash: hash("reset"), AccountID: acc, Purpose: store.TokenResetPassword,
		Email: "ana@example.org", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	n, err = st.ChangePassword(ctx, acc, "$argon2id$new", a1, later)
	if err != nil || n != 2 {
		t.Fatalf("change password revoked %d, %v; want 2", n, err)
	}
	if _, err := st.ActiveSession(ctx, a1, store.SessionAccount, later); err != nil {
		t.Fatalf("the asking session was revoked: %v", err)
	}
	if _, err := st.ConsumeSession(ctx, play, store.SessionPlay, later); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("play token survived: %v", err)
	}
	if _, err := st.ActiveSession(ctx, a2, store.SessionAccount, later); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("other session survived: %v", err)
	}
	if _, err := st.ResetPassword(ctx, hash("reset"), "$argon2id$z", later); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("reset link survived the change: %v", err)
	}
	if a, _ := st.AccountByEmail(ctx, "ana@example.org"); a.PasswordHash != "$argon2id$new" {
		t.Fatalf("hash %q", a.PasswordHash)
	}

	// Sign out everywhere: every session of the account, none of another's.
	mk("play2", acc, store.SessionPlay, c.ID)
	n, err = st.RevokeAllSessions(ctx, acc, later)
	if err != nil || n != 2 {
		t.Fatalf("revoke all = %d, %v; want 2", n, err)
	}
	if _, err := st.ActiveSession(ctx, a1, store.SessionAccount, later); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("session survived sign out everywhere: %v", err)
	}
	if _, err := st.ActiveSession(ctx, b1, store.SessionAccount, now); err != nil {
		t.Fatalf("another account's session was revoked: %v", err)
	}
	audit, err := st.ListAudit(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, e := range audit {
		seen[e.Action] = true
	}
	if !seen[store.AuditPasswordChanged] || !seen[store.AuditSessionsRevoked] {
		t.Fatalf("audit %v", seen)
	}
}
