package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/accountopts"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
)

// fakeOptions keeps the documents in memory, by account.
type fakeOptions struct {
	mu   sync.Mutex
	docs map[int64][]byte
}

func (f *fakeOptions) AccountOptions(_ context.Context, id int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.docs[id], nil
}

func (f *fakeOptions) SaveAccountOptions(_ context.Context, id int64, doc []byte, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.docs[id] = doc
	return nil
}

func optionsHarness(t *testing.T, rl httpapi.RateLimit) (*harness, *fakeOptions, string, string) {
	t.Helper()
	opts := &fakeOptions{docs: map[int64][]byte{}}
	h := newHarness(t, func(c *httpapi.Config) { c.Options, c.OptionsRateLimit = opts, rl })
	h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`})
	h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"bob@example.org","password":"secreto123"}`})
	return h, opts, h.login("ana@example.org", "secreto123"), h.login("bob@example.org", "secreto123")
}

const optionsPath = "/api/account/options"

func TestAccountOptionsRoundTrip(t *testing.T) {
	h, opts, ana, bob := optionsHarness(t, httpapi.RateLimit{})

	// Needs a session, to read and to write.
	expect(t, h.do(req{method: "GET", path: optionsPath}), http.StatusUnauthorized, "unauthorized")
	expect(t, h.do(req{method: "POST", path: optionsPath, body: `{"v":1}`}), http.StatusUnauthorized, "unauthorized")

	// Never saved: the empty document.
	w := h.do(req{method: "GET", path: optionsPath, token: ana})
	expect(t, w, http.StatusOK, "")
	if got := strings.TrimSpace(w.Body.String()); got != `{"options":{"v":1}}` {
		t.Fatalf("empty options = %s", got)
	}

	// Saved in canonical form (the key order and spacing of the server, not the client's).
	sent := `{ "lang":"en", "v":1, "chat_opacity":65, "devices":{"touch":{"zoom":2}} }`
	expect(t, h.do(req{method: "POST", path: optionsPath, token: ana, body: sent}), http.StatusNoContent, "")
	const canon = `{"v":1,"lang":"en","chat_opacity":65,"devices":{"touch":{"zoom":2}}}`
	if got := string(opts.docs[1]); got != canon {
		t.Fatalf("stored %s, want %s", got, canon)
	}
	w = h.do(req{method: "GET", path: optionsPath, cookie: ana})
	expect(t, w, http.StatusOK, "")
	if got := strings.TrimSpace(w.Body.String()); got != `{"options":`+canon+`}` {
		t.Fatalf("read back %s", got)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control %q", cc)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q: the document must never be served as markup", ct)
	}

	// Another account neither sees nor replaces it.
	w = h.do(req{method: "GET", path: optionsPath, token: bob})
	if got := strings.TrimSpace(w.Body.String()); got != `{"options":{"v":1}}` {
		t.Fatalf("another account reads %s", got)
	}
	expect(t, h.do(req{method: "POST", path: optionsPath, token: bob, body: `{"v":1,"lang":"es"}`}), http.StatusNoContent, "")
	if got := string(opts.docs[1]); got != canon {
		t.Fatalf("another account's save changed it: %s", got)
	}

	// A stored document this server does not accept reads as empty, never as it is.
	opts.docs[1] = []byte(`{"v":1,"lang":"<script>"}`)
	w = h.do(req{method: "GET", path: optionsPath, token: ana})
	if got := strings.TrimSpace(w.Body.String()); got != `{"options":{"v":1}}` {
		t.Fatalf("a junk row is served: %s", got)
	}
}

func TestAccountOptionsRejects(t *testing.T) {
	h, opts, ana, _ := optionsHarness(t, httpapi.RateLimit{})
	put := func(r req) int {
		r.method, r.path, r.token = "POST", optionsPath, ana
		return h.do(r).Code
	}
	for name, c := range map[string]struct {
		r    req
		want int
	}{
		"unknown key":   {req{body: `{"v":1,"motd":"<b>hi</b>"}`}, http.StatusBadRequest},
		"markup":        {req{body: `{"v":1,"lang":"<script>alert(1)</script>"}`}, http.StatusBadRequest},
		"wrong version": {req{body: `{"v":7}`}, http.StatusBadRequest},
		"not json":      {req{body: `v=1`}, http.StatusBadRequest},
		"a form (CSRF)": {req{body: `{"v":1}`, contentType: "text/plain"}, http.StatusUnsupportedMediaType},
		"url-encoded":   {req{body: `{"v":1}`, contentType: "application/x-www-form-urlencoded"}, http.StatusUnsupportedMediaType},
		"too large":     {req{body: `{"v":1` + strings.Repeat(" ", accountopts.MaxBytes) + `}`}, http.StatusRequestEntityTooLarge},
	} {
		if got := put(c.r); got != c.want {
			t.Errorf("%s: status %d, want %d", name, got, c.want)
		}
	}
	if len(opts.docs) != 0 {
		t.Errorf("a rejected document was stored: %v", opts.docs)
	}
	// Only GET and POST exist (the desktop app's bridge sends nothing else).
	if w := h.do(req{method: "PUT", path: optionsPath, token: ana, body: `{"v":1}`}); w.Code == http.StatusNoContent || w.Code == http.StatusOK {
		t.Errorf("PUT accepted: %d", w.Code)
	}
}

func TestAccountOptionsRateLimitIsPerAccount(t *testing.T) {
	h, _, ana, bob := optionsHarness(t, httpapi.RateLimit{Burst: 2, Every: time.Minute})
	put := func(tok string) int {
		return h.do(req{method: "POST", path: optionsPath, token: tok, body: `{"v":1}`}).Code
	}
	if a, b := put(ana), put(ana); a != http.StatusNoContent || b != http.StatusNoContent {
		t.Fatalf("first saves %d %d", a, b)
	}
	w := h.do(req{method: "POST", path: optionsPath, token: ana, body: `{"v":1}`})
	expect(t, w, http.StatusTooManyRequests, "rate_limited")
	if w.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After")
	}
	if got := put(bob); got != http.StatusNoContent {
		t.Errorf("another account is limited too: %d", got)
	}
	h.clock.Advance(time.Minute)
	if got := put(ana); got != http.StatusNoContent {
		t.Errorf("after the wait: %d", got)
	}
}

// Without a store for them the routes do not exist.
func TestAccountOptionsOff(t *testing.T) {
	h := newHarness(t, nil)
	h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`})
	tok := h.login("ana@example.org", "secreto123")
	expect(t, h.do(req{method: "GET", path: optionsPath, token: tok}), http.StatusNotFound, "not_found")
}
