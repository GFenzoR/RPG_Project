package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
)

type harness struct {
	t     *testing.T
	h     http.Handler
	clock *clock.Fake
}

func newHarness(t *testing.T, mutate func(*httpapi.Config)) *harness {
	t.Helper()
	clk := clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	svc, err := auth.New(auth.Config{
		Repo:  authtest.NewRepo(),
		Clock: clk,
		Vocations: content.Vocations{
			"guardian": {ID: "guardian", Start: content.VocationStats{Health: 150, Mana: 30}},
		},
		Hash: auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := httpapi.Config{Auth: svc, Clock: clk, CookieSecure: true}
	if mutate != nil {
		mutate(&cfg)
	}
	h, err := httpapi.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, h: h, clock: clk}
}

type req struct {
	method, path, body, token, cookie, contentType, remote, xff string
}

func (h *harness) do(r req) *httptest.ResponseRecorder {
	h.t.Helper()
	hr := httptest.NewRequest(r.method, r.path, strings.NewReader(r.body))
	if r.body != "" {
		ct := r.contentType
		if ct == "" {
			ct = "application/json"
		}
		hr.Header.Set("Content-Type", ct)
	}
	if r.token != "" {
		hr.Header.Set("Authorization", "Bearer "+r.token)
	}
	if r.cookie != "" {
		hr.AddCookie(&http.Cookie{Name: httpapi.SessionCookie, Value: r.cookie})
	}
	if r.remote != "" {
		hr.RemoteAddr = r.remote
	}
	if r.xff != "" {
		hr.Header.Set("X-Forwarded-For", r.xff)
	}
	w := httptest.NewRecorder()
	h.h.ServeHTTP(w, hr)
	return w
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var b struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		t.Fatalf("decode error body %q: %v", w.Body.String(), err)
	}
	return b.Error.Code
}

func expect(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", w.Code, status, w.Body.String())
	}
	if code != "" {
		if got := errorCode(t, w); got != code {
			t.Fatalf("code = %q, want %q", got, code)
		}
	}
}

func (h *harness) login(email, pw string) string {
	h.t.Helper()
	w := h.do(req{method: "POST", path: "/api/auth/login", body: `{"email":"` + email + `","password":"` + pw + `","token_in_body":true}`})
	expect(h.t, w, http.StatusOK, "")
	var b struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil || b.Token == "" {
		h.t.Fatalf("login body %s: %v", w.Body.String(), err)
	}
	return b.Token
}

func TestFullFlow(t *testing.T) {
	h := newHarness(t, nil)
	creds := `{"email":"ana@example.org","password":"secreto123"}`

	w := h.do(req{method: "POST", path: "/api/auth/register", body: creds})
	expect(t, w, http.StatusCreated, "")
	if !strings.Contains(w.Body.String(), `"account_id":1`) {
		t.Fatalf("register body %s", w.Body.String())
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: creds}), http.StatusConflict, "email_taken")

	// Login sets the token in the body and in a hardened cookie.
	w = h.do(req{method: "POST", path: "/api/auth/login", body: creds})
	expect(t, w, http.StatusOK, "")
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure ||
		cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != "/api" {
		t.Fatalf("cookie %+v", cookies)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("token response must not be cached")
	}
	if strings.Contains(w.Body.String(), "token") {
		t.Fatalf("web login must not expose the token in the body: %s", w.Body.String())
	}
	token := cookies[0].Value

	// Empty list, create, list again (bearer and cookie both work).
	w = h.do(req{method: "GET", path: "/api/characters", token: token})
	expect(t, w, http.StatusOK, "")
	if strings.TrimSpace(w.Body.String()) != `{"characters":[]}` {
		t.Fatalf("empty list body %s", w.Body.String())
	}
	w = h.do(req{method: "POST", path: "/api/characters", cookie: token, body: `{"name":"Mira","vocation":"guardian"}`})
	expect(t, w, http.StatusCreated, "")
	w = h.do(req{method: "GET", path: "/api/characters", cookie: token})
	expect(t, w, http.StatusOK, "")
	want := `{"characters":[{"id":2,"name":"Mira","vocation":"guardian","level":1}]}`
	if strings.TrimSpace(w.Body.String()) != want {
		t.Fatalf("list body %s, want %s", w.Body.String(), want)
	}

	// Logout revokes the token and clears the cookie.
	w = h.do(req{method: "POST", path: "/api/auth/logout", token: token})
	expect(t, w, http.StatusNoContent, "")
	if c := w.Result().Cookies(); len(c) != 1 || c[0].MaxAge >= 0 {
		t.Fatalf("logout cookie %+v", c)
	}
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: token}), http.StatusUnauthorized, "unauthorized")
}

func TestErrors(t *testing.T) {
	h := newHarness(t, nil)
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`}), http.StatusCreated, "")
	token := h.login("ana@example.org", "secreto123")

	cases := []struct {
		name   string
		r      req
		status int
		code   string
	}{
		{"bad email", req{method: "POST", path: "/api/auth/register", body: `{"email":"x","password":"secreto123"}`}, 400, "invalid_email"},
		{"short password", req{method: "POST", path: "/api/auth/register", body: `{"email":"b@example.org","password":"x"}`}, 400, "invalid_password"},
		{"wrong password", req{method: "POST", path: "/api/auth/login", body: `{"email":"ana@example.org","password":"nopenope"}`}, 401, "invalid_credentials"},
		{"form post", req{method: "POST", path: "/api/auth/login", body: `email=a`, contentType: "application/x-www-form-urlencoded"}, 415, "unsupported_media_type"},
		{"no content type", req{method: "POST", path: "/api/characters", token: token}, 415, "unsupported_media_type"},
		{"malformed json", req{method: "POST", path: "/api/auth/login", body: `{"email":`}, 400, "bad_request"},
		{"unknown field", req{method: "POST", path: "/api/auth/login", body: `{"email":"a","password":"b","admin":true}`}, 400, "bad_request"},
		{"trailing data", req{method: "POST", path: "/api/auth/login", body: `{"email":"a","password":"b"}{}`}, 400, "bad_request"},
		{"too large", req{method: "POST", path: "/api/auth/login", body: `{"email":"` + strings.Repeat("a", 5000) + `"}`}, 400, "bad_request"},
		{"no token", req{method: "GET", path: "/api/characters"}, 401, "unauthorized"},
		{"bad token", req{method: "GET", path: "/api/characters", token: "nope"}, 401, "unauthorized"},
		{"not bearer", req{method: "GET", path: "/api/characters", token: ""}, 401, "unauthorized"},
		{"invalid name", req{method: "POST", path: "/api/characters", token: token, body: `{"name":"x","vocation":"guardian"}`}, 400, "invalid_name"},
		{"invalid vocation", req{method: "POST", path: "/api/characters", token: token, body: `{"name":"Mira","vocation":"pirate"}`}, 400, "invalid_vocation"},
		{"unknown api path", req{method: "GET", path: "/api/nope"}, 404, "not_found"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { expect(t, h.do(c.r), c.status, c.code) })
	}

	expect(t, h.do(req{method: "POST", path: "/api/characters", token: token, body: `{"name":"Mira","vocation":"guardian"}`}), 201, "")
	expect(t, h.do(req{method: "POST", path: "/api/characters", token: token, body: `{"name":"MIRA","vocation":"guardian"}`}), 400, "invalid_name")
	expect(t, h.do(req{method: "POST", path: "/api/characters", token: token, body: `{"name":"Mira","vocation":"guardian"}`}), 409, "name_taken")
}

func TestTokenExpires(t *testing.T) {
	h := newHarness(t, nil)
	h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`})
	token := h.login("ana@example.org", "secreto123")
	h.clock.Advance(auth.DefaultAccountTokenTTL)
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: token}), 401, "unauthorized")
}

func TestAuthRateLimitPerIP(t *testing.T) {
	h := newHarness(t, func(c *httpapi.Config) {
		c.AuthRateLimit = httpapi.RateLimit{Burst: 3, Every: time.Minute}
	})
	bad := `{"email":"ana@example.org","password":"wrongpass"}`
	for range 3 {
		expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "1.2.3.4:1000"}), 401, "invalid_credentials")
	}
	w := h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "1.2.3.4:1001"})
	expect(t, w, http.StatusTooManyRequests, "rate_limited")
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After")
	}
	// Register shares the bucket; another IP is unaffected.
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: bad, remote: "1.2.3.4:1"}), 429, "rate_limited")
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "5.6.7.8:1"}), 401, "invalid_credentials")
	// One token comes back per interval.
	h.clock.Advance(time.Minute)
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "1.2.3.4:1"}), 401, "invalid_credentials")
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "1.2.3.4:1"}), 429, "rate_limited")
	// X-Forwarded-For is ignored unless TrustProxy is on.
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "1.2.3.4:1", xff: "9.9.9.9"}), 429, "rate_limited")
}

func TestLoginRateLimitPerEmail(t *testing.T) {
	h := newHarness(t, func(c *httpapi.Config) {
		c.LoginEmailRateLimit = httpapi.RateLimit{Burst: 2, Every: time.Minute}
	})
	bad := `{"email":"Ana@example.org","password":"wrongpass"}`
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "1.1.1.1:1"}), 401, "")
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "2.2.2.2:1"}), 401, "")
	// Third attempt on the same (normalized) email from yet another IP is limited.
	w := h.do(req{method: "POST", path: "/api/auth/login", body: `{"email":"ana@example.org","password":"x"}`, remote: "3.3.3.3:1"})
	expect(t, w, 429, "rate_limited")
	if w.Header().Get("Retry-After") != "60" {
		t.Fatalf("Retry-After = %q, want 60", w.Header().Get("Retry-After"))
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: `{"email":"bob@example.org","password":"x"}`, remote: "3.3.3.3:1"}), 401, "")
}

func TestRateLimitIPv6SharesSlash64(t *testing.T) {
	h := newHarness(t, func(c *httpapi.Config) {
		c.AuthRateLimit = httpapi.RateLimit{Burst: 1, Every: time.Hour}
	})
	bad := `{"email":"ana@example.org","password":"wrongpass"}`
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "[2001:db8:1:2::1]:1"}), 401, "")
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "[2001:db8:1:2:ffff::9]:1"}), 429, "rate_limited")
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "[2001:db8:1:3::1]:1"}), 401, "")
}

func TestRateLimitTrustProxyUsesLastHop(t *testing.T) {
	h := newHarness(t, func(c *httpapi.Config) {
		c.AuthRateLimit = httpapi.RateLimit{Burst: 1, Every: time.Hour}
		c.TrustProxy = true
	})
	bad := `{"email":"ana@example.org","password":"wrongpass"}`
	proxy := "10.0.0.1:443"
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: proxy, xff: "spoofed, 1.1.1.1"}), 401, "")
	// The spoofable first entry changes, the hop added by the proxy does not: limited.
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: proxy, xff: "other, 1.1.1.1"}), 429, "rate_limited")
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: proxy, xff: "2.2.2.2"}), 401, "")
}

func TestHealthz(t *testing.T) {
	var down error
	h := newHarness(t, func(c *httpapi.Config) {
		c.Health = func(context.Context) error { return down }
	})
	expect(t, h.do(req{method: "GET", path: "/healthz"}), 200, "")
	down = errors.New("db down")
	expect(t, h.do(req{method: "GET", path: "/healthz"}), 503, "unavailable")
}
