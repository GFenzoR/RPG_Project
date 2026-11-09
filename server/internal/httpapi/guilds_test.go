package httpapi_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

type fakeGuilds struct{ list, page atomic.Int32 }

func (f *fakeGuilds) PublicGuilds(_ context.Context, n int, _ time.Time) (store.PublicGuildList, error) {
	f.list.Add(1)
	return store.PublicGuildList{IDHigh: 5, Guilds: []store.PublicGuildSummary{{ID: 3, Name: "Salt Lanterns", Leader: "Ana",
		Members: 2, CreatedAt: time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)}}}, nil
}

func (f *fakeGuilds) PublicGuild(_ context.Context, id int64, _ time.Time) (store.PublicGuildDetail, error) {
	f.page.Add(1)
	if id != 3 {
		return store.PublicGuildDetail{}, store.ErrNotFound
	}
	return store.PublicGuildDetail{ID: 3, Name: "Salt Lanterns", Members: []store.PublicGuildMember{
		{Name: "Ana", Vocation: "guardian", Level: 20, Rank: 3}, {Name: "Bea", Vocation: "arcanist", Level: 9, Rank: 1}}}, nil
}

// The public guild pages: list and detail as JSON with ranks by name, 400 for a bad id,
// and the caches in front of the database: an id above the highest ever issued (5) is a
// 404 without a query, the 404 of a disbanded guild (4) is cached apart.
func TestPublicGuilds(t *testing.T) {
	f := &fakeGuilds{}
	h := newHarness(t, func(c *httpapi.Config) { c.Guilds = f })
	for range 3 {
		w := h.do(req{method: "GET", path: "/api/guilds"})
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"name":"Salt Lanterns","leader":"Ana","members":2`) {
			t.Fatalf("list = %d %s", w.Code, w.Body.String())
		}
	}
	w := h.do(req{method: "GET", path: "/api/guilds/3"})
	body := w.Body.String()
	if w.Code != http.StatusOK || !strings.Contains(body, `{"name":"Ana","vocation":"guardian","level":20,"rank":"leader"}`) ||
		!strings.Contains(body, `"rank":"member"`) || strings.Contains(body, "motd") {
		t.Fatalf("page = %d %s", w.Code, body)
	}
	for _, path := range []string{"/api/guilds/77", "/api/guilds/77", "/api/guilds/4", "/api/guilds/4"} {
		if w := h.do(req{method: "GET", path: path}); w.Code != http.StatusNotFound {
			t.Fatalf("%s = %d", path, w.Code)
		}
	}
	if w := h.do(req{method: "GET", path: "/api/guilds/abc"}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad id = %d", w.Code)
	}
	if f.list.Load() != 1 || f.page.Load() != 2 {
		t.Fatalf("queries: list %d, pages %d (want 1 and 2: page 3 and the first 404 of 4)", f.list.Load(), f.page.Load())
	}
}

// A flood of junk ids (from many addresses, inside the per-IP limit) reaches no query
// and does not push the list or real pages out of their caches.
func TestPublicGuildsFlood(t *testing.T) {
	f := &fakeGuilds{}
	h := newHarness(t, func(c *httpapi.Config) { c.Guilds = f })
	for i := range 1200 {
		remote := fmt.Sprintf("10.0.%d.%d:1234", i/20/250, i/20%250+1)
		if w := h.do(req{method: "GET", path: fmt.Sprintf("/api/guilds/%d", 1001+i), remote: remote}); w.Code != http.StatusNotFound {
			t.Fatalf("junk id = %d", w.Code)
		}
	}
	for range 5 {
		for _, p := range []string{"/api/guilds", "/api/guilds/3", "/api/guilds/99999"} {
			h.do(req{method: "GET", path: p, remote: "192.0.2.9:1234"})
		}
	}
	if f.list.Load() != 1 || f.page.Load() != 1 {
		t.Fatalf("after the flood: %d list and %d page queries, want 1 and 1", f.list.Load(), f.page.Load())
	}
}

// Without a source the guild pages do not exist.
func TestPublicGuildsOff(t *testing.T) {
	h := newHarness(t, func(*httpapi.Config) {})
	if w := h.do(req{method: "GET", path: "/api/guilds"}); w.Code != http.StatusNotFound {
		t.Fatalf("GET /api/guilds without guilds = %d", w.Code)
	}
}
