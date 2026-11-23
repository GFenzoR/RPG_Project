package httpapi_test

import (
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
)

// fuzzRoutes are the JSON endpoints FuzzJSONRoutes posts to; authed ones carry the
// session token of an account that has one character.
var fuzzRoutes = []struct {
	path   string
	authed bool
	seed   string // a body the endpoint accepts (or at least parses)
}{
	{"/api/auth/register", false, `{"email":"new@example.org","password":"long-password-2"}`},
	{"/api/auth/login", false, `{"email":"fuzz@example.org","password":"long-password-1","token_in_body":true}`},
	{"/api/characters", true, `{"name":"Lorien","vocation":"guardian","look":{"body":"human"}}`},
	{"/api/play", true, `{"character_id":1}`},
	{"/api/auth/oauth/google/start", false, `{"return":"/play"}`},
	{"/api/auth/oauth/discord/link", true, `{"return":"/account","password":"long-password-1"}`},
	{"/api/auth/oauth/pending/confirm", false, `{"password":"long-password-1"}`},
	{"/api/auth/oauth/pending/create", false, `{}`},
	{"/api/account/unlink", true, `{"provider":"google","password":"long-password-1"}`},
	{"/api/auth/verify", false, `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`},
	{"/api/auth/password/forgot", false, `{"email":"fuzz@example.org"}`},
	{"/api/auth/password/reset", false, `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","password":"long-password-3"}`},
	{"/api/shop/checkout", true, `{"pack":"pack_small"}`},
	{"/api/shop/buy", true, `{"cosmetic":"outfit_sailor"}`},
	{"/api/maps/submissions", true, `{"title":"Muelle","description":"x","character_id":1,"license":"CC-BY-SA-4.0","patch":"{}"}`},
	{"/api/maps/submissions/1/review", true, `{"decision":"reject","note":"no"}`},
	{"/api/payments/webhook/fake", false, `{"type":"payment","data":{"id":"1"}}`},
	{"/api/auth/logout", true, ``},
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
		f.Add(uint8(i), []byte(r.seed))
		for _, n := range nasty {
			f.Add(uint8(i), []byte(n))
		}
	}
	f.Fuzz(func(t *testing.T, route uint8, body []byte) {
		r := fuzzRoutes[int(route)%len(fuzzRoutes)]
		h, token := fuzzAPI(t)
		hr := httptest.NewRequest(http.MethodPost, r.path, strings.NewReader(string(body)))
		hr.Header.Set("Content-Type", "application/json")
		if r.authed {
			hr.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, hr)
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

// fuzzAPI is the API with every optional part wired to fakes and an account
// (fuzz@example.org, one character) logged in.
func fuzzAPI(t *testing.T) (http.Handler, string) {
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
	pay, err := payments.NewFake(payments.EnvTest, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	h, err := httpapi.New(httpapi.Config{
		Auth: svc, Clock: clk, CookieSecure: true,
		Shop:           &httpapi.Shop{Store: newMemShop(), Catalog: catalog(t), Provider: pay, Changed: func(int64) {}},
		MapSubmissions: newFakeSubmissions(),
	})
	if err != nil {
		t.Fatal(err)
	}
	hh := &harness{t: t, h: h, clock: clk}
	expect(t, hh.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"fuzz@example.org","password":"long-password-1"}`}),
		http.StatusCreated, "")
	token := hh.login("fuzz@example.org", "long-password-1")
	expect(t, hh.do(req{method: "POST", path: "/api/characters", token: token, body: `{"name":"Fuzzwick","vocation":"guardian"}`}),
		http.StatusCreated, "")
	return h, token
}
