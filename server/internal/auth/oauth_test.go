package auth_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/oauth"
	"github.com/GFenzoR/RPG_Project/server/internal/oauth/oauthtest"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

type oauthEnv struct {
	t    *testing.T
	svc  *auth.Service
	repo *authtest.Repo
	fake *oauthtest.Fake
	clk  *clock.Fake
	srv  *httptest.Server
}

func newOAuthEnv(t *testing.T) *oauthEnv {
	t.Helper()
	clk := clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	fake := oauthtest.New()
	fake.Now = clk.Now
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	fake.Base = srv.URL
	ep := fake.Endpoints()
	g, err := oauth.New(oauth.Google, oauth.Config{ClientID: oauthtest.ClientID, ClientSecret: oauthtest.ClientSecret,
		AuthURL: ep["GOOGLE_AUTH_URL"], TokenURL: ep["GOOGLE_TOKEN_URL"], JWKSURL: ep["GOOGLE_JWKS_URL"], Issuer: ep["GOOGLE_ISSUER"]})
	if err != nil {
		t.Fatal(err)
	}
	d, err := oauth.New(oauth.Discord, oauth.Config{ClientID: oauthtest.ClientID, ClientSecret: oauthtest.ClientSecret,
		AuthURL: ep["DISCORD_AUTH_URL"], TokenURL: ep["DISCORD_TOKEN_URL"], APIURL: ep["DISCORD_API_URL"]})
	if err != nil {
		t.Fatal(err)
	}
	repo := authtest.NewRepo()
	svc, err := auth.New(auth.Config{
		Repo: repo, OAuth: repo, Clock: clk, Vocations: testVocations,
		Hash:      auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
		PublicURL: "https://game.example", Providers: []*oauth.Provider{g, d},
	})
	if err != nil {
		t.Fatal(err)
	}
	return &oauthEnv{t: t, svc: svc, repo: repo, fake: fake, clk: clk, srv: srv}
}

// authorize follows the provider's authorization URL like a browser and returns the
// query of the redirect back to the game (code, state, error).
func (e *oauthEnv) authorize(authURL string) url.Values {
	e.t.Helper()
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := c.Get(authURL)
	if err != nil {
		e.t.Fatal(err)
	}
	_ = res.Body.Close()
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil || !strings.HasPrefix(loc.String(), "https://game.example/api/auth/oauth/") {
		e.t.Fatalf("redirect %q (status %d)", res.Header.Get("Location"), res.StatusCode)
	}
	return loc.Query()
}

// login runs a whole login with provider as u and returns the result.
func (e *oauthEnv) login(provider string, u oauthtest.User) (auth.OAuthResult, error) {
	e.t.Helper()
	e.fake.SetNext(provider, u)
	st, err := e.svc.StartLogin(context.Background(), provider, "/maps/submit")
	if err != nil {
		e.t.Fatal(err)
	}
	q := e.authorize(st.URL)
	return e.svc.FinishOAuth(context.Background(), provider, q.Get("state"), q.Get("code"), q.Get("error"), st.Binding)
}

func TestOAuthNewAccountAndReturningLogin(t *testing.T) {
	e := newOAuthEnv(t)
	ctx := context.Background()
	res, err := e.login(oauth.Google, oauthtest.User{Subject: "g-1", Email: "Ana@Example.org", Verified: true})
	if err != nil || res.Kind != "login" || res.ReturnTo != "/maps/submit" || res.Token.Token == "" {
		t.Fatalf("%+v %v", res, err)
	}
	p, _ := e.svc.Profile(ctx, res.Token.AccountID)
	if p.Email != "ana@example.org" || !p.EmailVerified || p.HasPassword {
		t.Fatalf("profile %+v", p)
	}
	if id, err := e.svc.Authenticate(ctx, res.Token.Token); err != nil || id != res.Token.AccountID {
		t.Fatal("the OAuth login is an ordinary session")
	}
	again, err := e.login(oauth.Google, oauthtest.User{Subject: "g-1", Email: "other@example.org", Verified: true})
	if err != nil || again.Token.AccountID != res.Token.AccountID {
		t.Fatalf("returning login: %+v %v", again, err)
	}
	// Discord with an email it does not vouch for: the account is not verified.
	d, err := e.login(oauth.Discord, oauthtest.User{Subject: "d-1", Email: "bob@example.org"})
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := e.svc.Profile(ctx, d.Token.AccountID); p.EmailVerified {
		t.Fatal("unverified provider email marked verified")
	}
	if _, err := e.login(oauth.Discord, oauthtest.User{Subject: "d-2"}); !errors.Is(err, auth.ErrNoEmail) {
		t.Fatalf("no email: %v", err)
	}
	if n := len(e.repo.Audit); n != 2 || e.repo.Audit[0].Action != store.AuditOAuthAccount {
		t.Fatalf("audit %+v", e.repo.Audit)
	}
	for _, a := range e.repo.Audit {
		for _, v := range a.Args {
			if strings.Contains(v, "@") {
				t.Fatal("email in the audit log")
			}
		}
	}
}

func TestOAuthNeverLinksByEmail(t *testing.T) {
	e := newOAuthEnv(t)
	ctx := context.Background()
	victim, _ := e.svc.Register(ctx, "ana@example.org", "secreto123")
	res, err := e.login(oauth.Google, oauthtest.User{Subject: "attacker", Email: "ana@example.org", Verified: true})
	if err != nil || res.Kind != "pending" || res.Pending == "" || res.Token.Token != "" {
		t.Fatalf("matching email must not log in: %+v %v", res, err)
	}
	if ids, _ := e.svc.Identities(ctx, victim); len(ids) != 0 {
		t.Fatal("linked without the password")
	}
	pi, err := e.svc.Pending(ctx, res.Pending)
	if err != nil || pi.Provider != oauth.Google || pi.Email != "ana@example.org" {
		t.Fatalf("pending %+v %v", pi, err)
	}
	if _, _, err := e.svc.ConfirmPending(ctx, res.Pending, "wrong-password"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("wrong password: %v", err)
	}
	tok, ret, err := e.svc.ConfirmPending(ctx, res.Pending, "secreto123")
	if err != nil || tok.AccountID != victim || ret != "/maps/submit" {
		t.Fatalf("confirm: %+v %v", tok, err)
	}
	if _, _, err := e.svc.ConfirmPending(ctx, res.Pending, "secreto123"); !errors.Is(err, auth.ErrPendingExpired) {
		t.Fatalf("pending reused: %v", err)
	}
	// From now on the identity logs straight in.
	direct, err := e.login(oauth.Google, oauthtest.User{Subject: "attacker", Email: "ana@example.org", Verified: true})
	if err != nil || direct.Kind != "login" || direct.Token.AccountID != victim {
		t.Fatalf("%+v %v", direct, err)
	}

	// Or the user creates another account with another email.
	_, _ = e.svc.Register(ctx, "carla@example.org", "secreto123")
	res, _ = e.login(oauth.Discord, oauthtest.User{Subject: "d-9", Email: "carla@example.org", Verified: true})
	if _, _, err := e.svc.CreateFromPending(ctx, res.Pending, "carla@example.org"); !errors.Is(err, auth.ErrEmailTaken) {
		t.Fatalf("same email: %v", err)
	}
	tok, _, err = e.svc.CreateFromPending(ctx, res.Pending, "carla.alt@example.org")
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := e.svc.Profile(ctx, tok.AccountID); p.Email != "carla.alt@example.org" || p.EmailVerified {
		t.Fatalf("profile %+v", p)
	}
	// Pending identities expire.
	res, _ = e.login(oauth.Google, oauthtest.User{Subject: "g-x", Email: "carla@example.org", Verified: true})
	e.clk.Advance(auth.OAuthPendingTTL)
	if _, err := e.svc.Pending(ctx, res.Pending); !errors.Is(err, auth.ErrPendingExpired) {
		t.Fatalf("expired pending: %v", err)
	}
}

func TestOAuthStateIsSingleUseBoundAndExpires(t *testing.T) {
	e := newOAuthEnv(t)
	ctx := context.Background()
	start := func() (auth.OAuthStart, url.Values) {
		e.fake.SetNext(oauth.Google, oauthtest.User{Subject: "g-1", Email: "a@example.org", Verified: true})
		st, err := e.svc.StartLogin(ctx, oauth.Google, "https://evil.example/")
		if err != nil {
			t.Fatal(err)
		}
		return st, e.authorize(st.URL)
	}
	st, q := start()
	if _, err := e.svc.FinishOAuth(ctx, oauth.Google, q.Get("state"), q.Get("code"), "", "another-browser"); !errors.Is(err, auth.ErrOAuthState) {
		t.Fatalf("wrong binding: %v", err)
	}
	// The failed try spent the state.
	if _, err := e.svc.FinishOAuth(ctx, oauth.Google, q.Get("state"), q.Get("code"), "", st.Binding); !errors.Is(err, auth.ErrOAuthState) {
		t.Fatalf("reused state: %v", err)
	}
	st, q = start()
	if _, err := e.svc.FinishOAuth(ctx, oauth.Discord, q.Get("state"), q.Get("code"), "", st.Binding); !errors.Is(err, auth.ErrOAuthState) {
		t.Fatalf("other provider's callback: %v", err)
	}
	st, q = start()
	e.clk.Advance(auth.OAuthStateTTL)
	if _, err := e.svc.FinishOAuth(ctx, oauth.Google, q.Get("state"), q.Get("code"), "", st.Binding); !errors.Is(err, auth.ErrOAuthState) {
		t.Fatalf("expired state: %v", err)
	}
	st, q = start()
	res, err := e.svc.FinishOAuth(ctx, oauth.Google, q.Get("state"), q.Get("code"), "", st.Binding)
	if err != nil || res.ReturnTo != auth.DefaultReturn {
		t.Fatalf("an outside return path must fall back: %+v %v", res, err)
	}
	// The PKCE verifier and the redirect_uri reached the provider (it checks both).
	e.fake.SetNext(oauth.Google, oauthtest.User{Deny: true})
	st, _ = e.svc.StartLogin(ctx, oauth.Google, "/")
	q = e.authorize(st.URL)
	if _, err := e.svc.FinishOAuth(ctx, oauth.Google, q.Get("state"), "", q.Get("error"), st.Binding); !errors.Is(err, auth.ErrOAuthDenied) {
		t.Fatalf("denied: %v", err)
	}
	if !strings.Contains(st.URL, "code_challenge_method=S256") || !strings.Contains(st.URL, "nonce=") ||
		!strings.Contains(st.URL, url.QueryEscape("https://game.example/api/auth/oauth/google/callback")) {
		t.Fatalf("auth URL %s", st.URL)
	}
}

func TestOAuthIDTokenChecks(t *testing.T) {
	for name, tamper := range map[string]func(map[string]any){
		"audience": func(c map[string]any) { c["aud"] = "someone-else" },
		"issuer":   func(c map[string]any) { c["iss"] = "https://evil.example" },
		"nonce":    func(c map[string]any) { c["nonce"] = "replayed" },
		"expired":  func(c map[string]any) { c["exp"] = c["iat"].(int64) - 3600 },
	} {
		t.Run(name, func(t *testing.T) {
			e := newOAuthEnv(t)
			e.fake.Tamper = tamper
			if _, err := e.login(oauth.Google, oauthtest.User{Subject: "g", Email: "a@example.org", Verified: true}); !errors.Is(err, auth.ErrOAuthProvider) {
				t.Fatalf("tampered %s accepted: %v", name, err)
			}
		})
	}
}

func TestLinkNeedsReauthAndUnlinkKeepsOneWayIn(t *testing.T) {
	e := newOAuthEnv(t)
	ctx := context.Background()
	id, _ := e.svc.Register(ctx, "ana@example.org", "secreto123")
	tok, _ := e.svc.Login(ctx, "ana@example.org", "secreto123")
	if _, err := e.svc.StartLink(ctx, tok.Token, oauth.Discord, ""); !errors.Is(err, auth.ErrReauthRequired) {
		t.Fatalf("link without the password: %v", err)
	}
	if _, err := e.svc.StartLink(ctx, tok.Token, oauth.Discord, "wrong-pass1"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("link with a wrong password: %v", err)
	}
	e.fake.SetNext(oauth.Discord, oauthtest.User{Subject: "d-ana", Email: "ana.discord@example.org", Verified: true})
	st, err := e.svc.StartLink(ctx, tok.Token, oauth.Discord, "secreto123")
	if err != nil {
		t.Fatal(err)
	}
	q := e.authorize(st.URL)
	res, err := e.svc.FinishOAuth(ctx, oauth.Discord, q.Get("state"), q.Get("code"), "", st.Binding)
	if err != nil || res.Kind != "linked" || res.ReturnTo != "/account" {
		t.Fatalf("%+v %v", res, err)
	}
	ids, _ := e.svc.Identities(ctx, id)
	if len(ids) != 1 || ids[0].Provider != oauth.Discord || ids[0].Email != "ana.discord@example.org" {
		t.Fatalf("identities %+v", ids)
	}
	// Another account cannot take that identity.
	_, _ = e.svc.Register(ctx, "bob@example.org", "secreto123")
	bob, _ := e.svc.Login(ctx, "bob@example.org", "secreto123")
	e.fake.SetNext(oauth.Discord, oauthtest.User{Subject: "d-ana", Email: "x@example.org"})
	st, _ = e.svc.StartLink(ctx, bob.Token, oauth.Discord, "secreto123")
	q = e.authorize(st.URL)
	if _, err := e.svc.FinishOAuth(ctx, oauth.Discord, q.Get("state"), q.Get("code"), "", st.Binding); !errors.Is(err, auth.ErrIdentityTaken) {
		t.Fatalf("taken identity: %v", err)
	}
	// With a password the identity can go.
	if err := e.svc.Unlink(ctx, id, oauth.Discord); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Unlink(ctx, id, oauth.Discord); !errors.Is(err, auth.ErrNotLinked) {
		t.Fatalf("unlink twice: %v", err)
	}

	// An OAuth-only account cannot unlink its only identity, and links with a recent login.
	res, _ = e.login(oauth.Google, oauthtest.User{Subject: "g-solo", Email: "solo@example.org", Verified: true})
	solo := res.Token.AccountID
	if err := e.svc.Unlink(ctx, solo, oauth.Google); !errors.Is(err, auth.ErrLastLoginMethod) {
		t.Fatalf("last method: %v", err)
	}
	e.clk.Advance(auth.ReauthWindow + time.Second)
	if _, err := e.svc.StartLink(ctx, res.Token.Token, oauth.Discord, ""); !errors.Is(err, auth.ErrReauthRequired) {
		t.Fatalf("old session: %v", err)
	}
	fresh, _ := e.login(oauth.Google, oauthtest.User{Subject: "g-solo", Email: "solo@example.org", Verified: true})
	e.fake.SetNext(oauth.Discord, oauthtest.User{Subject: "d-solo", Email: "solo@example.org", Verified: true})
	st, err = e.svc.StartLink(ctx, fresh.Token.Token, oauth.Discord, "")
	if err != nil {
		t.Fatal(err)
	}
	q = e.authorize(st.URL)
	if _, err := e.svc.FinishOAuth(ctx, oauth.Discord, q.Get("state"), q.Get("code"), "", st.Binding); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Unlink(ctx, solo, oauth.Google); err != nil {
		t.Fatalf("a second identity is a way in: %v", err)
	}
	if err := e.svc.Unlink(ctx, solo, oauth.Discord); !errors.Is(err, auth.ErrLastLoginMethod) {
		t.Fatalf("last method again: %v", err)
	}
}

func TestSafeReturn(t *testing.T) {
	for in, want := range map[string]string{
		"/play/": "/play/", "/account": "/account", "//evil.example": "/play/", "https://evil.example": "/play/",
		"/play/../x": "/play/", "": "/play/", "/maps/mine": "/maps/mine",
	} {
		if got := auth.SafeReturn(in); got != want {
			t.Errorf("SafeReturn(%q) = %q, want %q", in, got, want)
		}
	}
}

// Someone squats an address through a provider that does not vouch for it; once the
// address's owner takes the account back with a password reset, that identity is gone.
func TestResetDropsIdentitiesThatNeverProvedTheEmail(t *testing.T) {
	e := newOAuthEnv(t)
	ctx := context.Background()
	res, err := e.login(oauth.Discord, oauthtest.User{Subject: "squatter", Email: "victim@example.org", Verified: false})
	if err != nil || res.Kind != "login" {
		t.Fatalf("%+v %v", res, err)
	}
	id := res.Token.AccountID
	e.repo.SetVerified(id) // the owner verified the address from the email they got
	now := e.clk.Now()
	link, _, err := auth.IssueResetLink(ctx, e.repo, now, "https://game.example", "victim@example.org")
	if err != nil {
		t.Fatal(err)
	}
	_, token, _ := strings.Cut(link, "#token=")
	if err := e.svc.ResetPassword(ctx, token, "owner-password-1"); err != nil {
		t.Fatal(err)
	}
	if ids, _ := e.svc.Identities(ctx, id); len(ids) != 0 {
		t.Fatalf("the squatter's identity survived: %+v", ids)
	}
	if res, _ := e.login(oauth.Discord, oauthtest.User{Subject: "squatter", Email: "victim@example.org"}); res.Kind == "login" && res.Token.AccountID == id {
		t.Fatal("the squatter still logs in")
	}
}

func TestPendingSaysWhetherTheAccountHasAPassword(t *testing.T) {
	e := newOAuthEnv(t)
	ctx := context.Background()
	if _, err := e.login(oauth.Google, oauthtest.User{Subject: "g", Email: "solo@example.org", Verified: true}); err != nil {
		t.Fatal(err)
	}
	res, _ := e.login(oauth.Discord, oauthtest.User{Subject: "d", Email: "solo@example.org", Verified: true})
	p, err := e.svc.Pending(ctx, res.Pending)
	if err != nil || p.HasPassword {
		t.Fatalf("%+v %v", p, err)
	}
}
