package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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

// asJSONB spells a document the way the JSONB column of the real store returns it: a
// space after every ":" and "," (no string of the schema holds either).
func asJSONB(doc []byte) []byte {
	if doc == nil {
		return nil
	}
	return []byte(strings.NewReplacer(":", ": ", ",", ", ").Replace(string(doc)))
}

func (f *fakeOptions) AccountOptions(_ context.Context, id int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return asJSONB(f.docs[id]), nil
}

func (f *fakeOptions) UpdateAccountOptions(_ context.Context, id int64, _ time.Time, merge func([]byte) ([]byte, error)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	doc, err := merge(asJSONB(f.docs[id]))
	if err != nil {
		return err
	}
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
	if got := optionsOf(t, w); got != `{"v":1}` {
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
	if got := optionsOf(t, w); got != canon {
		t.Fatalf("read back %s", got)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control %q", cc)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q: the document must never be served as markup", ct)
	}

	// Another account neither sees nor replaces it.
	anaTag := optionsTagOf(t, w)
	w = h.do(req{method: "GET", path: optionsPath, token: bob})
	if got := optionsOf(t, w); got != `{"v":1}` {
		t.Fatalf("another account reads %s", got)
	}
	// The tag tells the accounts apart on a shared browser, is stable, and is not the id.
	bobTag := optionsTagOf(t, w)
	if anaTag == "" || bobTag == "" || anaTag == bobTag || anaTag == "1" || bobTag == "2" {
		t.Fatalf("account tags %q and %q", anaTag, bobTag)
	}
	if again := optionsTagOf(t, h.do(req{method: "GET", path: optionsPath, token: ana})); again != anaTag {
		t.Fatalf("the tag changed: %q, then %q", anaTag, again)
	}
	expect(t, h.do(req{method: "POST", path: optionsPath, token: bob, body: `{"v":1,"lang":"es"}`}), http.StatusNoContent, "")
	if got := string(opts.docs[1]); got != canon {
		t.Fatalf("another account's save changed it: %s", got)
	}

	// A stored document this server does not accept reads as empty, never as it is.
	opts.docs[1] = []byte(`{"v":1,"lang":"<script>"}`)
	w = h.do(req{method: "GET", path: optionsPath, token: ana})
	if got := optionsOf(t, w); got != `{"v":1}` {
		t.Fatalf("a junk row is served: %s", got)
	}
	// And a save over it keeps nothing of it.
	expect(t, h.do(req{method: "POST", path: optionsPath, token: ana, body: `{"v":1,"lang":"es"}`}), http.StatusNoContent, "")
	if got := string(opts.docs[1]); got != `{"v":1,"lang":"es"}` {
		t.Fatalf("saved over a junk row: %s", got)
	}
}

// optionsOf and optionsTagOf read the two fields of the GET's answer.
func optionsOf(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("answer %q: %v", w.Body.String(), err)
	}
	return string(out.Options)
}

func optionsTagOf(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		Account string `json:"account"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("answer %q: %v", w.Body.String(), err)
	}
	return out.Account
}

// A page open for hours on the computer saves with the copy of the phone's section it
// read at its login (or with none): what the phone saved since stays.
func TestAccountOptionsSaveKeepsTheOtherDeviceClass(t *testing.T) {
	h, opts, ana, _ := optionsHarness(t, httpapi.RateLimit{})
	save := func(body string) {
		t.Helper()
		expect(t, h.do(req{method: "POST", path: optionsPath, token: ana, body: body}), http.StatusNoContent, "")
	}
	save(`{"v":1,"lang":"es","devices":{"desktop":{"zoom":2}}}`)
	save(`{"v":1,"lang":"es","devices":{"touch":{"zoom":4,"touch_pad":true}}}`) // the phone
	save(`{"v":1,"lang":"en","devices":{"desktop":{"zoom":3}}}`)                // the computer, later
	const want = `{"v":1,"lang":"en","devices":{"desktop":{"zoom":3},"touch":{"touch_pad":true,"zoom":4}}}`
	if got := string(opts.docs[1]); got != want {
		t.Fatalf("stored %s\n  want %s", got, want)
	}
	// A screen that put its zoom back to fitted says so with its empty section.
	save(`{"v":1,"lang":"en","devices":{"desktop":{}}}`)
	if got := string(opts.docs[1]); got != `{"v":1,"lang":"en","devices":{"desktop":{},"touch":{"touch_pad":true,"zoom":4}}}` {
		t.Fatalf("after the empty section: %s", got)
	}
}

// windowsOf is a device section of n windows with every field, in both of its lists.
func windowsOf(n int) string {
	var places []string
	for i := range n {
		places = append(places, fmt.Sprintf(`"w%d":{"open":true,"collapsed":false,"x":%d,"y":-%d,"w":7,"h":9}`, i, i, i))
	}
	p := strings.Join(places, ",")
	return `{"zoom":2,"windows":{"v":3,"z":[],"win":{` + p + `},"others":{` + p + `}}}`
}

// The largest documents: one that only fits the limit in canonical form reads back
// whole (the database returns it spaced, longer), and a save that fits alone is never
// refused because the other screen's stored section no longer fits beside it.
func TestAccountOptionsLargestDocuments(t *testing.T) {
	h, opts, ana, _ := optionsHarness(t, httpapi.RateLimit{})
	post := func(body string) int {
		return h.do(req{method: "POST", path: optionsPath, token: ana, body: body}).Code
	}
	read := func() string {
		t.Helper()
		w := h.do(req{method: "GET", path: optionsPath, token: ana})
		expect(t, w, http.StatusOK, "")
		return optionsOf(t, w)
	}

	full := `{"v":1,"devices":{"desktop":` + windowsOf(60) + `,"touch":` + windowsOf(60) + `}}`
	if len(full) > accountopts.MaxBytes || len(asJSONB([]byte(full))) <= accountopts.MaxBytes {
		t.Fatalf("the document is %d bytes, %d as stored: the test needs one that only fits compact", len(full), len(asJSONB([]byte(full))))
	}
	if got := post(full); got != http.StatusNoContent {
		t.Fatalf("a document within the limit: status %d", got)
	}
	if got := read(); got != string(opts.docs[1]) || !strings.Contains(got, `"w59"`) {
		t.Fatalf("a document saved within the limit reads back as %d bytes, stored %d", len(got), len(opts.docs[1]))
	}
	// And the next save still knows the other screen's section.
	if got := post(`{"v":1,"lang":"en","devices":{"desktop":{"zoom":3}}}`); got != http.StatusNoContent {
		t.Fatalf("save over the largest document: status %d", got)
	}
	if got := read(); !strings.Contains(got, `"touch":{"zoom":2,"windows"`) || !strings.Contains(got, `"desktop":{"zoom":3}`) {
		t.Fatalf("the other screen's section was lost: %.120s", got)
	}

	// The phone's section, large, is stored; the computer saves one as large: both do not
	// fit, the save is accepted and the document is the computer's.
	big := windowsOf(accountopts.MaxWindows)
	if got := post(`{"v":1,"devices":{"touch":` + big + `,"desktop":{}}}`); got != http.StatusNoContent {
		t.Fatalf("the phone's large section: status %d", got)
	}
	for range 2 { // again and again: it does not stay refused
		if got := post(`{"v":1,"lang":"es","devices":{"desktop":` + big + `}}`); got != http.StatusNoContent {
			t.Fatalf("a save that fits alone, with a large section stored: status %d", got)
		}
	}
	if got := read(); !strings.Contains(got, `"lang":"es"`) || !strings.Contains(got, `"desktop":{"zoom":2,"windows"`) || strings.Contains(got, `"touch"`) {
		t.Fatalf("after the save that did not fit with the stored section: %.120s", got)
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
	for _, method := range []string{"PUT", "PATCH", "DELETE"} {
		w := h.do(req{method: method, path: optionsPath, token: ana, body: `{"v":1,"lang":"en"}`})
		if w.Code != http.StatusNotFound && w.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: status %d, want 404 or 405", method, w.Code)
		}
	}
	if len(opts.docs) != 0 {
		t.Errorf("a method that does not exist stored a document: %v", opts.docs)
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
