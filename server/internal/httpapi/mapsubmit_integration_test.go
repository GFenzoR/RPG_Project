//go:build integration

package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// TestMapPortalWithPostgres: a player submits over HTTP, a malicious patch stores nothing,
// a player cannot use the moderation API, a gm approves, and the audit log has it all.
func TestMapPortalWithPostgres(t *testing.T) {
	ctx := context.Background()
	const schema = "it_httpapi_maps"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	vocations, err := content.LoadVocations(filepath.Join("..", "..", "..", "data"))
	if err != nil {
		t.Fatal(err)
	}
	svc, err := auth.New(auth.Config{Repo: st, Clock: clock.Real{}, Vocations: vocations})
	if err != nil {
		t.Fatal(err)
	}
	h, err := httpapi.New(httpapi.Config{Auth: svc, Clock: clock.Real{}, MapSubmissions: st,
		MapSubmitLimits: httpapi.MapSubmitLimits{PerDay: 5}})
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
		req.Header.Set("Authorization", "Bearer "+token)
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
	login := func(email, role string) string {
		t.Helper()
		creds := `{"email":"` + email + `","password":"secreto123"}`
		call("POST", "/api/auth/register", "", creds, 201)
		if _, err := conn.Exec(ctx, `UPDATE accounts SET role = $1 WHERE email = $2`, role, email); err != nil {
			t.Fatal(err)
		}
		var l struct{ Token string }
		_ = json.Unmarshal(call("POST", "/api/auth/login", "", `{"email":"`+email+`","password":"secreto123","token_in_body":true}`, 200), &l)
		return l.Token
	}
	author := login("aria@example.org", "player")
	var c struct{ Character struct{ ID int64 } }
	_ = json.Unmarshal(call("POST", "/api/characters", author, `{"name":"Aria","vocation":"arcanist"}`, 201), &c)
	player := login("bo@example.org", "player")
	gm := login("gm@example.org", "gm")

	body := func(patch string) string {
		b, _ := json.Marshal(map[string]any{"title": "Muelle", "description": "", "character_id": c.Character.ID,
			"license": httpapi.MapLicense, "patch": patch})
		return string(b)
	}
	evil := `{"format":2,"kind":"rpg-map-patch","base_ref":"HEAD","files":[{"path":"server/cmd/gameserver/main.go","base":null,"content":"package main"}]}`
	call("POST", "/api/maps/submissions", author, body(evil), 400)
	var n int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM map_submissions`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("stored %d, %v", n, err)
	}

	var sub submissionResp
	_ = json.Unmarshal(call("POST", "/api/maps/submissions", author, body(validPatch(t)), 201), &sub)
	if sub.Submission.Author != "Aria" {
		t.Fatalf("author = %q", sub.Submission.Author)
	}
	id := strconv.FormatInt(sub.Submission.ID, 10)
	call("POST", "/api/maps/submissions", author, body(validPatch(t)), 409) // same patch, still pending

	call("GET", "/api/maps/submissions", player, "", 403)
	call("POST", "/api/maps/submissions/"+id+"/review", player, `{"decision":"approve"}`, 403)
	call("GET", "/api/maps/submissions/"+id+"/patch", player, "", 404)

	call("GET", "/api/maps/submissions/"+id+"/patch", gm, "", 200)
	call("POST", "/api/maps/submissions/"+id+"/review", gm, `{"decision":"approve","reason":"Bien hecho"}`, 200)
	call("POST", "/api/maps/submissions/"+id+"/review", gm, `{"decision":"reject","reason":"no"}`, 409)

	var status string
	if err := conn.QueryRow(ctx, `SELECT status FROM map_submissions WHERE id = $1`, sub.Submission.ID).Scan(&status); err != nil || status != "approved" {
		t.Fatalf("status = %q, %v", status, err)
	}
	rows, err := conn.Query(ctx, `SELECT action, source, args->>'submission_id' FROM audit_log ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var action, source, sid string
		if err := rows.Scan(&action, &source, &sid); err != nil {
			t.Fatal(err)
		}
		if source != "web" || sid != id {
			t.Errorf("audit %s: source %s, submission %s", action, source, sid)
		}
		got = append(got, action)
	}
	if want := []string{"map_submit", "map_download", "map_approve"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Errorf("audit = %v, want %v", got, want)
	}
}
