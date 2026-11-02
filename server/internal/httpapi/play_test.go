package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestPlayIssuesSessionToken(t *testing.T) {
	h := newHarness(t, nil)
	creds := `{"email":"ana@example.org","password":"secreto123"}`
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: creds}), http.StatusCreated, "")
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"bob@example.org","password":"secreto123"}`}), http.StatusCreated, "")
	token := h.login("ana@example.org", "secreto123")
	bob := h.login("bob@example.org", "secreto123")
	expect(t, h.do(req{method: "POST", path: "/api/characters", token: token, body: `{"name":"Mira","vocation":"guardian"}`}), http.StatusCreated, "")

	expect(t, h.do(req{method: "POST", path: "/api/play", body: `{"character_id":3}`}), http.StatusUnauthorized, "unauthorized")
	expect(t, h.do(req{method: "POST", path: "/api/play", token: bob, body: `{"character_id":3}`}), http.StatusNotFound, "character_not_found")
	expect(t, h.do(req{method: "POST", path: "/api/play", token: token, body: `{"character_id":99}`}), http.StatusNotFound, "character_not_found")
	expect(t, h.do(req{method: "POST", path: "/api/play", token: token, body: `{"character":3}`}), http.StatusBadRequest, "bad_request")

	w := h.do(req{method: "POST", path: "/api/play", cookie: token, body: `{"character_id":3}`})
	expect(t, w, http.StatusOK, "")
	var b struct {
		SessionToken string    `json:"session_token"`
		ExpiresAt    time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil || len(b.SessionToken) != 43 {
		t.Fatalf("play body %s: %v", w.Body.String(), err)
	}
	if want := h.clock.Now().Add(60 * time.Second); !b.ExpiresAt.Equal(want) {
		t.Fatalf("expires_at %v, want %v", b.ExpiresAt, want)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("play token must not be cached")
	}
}
