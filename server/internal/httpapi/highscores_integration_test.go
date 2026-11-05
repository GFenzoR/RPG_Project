//go:build integration

package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// TestHighscoresWithPostgres runs the real queries: filters, exclusions (staff, disabled
// and banned accounts; a lifted or expired ban ranks again), base skill level for
// characters without a row, tie order, paging and the cache.
func TestHighscoresWithPostgres(t *testing.T) {
	const schema = "it_highscores"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)
	ctx := context.Background()
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	account := func(email, role string) int64 {
		t.Helper()
		var id int64
		if err := conn.QueryRow(ctx, `INSERT INTO accounts (email, role) VALUES ($1, $2) RETURNING id`, email, role).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	char := func(acc int64, name, voc string, level int, exp int64) int64 {
		t.Helper()
		var id int64
		if err := conn.QueryRow(ctx, `INSERT INTO characters (account_id, name, vocation, level, experience, health, mana)
			VALUES ($1, $2, $3, $4, $5, 100, 10) RETURNING id`, acc, name, voc, level, exp).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}

	p1 := account("p1@example.org", "player")
	p2 := account("p2@example.org", "player")
	gm := account("gm@example.org", "gm")
	admin := account("admin@example.org", "admin")
	disabled := account("off@example.org", "player")
	banned := account("ban@example.org", "player")
	tempBanned := account("temp@example.org", "player")
	lifted := account("lifted@example.org", "player")
	expired := account("expired@example.org", "player")
	exec(`UPDATE accounts SET disabled_at = $2 WHERE id = $1`, disabled, now)
	exec(`INSERT INTO account_bans (account_id, reason, created_at) VALUES ($1, 'x', $2)`, banned, now.Add(-time.Hour))
	exec(`INSERT INTO account_bans (account_id, reason, created_at, expires_at) VALUES ($1, 'x', $2, $3)`, tempBanned, now.Add(-time.Hour), now.Add(time.Hour))
	exec(`INSERT INTO account_bans (account_id, reason, created_at, lifted_at) VALUES ($1, 'x', $2, $2)`, lifted, now.Add(-time.Hour))
	exec(`INSERT INTO account_bans (account_id, reason, created_at, expires_at) VALUES ($1, 'x', $2, $3)`, expired, now.Add(-2*time.Hour), now.Add(-time.Hour))

	ana := char(p1, "Ana", "guardian", 20, 9000)
	char(p1, "Bea", "arcanist", 20, 9500) // same level, more experience: above Ana
	carl := char(p2, "Carl", "guardian", 8, 100)
	char(gm, "Gamemaster", "guardian", 99, 1)
	char(admin, "Root", "arcanist", 99, 1)
	char(disabled, "Ghost", "guardian", 50, 1)
	char(banned, "Cheater", "guardian", 60, 1)
	char(tempBanned, "Paused", "arcanist", 40, 1)
	char(lifted, "Forgiven", "guardian", 15, 1)
	char(expired, "Served", "arcanist", 12, 1)
	exec(`INSERT INTO character_skills (character_id, skill, level, tries) VALUES ($1, 'sword', 30, 5), ($2, 'sword', 30, 9)`, ana, carl)

	clk := clock.NewFake(now)
	svc, err := auth.New(auth.Config{Repo: authtest.NewRepo(), Clock: clk, Vocations: content.Vocations{"guardian": {ID: "guardian"}}})
	if err != nil {
		t.Fatal(err)
	}
	h, err := httpapi.New(httpapi.Config{
		Auth: svc, Clock: clk, Highscores: st,
		Skills:    map[string]int{"sword": 10, "mining": 1},
		Vocations: []string{"guardian", "arcanist"},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	type entry struct {
		Rank     int
		Name     string
		Vocation string
		Value    int64
	}
	get := func(path string) ([]entry, bool) {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s = %d", path, resp.StatusCode)
		}
		var b struct {
			HasMore bool `json:"has_more"`
			Entries []entry
		}
		if err := json.NewDecoder(resp.Body).Decode(&b); err != nil {
			t.Fatal(err)
		}
		return b.Entries, b.HasMore
	}
	names := func(es []entry) string {
		s := ""
		for _, e := range es {
			s += fmt.Sprintf("%d.%s:%d ", e.Rank, e.Name, e.Value)
		}
		return s
	}

	es, more := get("/api/highscores")
	if got, want := names(es), "1.Bea:20 2.Ana:20 3.Forgiven:15 4.Served:12 5.Carl:8 "; got != want || more {
		t.Fatalf("level = %q (more %v), want %q", got, more, want)
	}
	es, _ = get("/api/highscores?vocation=arcanist")
	if got, want := names(es), "1.Bea:20 2.Served:12 "; got != want || es[0].Vocation != "arcanist" {
		t.Fatalf("arcanists = %q, want %q", got, want)
	}
	// Carl has more tries at the same level; the others are at the base level 10.
	es, _ = get("/api/highscores?category=sword")
	if got, want := names(es), "1.Carl:30 2.Ana:30 3.Bea:10 4.Forgiven:10 5.Served:10 "; got != want {
		t.Fatalf("sword = %q, want %q", got, want)
	}
	es, _ = get("/api/highscores?category=mining&vocation=guardian")
	if got, want := names(es), "1.Ana:1 2.Carl:1 3.Forgiven:1 "; got != want {
		t.Fatalf("mining = %q, want %q", got, want)
	}

	// Paging: 25 more players at level 2.
	for i := range 25 {
		char(p2, fmt.Sprintf("Filler%c%c", 'a'+i/26, 'a'+i%26), "guardian", 2, int64(100-i))
	}
	es, _ = get("/api/highscores") // cached: the new rows are not seen yet
	if len(es) != 5 {
		t.Fatalf("cached page = %q", names(es))
	}
	clk.Advance(httpapi.DefaultHighscoreCacheTTL + time.Second)
	es, more = get("/api/highscores")
	if len(es) != 20 || !more || es[5].Name != "Filleraa" {
		t.Fatalf("page 1 = %q (more %v)", names(es), more)
	}
	es, more = get("/api/highscores?page=2")
	if len(es) != 10 || more || es[0].Rank != 21 || es[9].Name != "Filleray" {
		t.Fatalf("page 2 = %q (more %v)", names(es), more)
	}
	if es, _ = get("/api/highscores?page=3"); len(es) != 0 {
		t.Fatalf("page 3 = %q", names(es))
	}
	// A skill ranking pages across its two parts: 2 characters with a sword row, then 28 at
	// the base level by age (Bea, Forgiven, Served, then the fillers).
	es, more = get("/api/highscores?category=sword")
	if len(es) != 20 || !more || es[1].Name != "Ana" || es[2].Name != "Bea" || es[19].Name != "Fillerao" {
		t.Fatalf("sword page 1 = %q (more %v)", names(es), more)
	}
	es, more = get("/api/highscores?category=sword&page=2")
	if len(es) != 10 || more || es[0].Rank != 21 || es[0].Name != "Fillerap" || es[9].Name != "Filleray" || es[9].Value != 10 {
		t.Fatalf("sword page 2 = %q (more %v)", names(es), more)
	}
}
