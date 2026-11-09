package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/oauth"
	"github.com/GFenzoR/RPG_Project/server/internal/oauth/oauthtest"
)

type oauthHarness struct {
	t    *testing.T
	h    http.Handler
	fake *oauthtest.Fake
	repo *authtest.Repo
	jar  map[string]string // the browser's cookies (name → value)
}

func newOAuthHarness(t *testing.T) *oauthHarness {
	t.Helper()
	clk := clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	fake := oauthtest.New()
	fake.Now = clk.Now
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	fake.Base = srv.URL
	ep := fake.Endpoints()
	g, _ := oauth.New(oauth.Google, oauth.Config{ClientID: oauthtest.ClientID, ClientSecret: oauthtest.ClientSecret,
		AuthURL: ep["GOOGLE_AUTH_URL"], TokenURL: ep["GOOGLE_TOKEN_URL"], JWKSURL: ep["GOOGLE_JWKS_URL"], Issuer: ep["GOOGLE_ISSUER"]})
	d, _ := oauth.New(oauth.Discord, oauth.Config{ClientID: oauthtest.ClientID, ClientSecret: oauthtest.ClientSecret,
		AuthURL: ep["DISCORD_AUTH_URL"], TokenURL: ep["DISCORD_TOKEN_URL"], APIURL: ep["DISCORD_API_URL"]})
	repo := authtest.NewRepo()
	svc, err := auth.New(auth.Config{
		Repo: repo, OAuth: repo, Clock: clk,
		Vocations: content.Vocations{"guardian": {ID: "guardian"}},
		Hash:      auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
		PublicURL: "https://game.example", Providers: []*oauth.Provider{g, d},
	})
	if err != nil {
		t.Fatal(err)
	}
	h, err := httpapi.New(httpapi.Config{Auth: svc, Clock: clk, CookieSecure: true})
	if err != nil {
		t.Fatal(err)
	}
	return &oauthHarness{t: t, h: h, fake: fake, repo: repo, jar: map[string]string{}}
}

// do sends a request with the jar's cookies and stores the cookies it sets.
func (o *oauthHarness) do(method, path, body string) *httptest.ResponseRecorder {
	o.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range o.jar {
		r.AddCookie(&http.Cookie{Name: k, Value: v})
	}
	w := httptest.NewRecorder()
	o.h.ServeHTTP(w, r)
	for _, c := range w.Result().Cookies() {
		if c.MaxAge < 0 {
			delete(o.jar, c.Name)
		} else {
			o.jar[c.Name] = c.Value
		}
	}
	return w
}

// login runs a browser through start → provider → callback and returns the callback's
// redirect target.
func (o *oauthHarness) login(provider string, u oauthtest.User, returnTo string) string {
	o.t.Helper()
	o.fake.SetNext(provider, u)
	w := o.do("POST", "/api/auth/oauth/"+provider+"/start", `{"return":"`+returnTo+`"}`)
	if w.Code != http.StatusOK {
		o.t.Fatalf("start %d %s", w.Code, w.Body.String())
	}
	c := w.Result().Cookies()[0]
	if c.Name != httpapi.OAuthCookie || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/api/auth/oauth" || c.MaxAge != 600 {
		o.t.Fatalf("binding cookie %+v", c)
	}
	var b struct{ URL string }
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	return o.callback(b.URL)
}

func (o *oauthHarness) callback(authURL string) string {
	o.t.Helper()
	cl := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := cl.Get(authURL)
	if err != nil {
		o.t.Fatal(err)
	}
	_ = res.Body.Close()
	back, _ := url.Parse(res.Header.Get("Location"))
	if back.Host != "game.example" {
		o.t.Fatalf("redirect_uri %s", back)
	}
	w := o.do("GET", back.RequestURI(), "")
	if w.Code != http.StatusSeeOther {
		o.t.Fatalf("callback %d", w.Code)
	}
	return w.Header().Get("Location")
}

func TestOAuthLoginOverHTTP(t *testing.T) {
	o := newOAuthHarness(t)
	w := o.do("GET", "/api/auth/config", "")
	if strings.TrimSpace(w.Body.String()) != `{"email":false,"providers":["discord","google"],"public_url":"https://game.example"}` || strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("config %s", w.Body.String())
	}
	if loc := o.login(oauth.Google, oauthtest.User{Subject: "g1", Email: "ana@example.org", Verified: true}, "/maps/mine"); loc != "/maps/mine" {
		t.Fatalf("landed on %s", loc)
	}
	if _, ok := o.jar[httpapi.OAuthCookie]; ok {
		t.Fatal("the binding cookie survived the callback")
	}
	// The same session cookie as a password login.
	w = o.do("GET", "/api/account", "")
	var acc struct {
		Email       string
		HasPassword bool `json:"has_password"`
		Identities  []struct{ Provider, Email string }
	}
	_ = json.Unmarshal(w.Body.Bytes(), &acc)
	if w.Code != http.StatusOK || acc.Email != "ana@example.org" || acc.HasPassword || len(acc.Identities) != 1 || acc.Identities[0].Provider != "google" {
		t.Fatalf("account %d %s", w.Code, w.Body.String())
	}
	// The last way in cannot be unlinked.
	w = o.do("POST", "/api/account/unlink", `{"provider":"google"}`)
	expect(t, w, http.StatusConflict, "last_login_method")
}

func TestOAuthCallbackErrorsAndOpenRedirect(t *testing.T) {
	o := newOAuthHarness(t)
	if loc := o.login(oauth.Discord, oauthtest.User{Subject: "d1", Email: "a@example.org"}, "https://evil.example/x"); loc != "/play/" {
		t.Fatalf("open redirect: %s", loc)
	}
	if loc := o.login(oauth.Google, oauthtest.User{Deny: true}, "/"); loc != "/oauth/error?code=denied" {
		t.Fatalf("denied: %s", loc)
	}
	// A callback without the browser's cookie (CSRF login) fails cleanly.
	o.fake.SetNext(oauth.Google, oauthtest.User{Subject: "g2", Email: "b@example.org", Verified: true})
	w := o.do("POST", "/api/auth/oauth/google/start", `{}`)
	var b struct{ URL string }
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	delete(o.jar, httpapi.OAuthCookie)
	if loc := o.callback(b.URL); loc != "/oauth/error?code=state" {
		t.Fatalf("no binding cookie: %s", loc)
	}
	w = o.do("GET", "/api/auth/oauth/google/callback?state=forged&code=x", "")
	if w.Header().Get("Location") != "/oauth/error?code=state" {
		t.Fatalf("forged state: %s", w.Header().Get("Location"))
	}
	expect(t, o.do("POST", "/api/auth/oauth/github/start", `{}`), http.StatusNotFound, "unknown_provider")
}

func TestOAuthPendingOverHTTP(t *testing.T) {
	o := newOAuthHarness(t)
	w := o.do("POST", "/api/auth/register", `{"email":"ana@example.org","password":"long-password-1"}`)
	expect(t, w, http.StatusCreated, "")
	if loc := o.login(oauth.Google, oauthtest.User{Subject: "g1", Email: "ana@example.org", Verified: true}, "/account"); loc != "/oauth/confirm" {
		t.Fatalf("landed on %s", loc)
	}
	if _, ok := o.jar[httpapi.SessionCookie]; ok {
		t.Fatal("logged in without the password")
	}
	w = o.do("GET", "/api/auth/oauth/pending", "")
	if strings.TrimSpace(w.Body.String()) != `{"email":"ana@example.org","has_password":true,"provider":"google"}` {
		t.Fatalf("pending %s", w.Body.String())
	}
	expect(t, o.do("POST", "/api/auth/oauth/pending/confirm", `{"password":"wrong-password"}`), http.StatusUnauthorized, "invalid_credentials")
	w = o.do("POST", "/api/auth/oauth/pending/confirm", `{"password":"long-password-1"}`)
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"return":"/account"}` {
		t.Fatalf("confirm %d %s", w.Code, w.Body.String())
	}
	if _, ok := o.jar[httpapi.SessionCookie]; !ok {
		t.Fatal("no session after confirming")
	}
	if _, ok := o.jar[httpapi.PendingCookie]; ok {
		t.Fatal("pending cookie kept")
	}
	expect(t, o.do("GET", "/api/auth/oauth/pending", ""), http.StatusGone, "pending_expired")
	// Linked and audited, without the email.
	w = o.do("POST", "/api/account/unlink", `{"provider":"google"}`)
	expect(t, w, http.StatusNoContent, "")
	for _, a := range o.repo.Audit {
		if strings.Contains(a.TargetName+a.ActorName, "@") {
			t.Fatalf("email in audit %+v", a)
		}
	}
}

func TestLinkOverHTTPNeedsPassword(t *testing.T) {
	o := newOAuthHarness(t)
	o.do("POST", "/api/auth/register", `{"email":"ana@example.org","password":"long-password-1"}`)
	expect(t, o.do("POST", "/api/auth/login", `{"email":"ana@example.org","password":"long-password-1"}`), http.StatusOK, "")
	expect(t, o.do("POST", "/api/auth/oauth/discord/link", `{}`), http.StatusForbidden, "reauth_required")
	expect(t, o.do("POST", "/api/auth/oauth/discord/link", `{"password":"wrong-password-1"}`), http.StatusUnauthorized, "invalid_credentials")
	o.fake.SetNext(oauth.Discord, oauthtest.User{Subject: "d1", Email: "ana@example.org", Verified: true})
	w := o.do("POST", "/api/auth/oauth/discord/link", `{"password":"long-password-1"}`)
	var b struct{ URL string }
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	if loc := o.callback(b.URL); loc != "/account?linked=discord" {
		t.Fatalf("link landed on %s", loc)
	}
	delete(o.jar, httpapi.SessionCookie)
	expect(t, o.do("POST", "/api/auth/oauth/discord/link", `{"password":"long-password-1"}`), http.StatusUnauthorized, "unauthorized")
}
