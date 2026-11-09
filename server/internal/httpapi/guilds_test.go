package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

type fakeGuilds struct{ list, page atomic.Int32 }

func (f *fakeGuilds) PublicGuilds(_ context.Context, n int) ([]store.PublicGuildSummary, error) {
	f.list.Add(1)
	return []store.PublicGuildSummary{{ID: 3, Name: "Salt Lanterns", Leader: "Ana", Members: 2,
		CreatedAt: time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)}}, nil
}

func (f *fakeGuilds) PublicGuild(_ context.Context, id int64) (store.PublicGuildDetail, error) {
	f.page.Add(1)
	if id != 3 {
		return store.PublicGuildDetail{}, store.ErrNotFound
	}
	return store.PublicGuildDetail{ID: 3, Name: "Salt Lanterns", Members: []store.PublicGuildMember{
		{Name: "Ana", Vocation: "guardian", Level: 20, Rank: 3}, {Name: "Bea", Vocation: "arcanist", Level: 9, Rank: 1}}}, nil
}

// The public guild pages: list and detail as JSON with ranks by name, a 404 for a
// missing id (cached like the rest), 400 for a bad id, and the cache in front of the
// database.
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
	for range 2 {
		if w := h.do(req{method: "GET", path: "/api/guilds/77"}); w.Code != http.StatusNotFound {
			t.Fatalf("missing = %d", w.Code)
		}
	}
	if w := h.do(req{method: "GET", path: "/api/guilds/abc"}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad id = %d", w.Code)
	}
	if f.list.Load() != 1 || f.page.Load() != 2 {
		t.Fatalf("queries: list %d, pages %d (want 1 and 2: cached)", f.list.Load(), f.page.Load())
	}
}

// Without a source the guild pages do not exist.
func TestPublicGuildsOff(t *testing.T) {
	h := newHarness(t, func(*httpapi.Config) {})
	if w := h.do(req{method: "GET", path: "/api/guilds"}); w.Code != http.StatusNotFound {
		t.Fatalf("GET /api/guilds without guilds = %d", w.Code)
	}
}
