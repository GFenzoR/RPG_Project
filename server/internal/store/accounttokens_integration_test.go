//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// The whole T2.1 email flow through auth.Service against Postgres: verification,
// single use, replacement, expiry, reset revoking every session, and the audit log.
func TestAccountTokensWithPostgres(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_account_tokens", true)
	clk := clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	box := &authtest.Mailbox{}
	svc, err := auth.New(auth.Config{
		Repo: st, Clock: clk, Vocations: content.Vocations{"guardian": {ID: "guardian"}},
		Hash: auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
		Mail: box, PublicURL: "https://game.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	id, err := svc.Register(ctx, "ana@example.org", "secreto123")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SendVerification(ctx, id, "en"); err != nil {
		t.Fatal(err)
	}
	first, _ := box.Last()
	if err := svc.SendVerification(ctx, id, "es"); err != nil {
		t.Fatal(err)
	}
	second, _ := box.Last()
	if second.Lang != "en" {
		t.Fatalf("stored locale not used: %q", second.Lang)
	}
	if err := svc.VerifyEmail(ctx, first.Token()); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("replaced token: %v", err)
	}
	if err := svc.VerifyEmail(ctx, second.Token()); err != nil {
		t.Fatal(err)
	}
	if err := svc.VerifyEmail(ctx, second.Token()); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("reused token: %v", err)
	}
	p, err := st.AccountProfile(ctx, id)
	if err != nil || !p.EmailVerified || p.Locale != "en" || !p.HasPassword {
		t.Fatalf("profile %+v %v", p, err)
	}

	// Reset: every session (account and play) goes; the new password works.
	if _, err := svc.CreateCharacter(ctx, id, "Anabel", "guardian"); err != nil {
		t.Fatal(err)
	}
	tok, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	cs, _ := svc.Characters(ctx, id)
	if _, err := svc.IssuePlayToken(ctx, id, cs[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestPasswordReset(ctx, "ana@example.org", ""); err != nil {
		t.Fatal(err)
	}
	reset, _ := box.Last()
	if err := svc.ResetPassword(ctx, reset.Token(), "nuevaclave9"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, tok.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("session survived: %v", err)
	}
	conn := storetest.Conn(t, "it_store_account_tokens")
	var sessions, tokens int
	if err := conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM sessions), (SELECT count(*) FROM account_tokens)`).Scan(&sessions, &tokens); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 || tokens != 0 {
		t.Fatalf("%d sessions and %d tokens left", sessions, tokens)
	}
	if _, err := svc.Login(ctx, "ana@example.org", "nuevaclave9"); err != nil {
		t.Fatal(err)
	}
	if err := svc.ResetPassword(ctx, reset.Token(), "otraclave99"); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("reused reset token: %v", err)
	}
	audit, err := st.ListAudit(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	var actions []string
	for _, e := range audit {
		actions = append(actions, e.Action)
	}
	if len(actions) != 2 || actions[0] != store.AuditPasswordReset || actions[1] != store.AuditEmailVerified {
		t.Fatalf("audit %v", actions)
	}

	// Expiry and purge.
	if err := svc.RequestPasswordReset(ctx, "ana@example.org", ""); err != nil {
		t.Fatal(err)
	}
	late, _ := box.Last()
	clk.Advance(time.Hour)
	if err := svc.ResetPassword(ctx, late.Token(), "otraclave99"); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("expired: %v", err)
	}
	if n, err := st.DeleteExpiredAccountTokens(ctx, clk.Now()); err != nil || n != 1 {
		t.Fatalf("purged %d: %v", n, err)
	}
	// The stored value is the SHA-256, never the token.
	if err := svc.RequestPasswordReset(ctx, "ana@example.org", ""); err != nil {
		t.Fatal(err)
	}
	last, _ := box.Last()
	var stored []byte
	if err := conn.QueryRow(ctx, `SELECT token_hash FROM account_tokens`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if string(stored) != string(hash(last.Token())) {
		t.Fatal("stored value is not the SHA-256 of the token")
	}
}
