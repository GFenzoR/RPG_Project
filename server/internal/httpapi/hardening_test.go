package httpapi_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/payments"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Regression tests of the lote 16 API hardening (docs/05 "Límites de la API").

// countingAccounts counts the calls that would reach the database. Authenticate
// accepts the token "good" as account 7.
type countingAccounts struct {
	*fakeAccounts
	auths, plays, chars, logouts, pendings atomic.Int32
	charsErr                               error
}

func newCounting() *countingAccounts {
	return &countingAccounts{fakeAccounts: &fakeAccounts{login: wrongPassword}}
}

func (c *countingAccounts) Authenticate(_ context.Context, tok string) (int64, error) {
	c.auths.Add(1)
	if tok == "good" {
		return 7, nil
	}
	return 0, auth.ErrUnauthorized
}

func (c *countingAccounts) IssuePlayToken(context.Context, int64, int64) (auth.Token, error) {
	c.plays.Add(1)
	return auth.Token{Token: "p"}, nil
}

func (c *countingAccounts) CreateCharacter(context.Context, int64, string, string, *content.Look) (store.Character, error) {
	c.chars.Add(1)
	return store.Character{ID: 1}, nil
}

func (c *countingAccounts) Characters(context.Context, int64) ([]store.Character, error) {
	return nil, c.charsErr
}

func (c *countingAccounts) Logout(context.Context, string) error {
	c.logouts.Add(1)
	return nil
}

func (c *countingAccounts) Pending(context.Context, string) (auth.PendingIdentity, error) {
	c.pendings.Add(1)
	return auth.PendingIdentity{}, auth.ErrPendingExpired
}

func newCountingAPI(t *testing.T, acc httpapi.Accounts, mutate func(*httpapi.Config)) (http.Handler, *clock.Fake) {
	t.Helper()
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	cfg := httpapi.Config{Auth: acc, Clock: clk}
	if mutate != nil {
		mutate(&cfg)
	}
	h, err := httpapi.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return h, clk
}

func serve(h http.Handler, method, path, body, remote string, header map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if remote != "" {
		r.RemoteAddr = remote
	}
	for k, v := range header {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// Finding 1: one client sending made-up bearer tokens used to cost a session lookup per
// request (pool starvation). The client's token-lookup budget is spent first.
func TestTokenLookupsAreLimitedPerClient(t *testing.T) {
	acc := newCounting()
	h, _ := newCountingAPI(t, acc, nil)
	bearer := map[string]string{"Authorization": "Bearer x"}
	limited := 0
	for i := 0; i < 200; i++ {
		for _, path := range []string{"GET /api/characters", "GET /api/account", "POST /api/play"} {
			method, p, _ := strings.Cut(path, " ")
			body := ""
			if method == "POST" {
				body = `{"character_id":1}`
			}
			if w := serve(h, method, p, body, "6.6.6.6:1", bearer); w.Code == http.StatusTooManyRequests {
				limited++
				if w.Header().Get("Retry-After") == "" {
					t.Fatal("429 without Retry-After")
				}
			}
		}
		serve(h, "POST", "/api/auth/logout", "", "6.6.6.6:1", bearer)
		serve(h, "GET", "/api/auth/oauth/pending", "", "6.6.6.6:1", nil)
	}
	burst := int32(httpapi.DefaultTokenRateLimit.Burst)
	if n := acc.auths.Load() + acc.logouts.Load() + acc.pendings.Load(); n > burst {
		t.Fatalf("%d token lookups from one client (burst %d)", n, burst)
	}
	if limited == 0 {
		t.Fatal("never limited")
	}
	// Another client is not affected.
	if w := serve(h, "GET", "/api/characters", "", "7.7.7.7:1", map[string]string{"Authorization": "Bearer good"}); w.Code != http.StatusOK {
		t.Fatalf("other client: %d %s", w.Code, w.Body.String())
	}
}

// Finding 2: each POST /api/play inserts a session row; one account may not issue
// them (or create characters) without bound.
func TestPlayAndCreateAreLimitedPerAccount(t *testing.T) {
	acc := newCounting()
	h, clk := newCountingAPI(t, acc, func(c *httpapi.Config) {
		c.TokenRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
		c.AccountRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
	})
	good := map[string]string{"Authorization": "Bearer good"}
	var last *httptest.ResponseRecorder
	for i := 0; i < 100; i++ {
		// From many addresses: the limit is the account's, not the client's.
		last = serve(h, "POST", "/api/play", `{"character_id":1}`, fmt.Sprintf("10.0.%d.1:1", i), good)
		serve(h, "POST", "/api/characters", `{"name":"Ana","vocation":"guardian"}`, fmt.Sprintf("10.1.%d.1:1", i), good)
	}
	burst := int32(httpapi.DefaultAccountWriteRateLimit.Burst)
	if n := acc.plays.Load() + acc.chars.Load(); n > burst {
		t.Fatalf("%d play tokens and characters for one account (burst %d)", n, burst)
	}
	expect(t, last, http.StatusTooManyRequests, "rate_limited")
	if last.Header().Get("Retry-After") != "3" {
		t.Fatalf("Retry-After %q", last.Header().Get("Retry-After"))
	}
	clk.Advance(httpapi.DefaultAccountWriteRateLimit.Every)
	expect(t, serve(h, "POST", "/api/play", `{"character_id":1}`, "10.9.9.9:1", good), http.StatusOK, "")
}

// Finding 3: one client failing once a minute used to drain an account's per-email
// budget and lock its owner out from everywhere. One client alone cannot any more.
func TestOneClientCannotLockAnAccountOut(t *testing.T) {
	h := newHarness(t, nil)
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`, remote: "1.1.1.1:1"}), http.StatusCreated, "")
	bad := `{"email":"ana@example.org","password":"wrongpass"}`
	for i := 0; i < 90; i++ {
		h.clock.Advance(time.Minute) // the owner tries right after one of these
		w := h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: "6.6.6.6:1"})
		if w.Code != http.StatusUnauthorized && w.Code != http.StatusTooManyRequests {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: `{"email":"ana@example.org","password":"secreto123"}`, remote: "2.2.2.2:1"}), http.StatusOK, "")
}

// Finding 3: a browser that logged in with the password keeps logging in even when
// strangers drained the account's per-email budget from many networks.
func TestKnownDeviceSkipsThePerEmailLimit(t *testing.T) {
	h := newHarness(t, func(c *httpapi.Config) {
		c.LoginEmailRateLimit = httpapi.RateLimit{Burst: 3, Every: 24 * time.Hour}
	})
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`, remote: "1.1.1.1:1"}), http.StatusCreated, "")
	good := `{"email":"ana@example.org","password":"secreto123"}`
	w := h.do(req{method: "POST", path: "/api/auth/login", body: good, remote: "1.1.1.1:1"})
	expect(t, w, http.StatusOK, "")
	device := ""
	for _, c := range w.Result().Cookies() {
		if c.Name == httpapi.DeviceCookie {
			if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode || c.Path != "/api/auth" || strings.Contains(c.Value, "ana") {
				t.Fatalf("device cookie %+v", c)
			}
			device = c.Name + "=" + c.Value
		}
	}
	if device == "" {
		t.Fatal("no device cookie")
	}
	bad := `{"email":"ana@example.org","password":"wrongpass"}`
	for i := 0; i < 3; i++ {
		expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: bad, remote: fmt.Sprintf("9.%d.0.1:1", i)}), http.StatusUnauthorized, "")
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: good, remote: "8.8.8.8:1"}), http.StatusTooManyRequests, "rate_limited")
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: good, remote: "8.8.8.8:1", header: map[string]string{"Cookie": device}}), http.StatusOK, "")
	// The cookie of another account does not help.
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: `{"email":"bob@example.org","password":"secreto123"}`, remote: "8.8.8.9:1", header: map[string]string{"Cookie": device}}), http.StatusUnauthorized, "")
	// Nor a forged one.
	forged := httpapi.DeviceCookie + "=" + strings.Repeat("A", 32)
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: good, remote: "8.8.8.10:1", header: map[string]string{"Cookie": forged}}), http.StatusTooManyRequests, "rate_limited")
}

// Finding 4: the service has 4 password-hashing slots for everyone and the per-IP limit
// is per /64, so one IPv6 /48 could hold them all. At most one hashing request of a /48
// runs at once; another network still gets a slot.
func TestOneNetworkCannotHoldTheHashingSlots(t *testing.T) {
	entered := make(chan struct{}, 100)
	release := make(chan struct{})
	var inLogin atomic.Int32
	acc := &fakeAccounts{login: func() (auth.Token, error) {
		inLogin.Add(1)
		entered <- struct{}{}
		<-release
		return auth.Token{Token: "t", ExpiresAt: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)}, nil
	}}
	h, _ := newCountingAPI(t, acc, nil)
	body := `{"email":"ana@example.org","password":"secreto123"}`
	results := make(chan int, 100)
	for i := 0; i < 64; i++ {
		go func(i int) {
			results <- serve(h, "POST", "/api/auth/login", body, fmt.Sprintf("[2001:db8:1:%x::1]:1", i), nil).Code
		}(i)
	}
	timeout := time.After(10 * time.Second) //nolint:forbidigo // a real deadline: a broken cap would block forever
	select {
	case <-entered:
	case <-timeout:
		t.Fatal("no request reached the password check")
	}
	for i := 0; i < 63; i++ {
		select {
		case code := <-results:
			if code != http.StatusTooManyRequests {
				t.Fatalf("a second request of the /48 got %d", code)
			}
		case <-timeout:
			close(release)
			t.Fatalf("%d requests of one /48 are hashing at once", inLogin.Load())
		}
	}
	if n := inLogin.Load(); n != 1 {
		t.Fatalf("%d hashing requests of one /48", n)
	}
	// Another network still gets a slot.
	go func() { results <- serve(h, "POST", "/api/auth/login", body, "[2001:db8:2::1]:1", nil).Code }()
	select {
	case <-entered:
	case <-timeout:
		t.Fatal("another network got no slot")
	}
	close(release)
	for i := 0; i < 2; i++ {
		if code := <-results; code != http.StatusOK {
			t.Fatalf("held request: %d", code)
		}
	}
}

// Finding 4: the per-network budget is shared by every /64 of a /48 (and every address
// of an IPv4 /24).
func TestAuthRoutesAreLimitedPerNetwork(t *testing.T) {
	h, _ := newCountingAPI(t, newCounting(), nil)
	limited := false
	n := httpapi.DefaultAuthNetRateLimit.Burst + 1
	for i := 0; i < n; i++ {
		if serve(h, "POST", "/api/auth/login", fmt.Sprintf(`{"email":"u%d@example.org","password":"secreto123"}`, i), fmt.Sprintf("[2001:db8:1:%x::1]:1", i), nil).Code == http.StatusTooManyRequests {
			limited = true
		}
	}
	if !limited {
		t.Fatal("one /48 rotating /64s was never limited")
	}
	expect(t, serve(h, "POST", "/api/auth/login", `{"email":"other@example.org","password":"secreto123"}`, "[2001:db8:2::1]:1", nil), http.StatusUnauthorized, "")
}

// recordLogs is a slog.Handler that keeps every record.
type recordLogs struct {
	mu   sync.Mutex
	recs []slog.Record
}

func (l *recordLogs) Enabled(context.Context, slog.Level) bool { return true }
func (l *recordLogs) Handle(_ context.Context, r slog.Record) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.recs = append(l.recs, r.Clone())
	return nil
}
func (l *recordLogs) WithAttrs([]slog.Attr) slog.Handler { return l }
func (l *recordLogs) WithGroup(string) slog.Handler      { return l }

// count returns how many records have msg and the "suppressed" value of the last one.
func (l *recordLogs) count(msg string) (int, int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	n, sup := 0, int64(0)
	for _, r := range l.recs {
		if r.Message != msg {
			continue
		}
		n++
		sup = 0
		r.Attrs(func(a slog.Attr) bool {
			if a.Key == "suppressed" {
				sup = a.Value.Int64()
			}
			return true
		})
	}
	return n, sup
}

// Finding 5: an error a client can repeat at will is logged once, then summarized once a
// minute with how many were dropped.
func TestRepeatedErrorsAreSampled(t *testing.T) {
	logs := &recordLogs{}
	acc := newCounting()
	acc.charsErr = errors.New("db down")
	h, clk := newCountingAPI(t, acc, func(c *httpapi.Config) {
		c.Logger = slog.New(logs)
		c.TokenRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
		c.AccountRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
	})
	good := map[string]string{"Authorization": "Bearer good"}
	for i := 0; i < 100; i++ {
		expect(t, serve(h, "GET", "/api/characters", "", "1.1.1.1:1", good), http.StatusInternalServerError, "internal")
	}
	if n, _ := logs.count("http api"); n != 1 {
		t.Fatalf("%d error lines for 100 identical errors", n)
	}
	clk.Advance(time.Minute)
	serve(h, "GET", "/api/characters", "", "1.1.1.1:1", good)
	if n, sup := logs.count("http api"); n != 2 || sup != 99 {
		t.Fatalf("%d lines, last suppressed=%d", n, sup)
	}
}

func TestBadWebhookSignaturesAreSampled(t *testing.T) {
	logs := &recordLogs{}
	f, err := payments.NewFake(payments.EnvTest, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	h, clk := newCountingAPI(t, newCounting(), func(c *httpapi.Config) {
		c.Logger = slog.New(logs)
		c.Shop = &httpapi.Shop{Store: newMemShop(), Catalog: catalog(t), Provider: f}
	})
	send := func() {
		r, err := f.Notification("/api/payments/webhook/fake", payments.FakeNotification{Type: payments.Paid, Reference: "x", AmountMinor: 1, Currency: "CLP"})
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set(payments.FakeSignatureHeader, "00")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		expect(t, w, http.StatusUnauthorized, "invalid_signature")
	}
	const msg = "payments: webhook with an invalid signature"
	for i := 0; i < 50; i++ {
		send()
	}
	if n, _ := logs.count(msg); n != 1 {
		t.Fatalf("%d warnings for 50 bad signatures", n)
	}
	clk.Advance(time.Minute)
	send()
	if n, sup := logs.count(msg); n != 2 || sup != 49 {
		t.Fatalf("%d lines, last suppressed=%d", n, sup)
	}
}

// The test harnesses on one address (-auth-rate-burst) keep working: a raised per-IP
// burst raises the per-client and per-network limits and lifts the hashing cap.
func TestSharedIPHarnessIsNotLimited(t *testing.T) {
	h := newHarnessRepo(t, authtest.NewRepo(), func(c *httpapi.Config) {
		c.AuthRateLimit = httpapi.RateLimit{Burst: 1000, Every: 6 * time.Second}
	})
	for i := 0; i < 100; i++ {
		body := fmt.Sprintf(`{"email":"bot%d@example.org","password":"secreto123"}`, i)
		expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: body}), http.StatusCreated, "")
	}
	for i := 0; i < 150; i++ {
		expect(t, h.do(req{method: "GET", path: "/api/characters", token: strings.Repeat("A", 43)}), http.StatusUnauthorized, "unauthorized")
	}
}
