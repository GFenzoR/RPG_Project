package httpapi_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/mail"
)

type mailHarness struct {
	*harness
	repo *authtest.Repo
	box  *authtest.Mailbox
	// resets receives one value per finished background reset request.
	resets chan struct{}
}

func newMailHarness(t *testing.T, mutate func(*httpapi.Config)) *mailHarness {
	t.Helper()
	repo := authtest.NewRepo()
	box := &authtest.Mailbox{}
	clk := clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	svc, err := auth.New(auth.Config{
		Repo: repo, Clock: clk,
		Vocations: content.Vocations{"guardian": {ID: "guardian", Start: content.VocationStats{Health: 150, Mana: 30}}},
		Hash:      auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
		Mail:      box, PublicURL: "https://game.example",
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
	resets := make(chan struct{}, 64)
	t.Cleanup(httpapi.SetResetDoneHook(func() { resets <- struct{}{} }))
	return &mailHarness{harness: &harness{t: t, h: h, clock: clk}, repo: repo, box: box, resets: resets}
}

func (m *mailHarness) register(email, lang string) int64 {
	m.t.Helper()
	w := m.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"` + email + `","password":"long-password-1","lang":"` + lang + `"}`})
	expect(m.t, w, http.StatusCreated, "")
	var b struct {
		AccountID int64 `json:"account_id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	return b.AccountID
}

// forgot asks for a reset and waits until the background request finished (if one
// was started: over the per-address limit nothing runs).
func (m *mailHarness) forgot(email string, wait bool) {
	m.t.Helper()
	w := m.do(req{method: "POST", path: "/api/auth/password/forgot", body: `{"email":"` + email + `","lang":"en"}`})
	if w.Code != http.StatusAccepted || w.Body.Len() != 0 {
		m.t.Fatalf("forgot %s: %d %q", email, w.Code, w.Body.String())
	}
	if wait {
		<-m.resets // the go test timeout catches a request that never finishes
	}
}

func accountOf(t *testing.T, h *mailHarness, token string) map[string]any {
	t.Helper()
	w := h.do(req{method: "GET", path: "/api/account", token: token})
	expect(t, w, http.StatusOK, "")
	var b map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	return b
}

func TestRegisterSendsVerificationAndVerify(t *testing.T) {
	h := newMailHarness(t, nil)
	w := h.do(req{method: "GET", path: "/api/auth/config"})
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"email":true,"providers":[],"public_url":"https://game.example"}` {
		t.Fatalf("config %d %s", w.Code, w.Body.String())
	}
	h.register("ana@example.org", "en")
	e, ok := h.box.Last()
	if !ok || e.Kind != mail.KindVerify || e.Lang != "en" || !strings.HasPrefix(e.Link, "https://game.example/verify?lang=en#token=") {
		t.Fatalf("email %+v", e)
	}
	tok := h.login("ana@example.org", "long-password-1")
	if a := accountOf(t, h, tok); a["email_verified"] != false || a["email_enabled"] != true || a["email"] != "ana@example.org" {
		t.Fatalf("account %v", a)
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/verify", body: `{"token":"` + e.Token() + `"}`}), http.StatusNoContent, "")
	expect(t, h.do(req{method: "POST", path: "/api/auth/verify", body: `{"token":"` + e.Token() + `"}`}), http.StatusBadRequest, "invalid_token")
	if a := accountOf(t, h, tok); a["email_verified"] != true {
		t.Fatalf("account %v", a)
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/verify/resend", body: `{}`, token: tok}), http.StatusConflict, "already_verified")
	// The token is never accepted from the query string.
	expect(t, h.do(req{method: "POST", path: "/api/auth/verify?token=" + e.Token(), body: `{}`}), http.StatusBadRequest, "invalid_token")
}

func TestResendIsRateLimitedPerAccount(t *testing.T) {
	h := newMailHarness(t, nil)
	h.register("ana@example.org", "es") // spends one of the 3
	tok := h.login("ana@example.org", "long-password-1")
	for i := 0; i < 2; i++ {
		expect(t, h.do(req{method: "POST", path: "/api/auth/verify/resend", body: `{"lang":"es"}`, token: tok}), http.StatusAccepted, "")
	}
	w := h.do(req{method: "POST", path: "/api/auth/verify/resend", body: `{}`, token: tok})
	expect(t, w, http.StatusTooManyRequests, "rate_limited")
	if n := len(h.box.Sent()); n != 3 {
		t.Fatalf("%d emails", n)
	}
	h.clock.Advance(httpapi.DefaultVerifyResendRateLimit.Every)
	expect(t, h.do(req{method: "POST", path: "/api/auth/verify/resend", body: `{}`, token: tok}), http.StatusAccepted, "")
	expect(t, h.do(req{method: "POST", path: "/api/auth/verify/resend", body: `{}`}), http.StatusUnauthorized, "unauthorized")
}

func TestForgotPasswordSameAnswerForEveryone(t *testing.T) {
	h := newMailHarness(t, nil)
	verified := h.register("ana@example.org", "es")
	h.repo.SetVerified(verified)
	h.register("new@example.org", "es") // unverified: may not reset
	before := len(h.box.Sent())

	h.forgot("nobody@example.org", true)
	h.forgot("new@example.org", true)
	if n := len(h.box.Sent()); n != before {
		t.Fatalf("%d emails for accounts that may not get one", n-before)
	}
	h.forgot("ANA@example.org", true)
	e, _ := h.box.Last()
	if e.Kind != mail.KindReset || e.To != "ana@example.org" || e.Lang != "es" {
		t.Fatalf("email %+v (the account's language wins over the request's)", e)
	}
	// Per address: 3 per 20 minutes, then the same answer and nothing sent.
	h.forgot("ana@example.org", true)
	h.forgot("ana@example.org", true)
	h.forgot("ana@example.org", false)
	if n := len(h.box.Sent()) - before; n != 3 {
		t.Fatalf("%d reset emails, want 3", n)
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/password/forgot", body: `{"email":"not-an-email"}`}), http.StatusBadRequest, "invalid_email")
}

func TestForgotPasswordPerIPLimit(t *testing.T) {
	h := newMailHarness(t, func(c *httpapi.Config) { c.AuthRateLimit = httpapi.RateLimit{Burst: 2, Every: time.Hour} })
	h.forgot("a@example.org", true)
	h.forgot("b@example.org", true)
	w := h.do(req{method: "POST", path: "/api/auth/password/forgot", body: `{"email":"c@example.org"}`})
	expect(t, w, http.StatusTooManyRequests, "rate_limited")
}

func TestResetPasswordRevokesSessionsAndCookie(t *testing.T) {
	h := newMailHarness(t, nil)
	id := h.register("ana@example.org", "en")
	h.repo.SetVerified(id)
	old := h.login("ana@example.org", "long-password-1")
	h.forgot("ana@example.org", true)
	e, _ := h.box.Last()

	expect(t, h.do(req{method: "POST", path: "/api/auth/password/reset", body: `{"token":"` + e.Token() + `","password":"x"}`}), http.StatusBadRequest, "invalid_password")
	w := h.do(req{method: "POST", path: "/api/auth/password/reset", body: `{"token":"` + e.Token() + `","password":"brand-new-pass"}`})
	expect(t, w, http.StatusNoContent, "")
	c := w.Result().Cookies()
	if len(c) != 1 || c[0].Name != httpapi.SessionCookie || c[0].MaxAge >= 0 || !c[0].HttpOnly || !c[0].Secure {
		t.Fatalf("cookie %+v", c)
	}
	expect(t, h.do(req{method: "GET", path: "/api/characters", token: old}), http.StatusUnauthorized, "unauthorized")
	expect(t, h.do(req{method: "POST", path: "/api/auth/password/reset", body: `{"token":"` + e.Token() + `","password":"another-pass-2"}`}), http.StatusBadRequest, "invalid_token")
	h.login("ana@example.org", "brand-new-pass")
}

func TestEmailRoutesWithoutMail(t *testing.T) {
	h := newHarness(t, nil)
	w := h.do(req{method: "GET", path: "/api/auth/config"})
	if strings.TrimSpace(w.Body.String()) != `{"email":false,"providers":[]}` {
		t.Fatalf("config %s", w.Body.String())
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/password/forgot", body: `{"email":"a@example.org"}`}), http.StatusNotFound, "email_disabled")
	w = h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"a@example.org","password":"long-password-1"}`})
	expect(t, w, http.StatusCreated, "")
	tok := h.login("a@example.org", "long-password-1")
	expect(t, h.do(req{method: "POST", path: "/api/auth/verify/resend", body: `{}`, token: tok}), http.StatusNotFound, "email_disabled")
}

func TestMapSubmitNeedsVerifiedEmail(t *testing.T) {
	subs := newFakeSubmissions()
	h := newMailHarness(t, func(c *httpapi.Config) { c.MapSubmissions = subs })
	id := h.register("ana@example.org", "es")
	tok := h.login("ana@example.org", "long-password-1")
	w := h.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: submitBody(t, nil)})
	expect(t, w, http.StatusForbidden, "email_unverified")
	h.repo.SetVerified(id)
	w = h.do(req{method: "POST", path: "/api/maps/submissions", token: tok, body: submitBody(t, nil)})
	expect(t, w, http.StatusCreated, "")
}
