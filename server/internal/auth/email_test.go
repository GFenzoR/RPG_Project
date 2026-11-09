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
	"github.com/GFenzoR/RPG_Project/server/internal/mail"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

func newMailService(t *testing.T, mutate func(*auth.Config)) (*auth.Service, *authtest.Repo, *authtest.Mailbox, *clock.Fake) {
	t.Helper()
	repo := authtest.NewRepo()
	box := &authtest.Mailbox{}
	clk := clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	cfg := auth.Config{
		Repo: repo, Clock: clk, Vocations: testVocations,
		Hash:      auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
		Mail:      box,
		PublicURL: "https://game.example/",
	}
	if mutate != nil {
		mutate(&cfg)
	}
	svc, err := auth.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return svc, repo, box, clk
}

func TestNewChecksEmailConfig(t *testing.T) {
	base := auth.Config{Repo: authtest.NewRepo(), Clock: clock.NewFake(time.Unix(0, 0)), Vocations: testVocations}
	c := base
	c.RequireVerifiedEmail = true
	if _, err := auth.New(c); err == nil {
		t.Fatal("require verified without a mailer accepted")
	}
	for _, u := range []string{"", "game.example", "javascript:x", "https://game.example/?a=1", "https://u:p@game.example"} {
		c := base
		c.Mail, c.PublicURL = &authtest.Mailbox{}, u
		if _, err := auth.New(c); err == nil {
			t.Errorf("public URL %q accepted", u)
		}
	}
}

func TestVerifyEmailIsSingleUseAndExpires(t *testing.T) {
	ctx := context.Background()
	svc, repo, box, clk := newMailService(t, nil)
	id, err := svc.Register(ctx, "ana@example.org", "secreto123")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RequireVerified(ctx, id); !errors.Is(err, auth.ErrEmailUnverified) {
		t.Fatalf("new account: %v", err)
	}
	if err := svc.SendVerification(ctx, id, "en"); err != nil {
		t.Fatal(err)
	}
	first, _ := box.Last()
	if first.Kind != mail.KindVerify || first.To != "ana@example.org" || first.Lang != "en" ||
		!strings.HasPrefix(first.Link, "https://game.example/verify?lang=en#token=") || len(first.Token()) != 43 {
		t.Fatalf("email %+v", first)
	}
	// The language of the request became the account's: a later "es" request keeps "en".
	if err := svc.SendVerification(ctx, id, "es"); err != nil {
		t.Fatal(err)
	}
	second, _ := box.Last()
	if second.Lang != "en" {
		t.Fatalf("lang %q, want the account's en", second.Lang)
	}
	// A new link replaces the old one.
	if err := svc.VerifyEmail(ctx, first.Token()); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("replaced link: %v", err)
	}
	if err := svc.VerifyEmail(ctx, second.Token()); err != nil {
		t.Fatal(err)
	}
	if err := svc.VerifyEmail(ctx, second.Token()); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("second use: %v", err)
	}
	if err := svc.RequireVerified(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := svc.SendVerification(ctx, id, ""); !errors.Is(err, auth.ErrAlreadyVerified) {
		t.Fatalf("verified account: %v", err)
	}
	if len(repo.Audit) != 1 || repo.Audit[0].Action != store.AuditEmailVerified {
		t.Fatalf("audit %+v", repo.Audit)
	}

	// Expiry: 24 h.
	id2, _ := svc.Register(ctx, "bob@example.org", "secreto123")
	_ = svc.SendVerification(ctx, id2, "")
	late, _ := box.Last()
	clk.Advance(auth.DefaultVerifyTokenTTL)
	if err := svc.VerifyEmail(ctx, late.Token()); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("expired link: %v", err)
	}
	if n, _ := svc.PurgeExpiredSessions(ctx); n != 1 || repo.TokenCount() != 0 {
		t.Fatalf("purged %d, %d tokens left", n, repo.TokenCount())
	}
	for _, bad := range []string{"", "short", strings.Repeat("!", 43), late.Token() + "x"} {
		if err := svc.VerifyEmail(ctx, bad); !errors.Is(err, auth.ErrInvalidToken) {
			t.Errorf("token %q: %v", bad, err)
		}
	}
}

func TestPasswordResetRevokesEverySession(t *testing.T) {
	ctx := context.Background()
	svc, repo, box, clk := newMailService(t, nil)
	id, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	repo.SetVerified(id)
	tok1, _ := svc.Login(ctx, "ana@example.org", "secreto123")
	_, _ = svc.Login(ctx, "ana@example.org", "secreto123")

	if err := svc.RequestPasswordReset(ctx, " ANA@example.org ", "es"); err != nil {
		t.Fatal(err)
	}
	e, ok := box.Last()
	if !ok || e.Kind != mail.KindReset || !strings.HasPrefix(e.Link, "https://game.example/reset-password?lang=es#token=") {
		t.Fatalf("email %+v", e)
	}
	if err := svc.ResetPassword(ctx, e.Token(), "short"); !errors.Is(err, auth.ErrInvalidPassword) {
		t.Fatalf("weak password: %v", err)
	}
	old := repo.PasswordHash(id)
	if err := svc.ResetPassword(ctx, e.Token(), "nuevaclave9"); err != nil {
		t.Fatal(err)
	}
	if repo.PasswordHash(id) == old || strings.Contains(repo.PasswordHash(id), "nuevaclave9") {
		t.Fatal("password not replaced by a hash")
	}
	if repo.SessionCount() != 0 {
		t.Fatalf("%d sessions survived the reset", repo.SessionCount())
	}
	if _, err := svc.Authenticate(ctx, tok1.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatal("old token still works")
	}
	if err := svc.ResetPassword(ctx, e.Token(), "otraclave99"); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("second use: %v", err)
	}
	if _, err := svc.Login(ctx, "ana@example.org", "nuevaclave9"); err != nil {
		t.Fatalf("login with the new password: %v", err)
	}
	if _, err := svc.Login(ctx, "ana@example.org", "secreto123"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatal("old password still works")
	}

	// 1 hour expiry.
	_ = svc.RequestPasswordReset(ctx, "ana@example.org", "")
	e, _ = box.Last()
	clk.Advance(time.Hour)
	if err := svc.ResetPassword(ctx, e.Token(), "otraclave99"); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("expired: %v", err)
	}
}

func TestPasswordResetDoesNotTellWhoExists(t *testing.T) {
	ctx := context.Background()
	svc, repo, box, _ := newMailService(t, nil)
	unverified, _ := svc.Register(ctx, "new@example.org", "secreto123")
	disabled, _ := svc.Register(ctx, "off@example.org", "secreto123")
	repo.SetVerified(disabled)
	repo.Disable(disabled)
	_ = unverified
	for _, email := range []string{"nobody@example.org", "new@example.org", "off@example.org", "not an email"} {
		if err := svc.RequestPasswordReset(ctx, email, "es"); err != nil {
			t.Errorf("%s: %v", email, err)
		}
	}
	if n := len(box.Sent()); n != 0 {
		t.Fatalf("%d emails sent to accounts that may not get one", n)
	}
}

func TestEmailDisabledBehavesAsBefore(t *testing.T) {
	ctx := context.Background()
	svc, _, _ := newService(t)
	id, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	if svc.EmailEnabled() {
		t.Fatal("enabled without a mailer")
	}
	if err := svc.RequireVerified(ctx, id); err != nil {
		t.Fatalf("nothing can be verified, so nothing is required: %v", err)
	}
	if err := svc.SendVerification(ctx, id, ""); !errors.Is(err, auth.ErrEmailDisabled) {
		t.Fatal(err)
	}
	if err := svc.RequestPasswordReset(ctx, "ana@example.org", ""); !errors.Is(err, auth.ErrEmailDisabled) {
		t.Fatal(err)
	}
}

func TestRequireVerifiedEmailToPlay(t *testing.T) {
	ctx := context.Background()
	svc, repo, _, _ := newMailService(t, func(c *auth.Config) { c.RequireVerifiedEmail = true })
	id, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	c, err := svc.CreateCharacter(ctx, id, "Ana", "guardian")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.IssuePlayToken(ctx, id, c.ID); !errors.Is(err, auth.ErrEmailUnverified) {
		t.Fatalf("unverified play: %v", err)
	}
	repo.SetVerified(id)
	if _, err := svc.IssuePlayToken(ctx, id, c.ID); err != nil {
		t.Fatal(err)
	}
}

func TestIssueResetLinkStoresOnlyTheHash(t *testing.T) {
	ctx := context.Background()
	svc, repo, _, _ := newMailService(t, nil)
	id, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	link, p, err := auth.IssueResetLink(ctx, repo, now, "https://game.example", "Ana@example.org")
	if err != nil || p.ID != id {
		t.Fatalf("%v %+v", err, p)
	}
	_, token, _ := strings.Cut(link, "#token=")
	if err := svc.ResetPassword(ctx, token, "nuevaclave9"); err != nil {
		t.Fatalf("the operator's link works for an unverified account too: %v", err)
	}
	if _, _, err := auth.IssueResetLink(ctx, repo, now, "https://game.example", "x@example.org"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown email: %v", err)
	}
}
