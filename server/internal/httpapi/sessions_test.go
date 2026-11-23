package httpapi_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
)

// Lote 17 (owner decision 2026-11-23): the game never keeps the login.

func sessionSetCookie(t *testing.T, w interface{ Header() http.Header }) string {
	t.Helper()
	for _, v := range w.Header().Values("Set-Cookie") {
		if strings.HasPrefix(v, httpapi.SessionCookie+"=") {
			return v
		}
	}
	t.Fatal("no session cookie set")
	return ""
}

func TestSessionCookieIsABrowserSessionCookie(t *testing.T) {
	h := newHarness(t, nil)
	creds := `{"email":"ana@example.org","password":"secreto123"}`
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: creds}), http.StatusCreated, "")
	w := h.do(req{method: "POST", path: "/api/auth/login", body: creds})
	expect(t, w, http.StatusOK, "")
	raw := sessionSetCookie(t, w)
	for _, attr := range []string{"Max-Age", "Expires"} {
		if strings.Contains(raw, attr) {
			t.Fatalf("session cookie has %s (it must die with the browser): %s", attr, raw)
		}
	}
	for _, attr := range []string{"HttpOnly", "Secure", "SameSite=Strict", "Path=/api"} {
		if !strings.Contains(raw, attr) {
			t.Fatalf("session cookie lost %s: %s", attr, raw)
		}
	}
}

func TestIdleSessionAndKeepalive(t *testing.T) {
	h := newHarness(t, nil)
	h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`})
	playing := h.login("ana@example.org", "secreto123")
	idle := h.login("ana@example.org", "secreto123")
	// While the game runs the client sends a keepalive every few minutes: that session
	// survives an hour; the other one goes idle.
	for range 12 {
		h.clock.Advance(5 * time.Minute)
		expect(t, h.do(req{method: "POST", path: "/api/auth/keepalive", token: playing}), http.StatusNoContent, "")
	}
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: playing}), http.StatusOK, "")
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: idle}), http.StatusUnauthorized, "unauthorized")
	expect(t, h.do(req{method: "POST", path: "/api/auth/keepalive", token: idle}), http.StatusUnauthorized, "unauthorized")
	h.clock.Advance(auth.DefaultSessionIdle)
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: playing}), http.StatusUnauthorized, "unauthorized")
}

func TestLogoutAll(t *testing.T) {
	h := newHarness(t, nil)
	h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`})
	h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"bob@example.org","password":"secreto123"}`})
	web := h.login("ana@example.org", "secreto123")
	desktop := h.login("ana@example.org", "secreto123")
	bob := h.login("bob@example.org", "secreto123")
	w := h.do(req{method: "POST", path: "/api/characters", token: web, body: `{"name":"Mira","vocation":"guardian"}`})
	expect(t, w, http.StatusCreated, "")
	w = h.do(req{method: "POST", path: "/api/play", token: desktop, body: `{"character_id":3}`})
	expect(t, w, http.StatusOK, "")

	expect(t, h.do(req{method: "POST", path: "/api/auth/logout-all"}), http.StatusUnauthorized, "unauthorized")
	w = h.do(req{method: "POST", path: "/api/auth/logout-all", cookie: web})
	expect(t, w, http.StatusNoContent, "")
	if c := sessionSetCookie(t, w); !strings.Contains(c, "Max-Age=0") {
		t.Fatalf("the cookie was not cleared: %s", c)
	}
	for _, tok := range []string{web, desktop} {
		expect(t, h.do(req{method: "GET", path: "/api/characters", token: tok}), http.StatusUnauthorized, "unauthorized")
	}
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: bob}), http.StatusOK, "")
}

func TestChangePasswordEndpoint(t *testing.T) {
	h := newHarness(t, func(c *httpapi.Config) {
		c.LoginPairRateLimit = httpapi.RateLimit{Burst: 2, Every: 40 * time.Minute}
	})
	h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`})
	current := h.login("ana@example.org", "secreto123")
	other := h.login("ana@example.org", "secreto123")
	change := func(tok, cur, next string) *req {
		return &req{method: "POST", path: "/api/account/password", cookie: tok,
			body: `{"current_password":"` + cur + `","new_password":"` + next + `"}`}
	}

	expect(t, h.do(*change("", "secreto123", "nuevaclave9")), http.StatusUnauthorized, "unauthorized")
	expect(t, h.do(*change(current, "secreto123", "short")), http.StatusBadRequest, "invalid_password")
	expect(t, h.do(*change(current, "", "nuevaclave9")), http.StatusForbidden, "reauth_required")
	expect(t, h.do(*change(current, "wrongpass1", "nuevaclave9")), http.StatusUnauthorized, "invalid_credentials")
	expect(t, h.do(*change(current, "wrongpass2", "nuevaclave9")), http.StatusUnauthorized, "invalid_credentials")
	// Wrong current passwords count like failed logins: a stolen cookie cannot guess.
	expect(t, h.do(*change(current, "secreto123", "nuevaclave9")), http.StatusTooManyRequests, "rate_limited")
	// 45 minutes later a pair token is back; both sessions are used meanwhile, so neither
	// goes idle.
	for _, d := range []time.Duration{25 * time.Minute, 20 * time.Minute} {
		h.clock.Advance(d)
		for _, tok := range []string{current, other} {
			expect(t, h.do(req{method: "POST", path: "/api/auth/keepalive", token: tok}), http.StatusNoContent, "")
		}
	}

	expect(t, h.do(*change(current, "secreto123", "nuevaclave9")), http.StatusNoContent, "")
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: current}), http.StatusOK, "")
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: other}), http.StatusUnauthorized, "unauthorized")
	// From another address: this one spent its per-IP budget above.
	const elsewhere = "5.6.7.8:1"
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", remote: elsewhere, body: `{"email":"ana@example.org","password":"secreto123"}`}),
		http.StatusUnauthorized, "invalid_credentials")
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", remote: elsewhere, body: `{"email":"ana@example.org","password":"nuevaclave9"}`}),
		http.StatusOK, "")
}
