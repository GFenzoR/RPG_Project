package auth_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Lote 17 (owner decision 2026-11-23): the game never keeps the login. Account sessions
// have a short absolute TTL and an idle timeout; "sign out everywhere" and a password
// change revoke sessions.

func newSessionService(t *testing.T, mutate func(*auth.Config)) (*auth.Service, *authtest.Repo, *clock.Fake) {
	t.Helper()
	repo := authtest.NewRepo()
	clk := clock.NewFake(time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC))
	cfg := auth.Config{
		Repo:      repo,
		Clock:     clk,
		Vocations: testVocations,
		Hash:      auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
	}
	if mutate != nil {
		mutate(&cfg)
	}
	svc, err := auth.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return svc, repo, clk
}

func sum(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

func TestSessionDefaultsAreShort(t *testing.T) {
	ctx := context.Background()
	svc, _, clk := newSessionService(t, nil)
	_, _ = svc.Register(ctx, "ana@example.org", "secreto123")
	tok, err := svc.Login(ctx, "ana@example.org", "secreto123")
	if err != nil {
		t.Fatal(err)
	}
	if want := clk.Now().Add(auth.DefaultAccountTokenTTL); !tok.ExpiresAt.Equal(want) || auth.DefaultAccountTokenTTL != 12*time.Hour {
		t.Fatalf("expires %v, want %v (12 h)", tok.ExpiresAt, want)
	}
	if auth.DefaultSessionIdle != 30*time.Minute {
		t.Fatalf("idle timeout %v, want 30 min", auth.DefaultSessionIdle)
	}
}

func TestSessionIdleTimeout(t *testing.T) {
	ctx := context.Background()
	svc, repo, clk := newSessionService(t, nil)
	_, _ = svc.Register(ctx, "ana@example.org", "secreto123")
	tok, _ := svc.Login(ctx, "ana@example.org", "secreto123")

	clk.Advance(auth.DefaultSessionIdle - time.Second)
	if _, err := svc.Authenticate(ctx, tok.Token); err != nil {
		t.Fatalf("just before the idle timeout: %v", err)
	}
	// That request slid the timeout: another 29 min 59 s later it still works.
	clk.Advance(auth.DefaultSessionIdle - time.Second)
	if _, err := svc.Authenticate(ctx, tok.Token); err != nil {
		t.Fatalf("activity did not slide the idle timeout: %v", err)
	}
	clk.Advance(auth.DefaultSessionIdle)
	if _, err := svc.Authenticate(ctx, tok.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("idle session still works: %v", err)
	}
	if repo.HasSession(sum(tok.Token)) {
		t.Fatal("the idle session was not deleted when it was refused")
	}
}

func TestSessionTouchAtMostOncePerMinute(t *testing.T) {
	ctx := context.Background()
	svc, repo, clk := newSessionService(t, nil)
	_, _ = svc.Register(ctx, "ana@example.org", "secreto123")
	tok, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	for range 10 {
		clk.Advance(5 * time.Second)
		if _, err := svc.Authenticate(ctx, tok.Token); err != nil {
			t.Fatal(err)
		}
	}
	if repo.Touches != 0 {
		t.Fatalf("%d writes for 50 s of requests, want 0", repo.Touches)
	}
	clk.Advance(10 * time.Second) // one minute since the login
	_, _ = svc.Authenticate(ctx, tok.Token)
	_, _ = svc.Authenticate(ctx, tok.Token)
	if repo.Touches != 1 {
		t.Fatalf("%d writes at the minute, want 1", repo.Touches)
	}
}

func TestPurgeDeletesIdleSessions(t *testing.T) {
	ctx := context.Background()
	svc, repo, clk := newSessionService(t, func(c *auth.Config) { c.SessionIdle = 10 * time.Minute })
	acc, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	c, _ := svc.CreateCharacter(ctx, acc, "Mira", "guardian", nil)
	idle, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	clk.Advance(9 * time.Minute)
	busy, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	clk.Advance(time.Minute) // idle is 10 min old, busy 1 min
	if n, err := svc.PurgeExpiredSessions(ctx); err != nil || n != 1 {
		t.Fatalf("purge = %d, %v; want 1", n, err)
	}
	if repo.HasSession(sum(idle.Token)) || !repo.HasSession(sum(busy.Token)) {
		t.Fatal("purge deleted the wrong session")
	}
	// Play tokens are not account sessions: the idle purge leaves them to their own TTL.
	play, err := svc.IssuePlayToken(ctx, acc, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	clk.Advance(30 * time.Second)
	if _, err := svc.PurgeExpiredSessions(ctx); err != nil {
		t.Fatal(err)
	}
	if !repo.HasSession(sum(play.Token)) {
		t.Fatal("the idle purge deleted a play token")
	}
}

func TestSignOutEverywhere(t *testing.T) {
	ctx := context.Background()
	var kicked []int64
	svc, repo, _ := newSessionService(t, func(c *auth.Config) {
		c.SignedOutEverywhere = func(id int64) { kicked = append(kicked, id) }
		c.SessionsRevoked = func(int64) { t.Error("sign out everywhere is not a password change") }
	})
	acc, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	other, _ := svc.Register(ctx, "bob@example.org", "secreto123")
	c, _ := svc.CreateCharacter(ctx, acc, "Mira", "guardian", nil)
	web, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	desktop, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	play, _ := svc.IssuePlayToken(ctx, acc, c.ID)
	bob, _ := svc.Login(ctx, "bob@example.org", "secreto123")

	if err := svc.SignOutEverywhere(ctx, acc); err != nil {
		t.Fatal(err)
	}
	for name, tok := range map[string]string{"web": web.Token, "desktop": desktop.Token} {
		if _, err := svc.Authenticate(ctx, tok); !errors.Is(err, auth.ErrUnauthorized) {
			t.Errorf("%s session survived: %v", name, err)
		}
	}
	if _, _, err := svc.RedeemPlayToken(ctx, play.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Errorf("pending play token survived: %v", err)
	}
	if id, err := svc.Authenticate(ctx, bob.Token); err != nil || id != other {
		t.Errorf("another account's session was revoked: %d, %v", id, err)
	}
	if len(kicked) != 1 || kicked[0] != acc {
		t.Fatalf("online characters of %v disconnected, want [%d]", kicked, acc)
	}
	if last := repo.Audit[len(repo.Audit)-1]; last.Action != store.AuditSessionsRevoked || last.TargetAccountID != acc {
		t.Fatalf("audit %+v", last)
	}
}

func TestChangePassword(t *testing.T) {
	ctx := context.Background()
	var kicked []int64
	svc, repo, _ := newSessionService(t, func(c *auth.Config) {
		c.SessionsRevoked = func(id int64) { kicked = append(kicked, id) }
	})
	acc, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	c, _ := svc.CreateCharacter(ctx, acc, "Mira", "guardian", nil)
	current, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	other, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	play, _ := svc.IssuePlayToken(ctx, acc, c.ID)
	// A pending reset link (issued by the operator here: no mailer in this service).
	if err := repo.ReplaceAccountToken(ctx, store.AccountToken{
		TokenHash: sum("reset"), AccountID: acc, Purpose: store.TokenResetPassword,
		Email: "ana@example.org", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	old := repo.PasswordHash(acc)

	if err := svc.ChangePassword(ctx, current.Token, "wrongpass1", "nuevaclave9"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("wrong current password: %v", err)
	}
	if err := svc.ChangePassword(ctx, current.Token, "", "nuevaclave9"); !errors.Is(err, auth.ErrReauthRequired) {
		t.Fatalf("missing current password: %v", err)
	}
	if err := svc.ChangePassword(ctx, current.Token, "secreto123", "short"); !errors.Is(err, auth.ErrInvalidPassword) {
		t.Fatalf("weak new password: %v", err)
	}
	if err := svc.ChangePassword(ctx, "not-a-token", "secreto123", "nuevaclave9"); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("no session: %v", err)
	}
	if repo.PasswordHash(acc) != old || len(kicked) != 0 || repo.SessionCount() != 3 {
		t.Fatal("a refused change changed something")
	}

	if err := svc.ChangePassword(ctx, current.Token, "secreto123", "nuevaclave9"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, current.Token); err != nil {
		t.Fatalf("the session that changed the password was revoked: %v", err)
	}
	if _, err := svc.Authenticate(ctx, other.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("another session survived: %v", err)
	}
	if _, _, err := svc.RedeemPlayToken(ctx, play.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("pending play token survived: %v", err)
	}
	if repo.TokenCount() != 0 {
		t.Fatalf("%d reset links survived the change", repo.TokenCount())
	}
	if len(kicked) != 1 || kicked[0] != acc {
		t.Fatalf("online characters of %v disconnected, want [%d]", kicked, acc)
	}
	if _, err := svc.Login(ctx, "ana@example.org", "secreto123"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatal("old password still works")
	}
	if _, err := svc.Login(ctx, "ana@example.org", "nuevaclave9"); err != nil {
		t.Fatalf("new password: %v", err)
	}
	if last := repo.Audit[len(repo.Audit)-1]; last.Action != store.AuditPasswordChanged {
		t.Fatalf("audit %+v", last)
	}
}
