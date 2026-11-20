package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// POST /api/characters takes the look chosen on the creation screen (docs/05, docs/02
// "Apariencia"): stored when it is a player's choice, invalid_look otherwise.
func TestCreateCharacterWithLook(t *testing.T) {
	looks, err := content.LoadLooks("../../../data")
	if err != nil || looks == nil {
		t.Fatalf("looks: %v", err)
	}
	repo := authtest.NewRepo()
	clk := clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	svc, err := auth.New(auth.Config{
		Repo: repo, Clock: clk, Looks: looks,
		Vocations: content.Vocations{"guardian": {ID: "guardian", Start: content.VocationStats{Health: 150, Mana: 30}}},
		Hash:      auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	api, err := httpapi.New(httpapi.Config{Auth: svc, Clock: clk, CookieSecure: true})
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, h: api, clock: clk}
	expect(t, h.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"ana@example.org","password":"secreto123"}`}), http.StatusCreated, "")
	token := h.login("ana@example.org", "secreto123")

	w := h.do(req{method: "POST", path: "/api/characters", token: token,
		body: `{"name":"Mira","vocation":"guardian","look":{"sex":"female","body":"slender","skin":"olive","hair":"ponytail","hair_color":"red","beard":"none"}}`})
	expect(t, w, http.StatusCreated, "")
	var b struct {
		Character struct {
			ID int64 `json:"id"`
		} `json:"character"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	want := store.Look{Sex: "female", Body: "slender", Skin: "olive", Hair: "ponytail", HairColor: "red", Beard: "none"}
	if got := repo.CharacterLook(b.Character.ID); got != want {
		t.Fatalf("stored look %+v, want %+v", got, want)
	}
	expect(t, h.do(req{method: "POST", path: "/api/characters", token: token,
		body: `{"name":"Tomas","vocation":"guardian","look":{"sex":"male","body":"slender","skin":"ashen","hair":"short","hair_color":"red","beard":"none"}}`}),
		http.StatusBadRequest, "invalid_look")
	// A look without its sex (a client from before it) is not a look a player may choose.
	expect(t, h.do(req{method: "POST", path: "/api/characters", token: token,
		body: `{"name":"Tomas","vocation":"guardian","look":{"body":"slender","skin":"olive","hair":"short","hair_color":"red","beard":"none"}}`}),
		http.StatusBadRequest, "invalid_look")
}
