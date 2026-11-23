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
	var kicked []int64
	svc, repo, box, _ := newMailService(t, func(c *auth.Config) {
		c.SessionsRevoked = func(id int64) { kicked = append(kicked, id) }
	})
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
	if len(kicked) != 1 || kicked[0] != id {
		t.Fatalf("online characters of %v disconnected, want [%d]", kicked, id)
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

	// A disabled account cannot redeem a reset link.
	_ = svc.RequestPasswordReset(ctx, "ana@example.org", "")
	e, _ = box.Last()
	repo.Disable(id)
	if err := svc.ResetPassword(ctx, e.Token(), "otraclave99"); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("disabled account: %v", err)
	}
}

func TestPasswordResetExpires(t *testing.T) {
	ctx := context.Background()
	svc, repo, box, clk := newMailService(t, nil)
	id, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	repo.SetVerified(id)
	// 1 hour expiry.
	_ = svc.RequestPasswordReset(ctx, "ana@example.org", "")
	e, _ := box.Last()
	clk.Advance(time.Hour)
	if err := svc.ResetPassword(ctx, e.Token(), "otraclave99"); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("expired: %v", err)
	}
}

func TestPasswordResetDoesNotTellWhoExists(t *testing.T) {
	ctx := context.Background()
	svc, repo, box, _ := newMailService(t, nil)
	disabled, _ := svc.Register(ctx, "off@example.org", "secreto123")
	repo.SetVerified(disabled)
	repo.Disable(disabled)
	for _, email := range []string{"nobody@example.org", "off@example.org", "not an email"} {
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
	c, err := svc.CreateCharacter(ctx, id, "Ana", "guardian", nil)
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

// Lote 16: an unverified account can hold any address. After its 24 h verification link
// expired, the mailbox owner takes the address back with "forgot your password?": the
// link proves the mailbox, verifies the address and resets the password, without the
// squatter's password, and the squatter's sessions die.
func TestResetClaimsAnUnverifiedAddress(t *testing.T) {
	ctx := context.Background()
	svc, _, box, clk := newMailService(t, nil)
	id, err := svc.Register(ctx, "victim@example.org", "squatter-pass")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SendVerification(ctx, id, "es"); err != nil {
		t.Fatal(err)
	}
	clk.Advance(auth.DefaultVerifyTokenTTL + time.Hour) // the verification link expired
	squatter, err := svc.Login(ctx, "victim@example.org", "squatter-pass")
	if err != nil {
		t.Fatal(err)
	}

	// The mailbox owner asks for a reset: a link goes to the address.
	if err := svc.RequestPasswordReset(ctx, "victim@example.org", "en"); err != nil {
		t.Fatal(err)
	}
	e, _ := box.Last()
	if e.Kind != mail.KindReset || e.To != "victim@example.org" || !strings.Contains(e.Link, "/reset-password") {
		t.Fatalf("email %+v", e)
	}
	if err := svc.ResetPassword(ctx, e.Token(), "owner-pass-1"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if p, _ := svc.Profile(ctx, id); !p.EmailVerified {
		t.Fatal("the address is not verified after the claim")
	}
	if _, err := svc.Authenticate(ctx, squatter.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("the squatter's session survived: %v", err)
	}
	if _, err := svc.Login(ctx, "victim@example.org", "squatter-pass"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("the squatter's password still works: %v", err)
	}
	if _, err := svc.Login(ctx, "victim@example.org", "owner-pass-1"); err != nil {
		t.Fatalf("the owner cannot log in: %v", err)
	}
	// The link works once.
	if err := svc.ResetPassword(ctx, e.Token(), "owner-pass-2"); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("second use: %v", err)
	}
}

// Lote 16 review: anyone who knows a new account's address could ask for a reset and
// so kill the registration's verification link (the claim link used to be a
// verify_email token, which replaced it). The claim link is a purpose of its own: both
// links keep working, and the claim link does not verify on the /verify page.
func TestResetRequestKeepsTheVerificationLink(t *testing.T) {
	ctx := context.Background()
	svc, _, box, _ := newMailService(t, nil)
	id, err := svc.Register(ctx, "new@example.org", "secreto123")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SendVerification(ctx, id, "es"); err != nil {
		t.Fatal(err)
	}
	verify, _ := box.Last()
	if err := svc.RequestPasswordReset(ctx, "new@example.org", "es"); err != nil {
		t.Fatal(err)
	}
	claim, _ := box.Last()
	if err := svc.VerifyEmail(ctx, claim.Token()); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("the claim link verified on /verify: %v", err)
	}
	if err := svc.VerifyEmail(ctx, verify.Token()); err != nil {
		t.Fatalf("a stranger's reset request killed the verification link: %v", err)
	}
	if p, _ := svc.Profile(ctx, id); !p.EmailVerified {
		t.Fatal("not verified")
	}
}

// And a verification email resent by the squatter does not kill the owner's claim link.
func TestResentVerificationKeepsTheClaimLink(t *testing.T) {
	ctx := context.Background()
	svc, _, box, _ := newMailService(t, nil)
	id, err := svc.Register(ctx, "victim@example.org", "squatter-pass")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestPasswordReset(ctx, "victim@example.org", "es"); err != nil {
		t.Fatal(err)
	}
	claim, _ := box.Last()
	if err := svc.SendVerification(ctx, id, "es"); err != nil {
		t.Fatal(err)
	}
	if err := svc.ResetPassword(ctx, claim.Token(), "owner-pass-1"); err != nil {
		t.Fatalf("a resent verification email killed the claim link: %v", err)
	}
	if p, _ := svc.Profile(ctx, id); !p.EmailVerified {
		t.Fatal("not verified after the claim")
	}
}

// Lote 16 review: the known-device cookies are signed with LoginStamp, so it must change
// with the password (a reset) and be empty for an unknown address.
func TestLoginStampChangesWithThePassword(t *testing.T) {
	ctx := context.Background()
	svc, repo, _, _ := newMailService(t, nil)
	if _, err := svc.Register(ctx, "ana@example.org", "secreto123"); err != nil {
		t.Fatal(err)
	}
	before, err := svc.LoginStamp(ctx, "Ana@example.org")
	if err != nil || before == "" {
		t.Fatalf("%q %v", before, err)
	}
	if again, _ := svc.LoginStamp(ctx, "ana@example.org"); again != before {
		t.Fatal("the stamp is not stable")
	}
	link, _, err := auth.IssueResetLink(ctx, repo, time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC), "https://game.example", "ana@example.org")
	if err != nil {
		t.Fatal(err)
	}
	_, token, _ := strings.Cut(link, "#token=")
	if err := svc.ResetPassword(ctx, token, "secreto123"); err != nil { // even the same password
		t.Fatal(err)
	}
	if after, _ := svc.LoginStamp(ctx, "ana@example.org"); after == before || after == "" {
		t.Fatalf("stamp %q after the reset, %q before", after, before)
	}
	if none, err := svc.LoginStamp(ctx, "nobody@example.org"); none != "" || err != nil {
		t.Fatalf("unknown address: %q %v", none, err)
	}
}
