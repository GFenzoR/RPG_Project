package httpapi_test

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
)

// Regression tests of the second review of the lote 16 API hardening.

// stampAccounts accepts the password "secreto123" and signs device cookies with stamp.
type stampAccounts struct {
	*countingAccounts
	logins atomic.Int32
}

func newStampAccounts(stamp string) *stampAccounts {
	c := newCounting()
	c.stamp = stamp
	return &stampAccounts{countingAccounts: c}
}

func (s *stampAccounts) Login(_ context.Context, _, password string) (auth.Token, error) {
	s.logins.Add(1)
	if password == "secreto123" {
		return auth.Token{Token: "t", AccountID: 7, ExpiresAt: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)}, nil
	}
	return auth.Token{}, auth.ErrInvalidCredentials
}

const (
	goodLogin = `{"email":"ana@example.org","password":"secreto123"}`
	badLogin  = `{"email":"ana@example.org","password":"wrongpass"}`
)

// deviceCookie logs in with the right password and returns the device cookie header.
func deviceCookie(t *testing.T, h http.Handler) map[string]string {
	t.Helper()
	w := serve(h, "POST", "/api/auth/login", goodLogin, "1.1.1.1:1", nil)
	expect(t, w, http.StatusOK, "")
	for _, c := range w.Result().Cookies() {
		if c.Name == httpapi.DeviceCookie {
			return map[string]string{"Cookie": c.Name + "=" + c.Value}
		}
	}
	t.Fatal("no device cookie")
	return nil
}

// Important 1: the device cookie used to survive a password change. It is signed with the
// account's password stamp: after a reset it no longer skips the per-email limit.
func TestDeviceCookieDiesWithThePassword(t *testing.T) {
	acc := newStampAccounts("stamp-1")
	h, _ := newCountingAPI(t, acc, func(c *httpapi.Config) {
		c.LoginEmailRateLimit = httpapi.RateLimit{Burst: 2, Every: 24 * time.Hour}
	})
	device := deviceCookie(t, h)
	for i := 0; i < 2; i++ { // strangers drain the per-email budget
		expect(t, serve(h, "POST", "/api/auth/login", badLogin, fmt.Sprintf("9.%d.0.1:1", i), nil), http.StatusUnauthorized, "")
	}
	expect(t, serve(h, "POST", "/api/auth/login", badLogin, "8.8.8.8:1", device), http.StatusUnauthorized, "")
	acc.stamp = "stamp-2" // the password was reset
	expect(t, serve(h, "POST", "/api/auth/login", badLogin, "8.8.8.9:1", device), http.StatusTooManyRequests, "rate_limited")
}

// Important 1: one copied cookie used to give unlimited failures from many addresses.
// It has a failure budget of its own; past it the per-email limit applies again.
func TestDeviceCookieHasItsOwnFailureBudget(t *testing.T) {
	acc := newStampAccounts("stamp-1")
	h, _ := newCountingAPI(t, acc, func(c *httpapi.Config) {
		c.LoginEmailRateLimit = httpapi.RateLimit{Burst: 3, Every: 24 * time.Hour}
	})
	device := deviceCookie(t, h)
	limited := false
	for i := 0; i < 200 && !limited; i++ {
		w := serve(h, "POST", "/api/auth/login", badLogin, fmt.Sprintf("10.%d.%d.1:1", i/250, i%250), device)
		limited = w.Code == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("one device cookie failed 200 times from 200 addresses without a limit")
	}
	if n := acc.logins.Load(); n > int32(httpapi.DefaultDeviceLoginRateLimit.Burst+3+1) {
		t.Fatalf("%d password checks", n)
	}
}

// Important 2: a /48 holds 65 536 /64s, enough to fill the per-client token table. Token
// lookups are limited per network too.
func TestTokenLookupsAreLimitedPerNetwork(t *testing.T) {
	acc := newCounting()
	h, _ := newCountingAPI(t, acc, nil)
	bearer := map[string]string{"Authorization": "Bearer x"}
	for i := 0; i < 1000; i++ {
		serve(h, "GET", "/api/characters", "", fmt.Sprintf("[2001:db8:1:%x::1]:1", i), bearer)
	}
	if n := acc.auths.Load(); n > int32(httpapi.DefaultTokenNetRateLimit.Burst+5) {
		t.Fatalf("%d lookups from one /48", n)
	}
	before := acc.auths.Load()
	serve(h, "GET", "/api/characters", "", "[2001:db8:2::1]:1", bearer)
	if acc.auths.Load() != before+1 {
		t.Fatal("another network was limited")
	}
}

// Important 3: the pair limit was per /64, so 3 /64s of one /48 drained the per-email
// budget. It is per /48 now: one /48 alone cannot lock an account out.
func TestOneIPv6NetworkCannotLockAnAccountOut(t *testing.T) {
	h := newHarness(t, nil)
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: goodLogin, remote: "1.1.1.1:1"}), http.StatusCreated, "")
	for minute := 0; minute < 120; minute++ {
		h.clock.Advance(time.Minute)
		for i := 0; i < 4; i++ {
			w := h.do(req{method: "POST", path: "/api/auth/login", body: badLogin, remote: fmt.Sprintf("[2001:db8:1:%x::1]:1", i)})
			if w.Code != http.StatusUnauthorized && w.Code != http.StatusTooManyRequests {
				t.Fatalf("minute %d: %d", minute, w.Code)
			}
		}
	}
	expect(t, h.do(req{method: "POST", path: "/api/auth/login", body: goodLogin, remote: "2.2.2.2:1"}), http.StatusOK, "")
}

// Important 4: the health cache was dated before the ping, so a ping slower than the TTL
// left it stale and every waiting request pinged again, one after another.
func TestSlowHealthPingIsShared(t *testing.T) {
	var pings atomic.Int32
	release := make(chan struct{})
	h, clk := newCountingAPI(t, newCounting(), func(c *httpapi.Config) {
		c.Health = func(context.Context) error {
			pings.Add(1)
			<-release
			return nil
		}
	})
	var mu sync.Mutex
	advanced := false
	go func() {
		// Let the first ping start, then make it slow (2 s of clock) and finish it.
		for pings.Load() == 0 {
			time.Sleep(time.Millisecond) //nolint:forbidigo // waiting for a real goroutine
		}
		mu.Lock()
		clk.Advance(2 * time.Second)
		advanced = true
		mu.Unlock()
		close(release)
	}()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			expect(t, serve(h, "GET", "/healthz", "", "1.1.1.1:1", nil), http.StatusOK, "")
		}()
	}
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if !advanced {
		t.Fatal("the ping never ran")
	}
	if n := pings.Load(); n != 1 {
		t.Fatalf("%d pings for one slow burst", n)
	}
}

// Minor: the log sampler used to start over at 256 keys, so errors with endless
// distinct texts were all logged. New keys past the cap share one sampled key.
func TestLogSamplerHoldsAgainstDistinctErrors(t *testing.T) {
	logs := &recordLogs{}
	acc := newCounting()
	h, _ := newCountingAPI(t, acc, func(c *httpapi.Config) {
		c.Logger = slog.New(logs)
		c.TokenRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
		c.TokenNetRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
		c.AccountRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
	})
	good := map[string]string{"Authorization": "Bearer good"}
	for i := 0; i < 1000; i++ {
		acc.charsErr = fmt.Errorf("db error %d", i)
		expect(t, serve(h, "GET", "/api/characters", "", "1.1.1.1:1", good), http.StatusInternalServerError, "internal")
	}
	if n, _ := logs.count("http api"); n > 300 {
		t.Fatalf("%d error lines for 1000 distinct errors", n)
	}
}

// Minor: unlink checks the password under the login limits but lives outside the
// device cookie's path: it must not set a cookie the browser never sends back there.
func TestUnlinkSetsNoDeviceCookie(t *testing.T) {
	acc := newStampAccounts("stamp-1")
	h, _ := newCountingAPI(t, acc, nil)
	w := serve(h, "POST", "/api/account/unlink", `{"provider":"google","password":"secreto123"}`, "1.1.1.1:1",
		map[string]string{"Authorization": "Bearer good"})
	if w.Code != http.StatusNoContent {
		t.Fatalf("unlink: %d %s", w.Code, w.Body.String())
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == httpapi.DeviceCookie {
			t.Fatalf("unlink set %+v", c)
		}
	}
}
