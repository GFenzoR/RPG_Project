package httpapi_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	"github.com/GFenzoR/RPG_Project/server/internal/oauth"
	"github.com/GFenzoR/RPG_Project/server/internal/oauth/oauthtest"
	"github.com/GFenzoR/RPG_Project/server/internal/payments"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// fuzzCred is what a fuzzed request carries besides its body, so that it reaches the
// handler's decoding instead of stopping at the door.
type fuzzCred int

const (
	credNone    fuzzCred = iota
	credPlayer           // the session token of fuzz@example.org (one character)
	credStaff            // the session token of a gm account (map review)
	credPending          // the rpg_oauth_pending cookie of a Google sign-in of fuzz@example.org
	credSigned           // the body signed the way the fake payment provider signs its webhook
)

// fuzzPaySecret is the fake payment provider's secret in fuzzAPI.
const fuzzPaySecret = "fuzz-pay-secret"

// fuzzRoutes are the JSON endpoints FuzzJSONRoutes posts to. want is the status of the
// seed body (TestFuzzSeedsReachTheirHandlers): the credentials get it past the door.
var fuzzRoutes = []struct {
	path string
	cred fuzzCred
	seed string // a body the endpoint accepts (or at least parses)
	want int
}{
	{"/api/auth/register", credNone, `{"email":"new@example.org","password":"long-password-2"}`, http.StatusCreated},
	{"/api/auth/login", credNone, `{"email":"fuzz@example.org","password":"long-password-1","token_in_body":true}`, http.StatusOK},
	{"/api/characters", credPlayer, `{"name":"Lorien","vocation":"guardian","look":{"body":"human"}}`, http.StatusCreated},
	{"/api/play", credPlayer, `{"character_id":2}`, http.StatusOK},
	{"/api/auth/oauth/google/start", credNone, `{"return":"/play"}`, http.StatusOK},
	{"/api/auth/oauth/discord/link", credPlayer, `{"password":"long-password-1"}`, http.StatusOK},
	{"/api/auth/oauth/pending/confirm", credPending, `{"password":"long-password-1"}`, http.StatusOK},
	{"/api/auth/oauth/pending/create", credPending, `{"email":"other@example.org"}`, http.StatusOK},
	{"/api/account/unlink", credPlayer, `{"provider":"google","password":"long-password-1"}`, http.StatusNotFound},
	{"/api/auth/verify", credNone, `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`, http.StatusBadRequest},
	{"/api/auth/password/forgot", credNone, `{"email":"fuzz@example.org"}`, http.StatusNotFound}, // decoded, then email_disabled (no mail here)
	{"/api/auth/password/reset", credNone, `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","password":"long-password-3"}`, http.StatusBadRequest},
	{"/api/shop/checkout", credPlayer, `{"pack_id":"pack_small"}`, http.StatusOK},
	{"/api/shop/buy", credPlayer, `{"cosmetic_id":"outfit_sailor"}`, http.StatusConflict},
	{"/api/maps/submissions", credPlayer, `{"title":"Muelle","description":"x","character_id":1,"license":"CC-BY-SA-4.0","patch":"{}"}`, http.StatusBadRequest},
	{"/api/maps/submissions/1/review", credStaff, `{"decision":"reject","reason":"no"}`, http.StatusOK},
	{"/api/payments/webhook/fake", credSigned, "", http.StatusOK}, // seed: fuzzWebhookSeed
	{"/api/auth/logout", credPlayer, ``, http.StatusNoContent},
}

// fuzzWebhookSeed is a fake payment notification for a real checkout reference of the
// player (account 1), which the webhook books.
func fuzzWebhookSeed(t testing.TB) string {
	t.Helper()
	ref, err := payments.SignReference([]byte(fuzzPaySecret), 1, "pack_small")
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(payments.FakeNotification{Type: payments.Paid, Reference: ref, AmountMinor: 1990, Currency: "CLP"})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// fuzzPost sends body to route i of fuzzRoutes with that route's credentials.
func fuzzPost(env fuzzEnv, i int, body []byte) *httptest.ResponseRecorder {
	r := fuzzRoutes[i]
	hr := httptest.NewRequest(http.MethodPost, r.path, strings.NewReader(string(body)))
	hr.Header.Set("Content-Type", "application/json")
	switch r.cred {
	case credNone:
	case credPlayer:
		hr.Header.Set("Authorization", "Bearer "+env.player)
	case credStaff:
		hr.Header.Set("Authorization", "Bearer "+env.staff)
	case credPending:
		hr.AddCookie(&http.Cookie{Name: httpapi.PendingCookie, Value: env.pending})
	case credSigned:
		m := hmac.New(sha256.New, []byte(fuzzPaySecret))
		m.Write(body)
		hr.Header.Set(payments.FakeSignatureHeader, hex.EncodeToString(m.Sum(nil)))
	}
	w := httptest.NewRecorder()
	env.h.ServeHTTP(w, hr)
	return w
}

// TestFuzzSeedsReachTheirHandlers keeps FuzzJSONRoutes honest: each route's seed, with
// its credentials, gets the status its handler gives a parsed body (not a 401 or 403 at
// the door), so the mutations of make fuzz exercise the decoding behind it.
func TestFuzzSeedsReachTheirHandlers(t *testing.T) {
	for i, r := range fuzzRoutes {
		env := fuzzAPI(t)
		body := r.seed
		if r.cred == credSigned {
			body = fuzzWebhookSeed(t)
		}
		if w := fuzzPost(env, i, []byte(body)); w.Code != r.want {
			t.Errorf("POST %s seed: status %d, want %d (body %s)", r.path, w.Code, r.want, w.Body.String())
		}
	}
}

// FuzzJSONRoutes (lote 16) posts arbitrary bodies to every JSON endpoint of the API,
// against fakes (auth repo, OAuth provider, payments, map submissions). Whatever the body,
// the API must answer with a fixed error code or success, never a 500 (a panic turned into
// "internal" by the recoverer) and never a non-JSON error.
//
// The seeds (f.Add plus testdata/fuzz/FuzzJSONRoutes) run in make test; make fuzz
// mutates them (docs/08).
func FuzzJSONRoutes(f *testing.F) {
	nasty := []string{``, `null`, `[]`, `"x"`, `{"email":null}`, `{"email":1e400}`, `{}{}`, `{"a":` + strings.Repeat("[", 200),
		`{"email":"\u0000@` + string(rune(0x202e)) + `.org","password":"` + strings.Repeat("ñ", 200) + `"}`, `{"character_id":-1}`,
		`{"character_id":9223372036854775808}`, `{"return":"//evil.example"}`, `{"return":"javascript:alert(1)"}`,
		`{"provider":"../../etc"}`, `{"look":{"body":{}}}`, strings.Repeat(" ", 5000)}
	for i, r := range fuzzRoutes {
		seed := r.seed
		if r.cred == credSigned {
			seed = fuzzWebhookSeed(f)
		}
		f.Add(uint8(i), []byte(seed))
		for _, n := range nasty {
			f.Add(uint8(i), []byte(n))
		}
	}
	f.Fuzz(func(t *testing.T, route uint8, body []byte) {
		i := int(route) % len(fuzzRoutes)
		r := fuzzRoutes[i]
		w := fuzzPost(fuzzAPI(t), i, body)
		if w.Code >= 500 && w.Code != http.StatusServiceUnavailable {
			t.Fatalf("POST %s %q: status %d body %s", r.path, body, w.Code, w.Body.String())
		}
		if w.Code >= 400 {
			var e struct {
				Error struct{ Code string } `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e.Error.Code == "" || e.Error.Code == "internal" {
				t.Fatalf("POST %s %q: %d with body %s", r.path, body, w.Code, w.Body.String())
			}
		}
	})
}

// fuzzEnv is the API of fuzzAPI and the credentials of its accounts.
type fuzzEnv struct {
	h                      http.Handler
	player, staff, pending string
}

// fuzzAPI is the API with every optional part wired to fakes and two accounts logged in:
// fuzz@example.org (a player with one character, who also started a Google sign-in that
// waits on /oauth/confirm) and gm@example.org (staff), with one pending map submission
// of the player's.
func fuzzAPI(t *testing.T) fuzzEnv {
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
		Repo: repo, OAuth: repo, Clock: clk,
		Vocations: content.Vocations{"guardian": {ID: "guardian", Start: content.VocationStats{Health: 150, Mana: 30}}},
		Hash:      auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
		PublicURL: "https://game.example", Providers: []*oauth.Provider{g, d},
	})
	if err != nil {
		t.Fatal(err)
	}
	pay, err := payments.NewFake(payments.EnvTest, fuzzPaySecret)
	if err != nil {
		t.Fatal(err)
	}
	subs := newFakeSubmissions()
	h, err := httpapi.New(httpapi.Config{
		Auth: svc, Clock: clk, CookieSecure: true,
		Shop:           &httpapi.Shop{Store: newMemShop(), Catalog: catalog(t), Provider: pay, Changed: func(int64) {}},
		MapSubmissions: subs,
	})
	if err != nil {
		t.Fatal(err)
	}
	hh := &harness{t: t, h: h, clock: clk}
	register := func(email string) int64 {
		w := hh.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"` + email + `","password":"long-password-1"}`})
		expect(t, w, http.StatusCreated, "")
		var b struct {
			AccountID int64 `json:"account_id"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
			t.Fatal(err)
		}
		return b.AccountID
	}
	playerID := register("fuzz@example.org")
	token := hh.login("fuzz@example.org", "long-password-1")
	expect(t, hh.do(req{method: "POST", path: "/api/characters", token: token, body: `{"name":"Fuzzwick","vocation":"guardian"}`}),
		http.StatusCreated, "")
	subs.roles[register("gm@example.org")] = store.RoleGM
	staff := hh.login("gm@example.org", "long-password-1")
	if _, err := subs.CreateMapSubmission(context.Background(), store.NewMapSubmission{
		At: clk.Now(), AccountID: playerID, CharacterID: 1, Title: "Muelle", License: httpapi.MapLicense, Patch: []byte("{}"),
	}); err != nil {
		t.Fatal(err)
	}
	o := &oauthHarness{t: t, h: h, fake: fake, repo: repo, jar: map[string]string{}}
	if loc := o.login(oauth.Google, oauthtest.User{Subject: "g-fuzz", Email: "fuzz@example.org", Verified: true}, "/account"); loc != "/oauth/confirm" {
		t.Fatalf("google sign-in landed on %s", loc)
	}
	return fuzzEnv{h: h, player: token, staff: staff, pending: o.jar[httpapi.PendingCookie]}
}
