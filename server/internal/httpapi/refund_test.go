package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// fakeAccounts answers Login with whatever the test sets.
type fakeAccounts struct {
	login func() (auth.Token, error)
}

func (f *fakeAccounts) Login(context.Context, string, string) (auth.Token, error) { return f.login() }
func (*fakeAccounts) Register(context.Context, string, string) (int64, error)     { return 0, nil }
func (*fakeAccounts) Authenticate(context.Context, string) (int64, error) {
	return 0, auth.ErrUnauthorized
}
func (*fakeAccounts) Logout(context.Context, string) error { return nil }
func (*fakeAccounts) Characters(context.Context, int64) ([]store.Character, error) {
	return nil, nil
}
func (*fakeAccounts) IssuePlayToken(context.Context, int64, int64) (auth.Token, error) {
	return auth.Token{}, nil
}
func (*fakeAccounts) CreateCharacter(context.Context, int64, string, string) (store.Character, error) {
	return store.Character{}, nil
}

func (*fakeAccounts) EmailEnabled() bool { return false }
func (*fakeAccounts) Profile(context.Context, int64) (store.Profile, error) {
	return store.Profile{}, nil
}
func (*fakeAccounts) RequireVerified(context.Context, int64) error               { return nil }
func (*fakeAccounts) SendVerification(context.Context, int64, string) error      { return nil }
func (*fakeAccounts) VerifyEmail(context.Context, string) error                  { return nil }
func (*fakeAccounts) RequestPasswordReset(context.Context, string, string) error { return nil }
func (*fakeAccounts) ResetPassword(context.Context, string, string) error        { return nil }

func (*fakeAccounts) Providers() []string { return nil }
func (*fakeAccounts) StartLogin(context.Context, string, string) (auth.OAuthStart, error) {
	return auth.OAuthStart{}, nil
}
func (*fakeAccounts) StartLink(context.Context, string, string, string) (auth.OAuthStart, error) {
	return auth.OAuthStart{}, nil
}
func (*fakeAccounts) FinishOAuth(context.Context, string, string, string, string, string) (auth.OAuthResult, error) {
	return auth.OAuthResult{}, nil
}
func (*fakeAccounts) Pending(context.Context, string) (auth.PendingIdentity, error) {
	return auth.PendingIdentity{}, nil
}
func (*fakeAccounts) ConfirmPending(context.Context, string, string) (auth.Token, string, error) {
	return auth.Token{}, "", nil
}
func (*fakeAccounts) CreateFromPending(context.Context, string, string) (auth.Token, string, error) {
	return auth.Token{}, "", nil
}
func (*fakeAccounts) Identities(context.Context, int64) ([]store.Identity, error) { return nil, nil }
func (*fakeAccounts) Unlink(context.Context, int64, string) error                 { return nil }

func wrongPassword() (auth.Token, error) { return auth.Token{}, auth.ErrInvalidCredentials }

// newRefundHarness: pair and email budgets of 1 that never refill during the test, and
// a per-IP limit loose enough not to interfere.
func newRefundHarness(t *testing.T, f *fakeAccounts) (http.Handler, *clock.Fake) {
	t.Helper()
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	h, err := httpapi.New(httpapi.Config{
		Auth:                f,
		Clock:               clk,
		AuthRateLimit:       httpapi.RateLimit{Burst: 1000, Every: time.Millisecond},
		LoginPairRateLimit:  httpapi.RateLimit{Burst: 1, Every: 24 * time.Hour},
		LoginEmailRateLimit: httpapi.RateLimit{Burst: 1, Every: time.Hour},
	})
	if err != nil {
		t.Fatal(err)
	}
	return h, clk
}

func loginFrom(t *testing.T, h http.Handler, remote string) int {
	t.Helper()
	hh := &harness{t: t, h: h}
	return hh.do(req{method: "POST", path: "/api/auth/login", body: `{"email":"ana@example.org","password":"plausible1"}`, remote: remote}).Code
}

// expectBudgetsIntact: one wrong password still fits in both budgets, the next does not.
func expectBudgetsIntact(t *testing.T, h http.Handler, f *fakeAccounts, remote string) {
	t.Helper()
	f.login = wrongPassword
	if got := loginFrom(t, h, remote); got != http.StatusUnauthorized {
		t.Fatalf("budget was spent: first wrong password got %d, want 401", got)
	}
	if got := loginFrom(t, h, remote); got != http.StatusTooManyRequests {
		t.Fatalf("second wrong password got %d, want 429", got)
	}
}

// TestLoginRefundsOnEveryNonPasswordOutcome: only a wrong password spends the pair and
// email budgets; every other outcome gives the reserved tokens back.
func TestLoginRefundsOnEveryNonPasswordOutcome(t *testing.T) {
	cases := map[string]struct {
		login  func() (auth.Token, error)
		status int
	}{
		"success":  {func() (auth.Token, error) { return auth.Token{Token: "t", ExpiresAt: time.Unix(1, 0)}, nil }, 200},
		"busy":     {func() (auth.Token, error) { return auth.Token{}, auth.ErrBusy }, 503},
		"disabled": {func() (auth.Token, error) { return auth.Token{}, auth.ErrAccountDisabled }, 403},
		"internal": {func() (auth.Token, error) { return auth.Token{}, errors.New("db down") }, 500},
		"panic": {func() (auth.Token, error) {
			var none []int
			_ = none[len(none)+1] // real runtime panic inside Login
			return auth.Token{}, nil
		}, 500},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := &fakeAccounts{login: c.login}
			h, _ := newRefundHarness(t, f)
			for range 3 {
				if got := loginFrom(t, h, "1.1.1.1:1"); got != c.status {
					t.Fatalf("status %d, want %d", got, c.status)
				}
			}
			expectBudgetsIntact(t, h, f, "1.1.1.1:1")
		})
	}
}

// TestEmailLimitRejectionRefundsPair: a request stopped by the per-email limit gives
// back the pair token it had reserved.
func TestEmailLimitRejectionRefundsPair(t *testing.T) {
	f := &fakeAccounts{login: wrongPassword}
	h, clk := newRefundHarness(t, f)
	if got := loginFrom(t, h, "1.1.1.1:1"); got != 401 { // spends the email budget
		t.Fatalf("got %d", got)
	}
	for range 3 { // from another IP: email-limited, pair reserved then refunded
		if got := loginFrom(t, h, "2.2.2.2:1"); got != 429 {
			t.Fatalf("got %d, want 429", got)
		}
	}
	clk.Advance(time.Hour) // the email budget refills; the pair budgets (24 h) do not
	expectBudgetsIntact(t, h, f, "2.2.2.2:1")
}
