//go:build integration

package httpapi_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// TestAPIWithPostgres runs register → login → create → list → logout over a real HTTP
// server, real Postgres, production hash parameters and the repo's vocations.yaml.
func TestAPIWithPostgres(t *testing.T) {
	st := storetest.Open(t, "it_httpapi", true)
	vocations, err := content.LoadVocations(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	svc, err := auth.New(auth.Config{Repo: st, Clock: clock.Real{}, Vocations: vocations})
	if err != nil {
		t.Fatal(err)
	}
	h, err := httpapi.New(httpapi.Config{Auth: svc, Clock: clock.Real{}, Health: st.Ping})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	call := func(method, path, token, body string, wantStatus int) []byte {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewBufferString(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != wantStatus {
			t.Fatalf("%s %s = %d %s, want %d", method, path, resp.StatusCode, b, wantStatus)
		}
		return b
	}

	call("GET", "/healthz", "", "", 200)
	creds := `{"email":"Ana@Example.org","password":"secreto123"}`
	call("POST", "/api/auth/register", "", creds, 201)
	call("POST", "/api/auth/register", "", `{"email":"ana@example.org","password":"secreto123"}`, 409)
	call("POST", "/api/auth/login", "", `{"email":"ana@example.org","password":"wrong-pass"}`, 401)

	var login struct{ Token string }
	_ = json.Unmarshal(call("POST", "/api/auth/login", "", creds, 200), &login)

	call("POST", "/api/characters", login.Token, `{"name":"Mira","vocation":"arcanist"}`, 201)
	call("POST", "/api/characters", login.Token, `{"name":"Mira","vocation":"guardian"}`, 409)
	call("POST", "/api/characters", login.Token, `{"name":"Tom","vocation":"druid"}`, 400) // not in MVP data

	var list struct {
		Characters []struct {
			Name, Vocation string
			Level          int
		}
	}
	_ = json.Unmarshal(call("GET", "/api/characters", login.Token, "", 200), &list)
	if len(list.Characters) != 1 || list.Characters[0].Name != "Mira" || list.Characters[0].Vocation != "arcanist" || list.Characters[0].Level != 1 {
		t.Fatalf("list = %+v", list)
	}

	call("POST", "/api/auth/logout", login.Token, "", 204)
	call("GET", "/api/characters", login.Token, "", 401)
}
