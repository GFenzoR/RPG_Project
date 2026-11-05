package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// fakeRanking returns n characters per ranking, ranked by name, and counts the queries.
type fakeRanking struct {
	n       int
	calls   atomic.Int32
	last    store.HighscoreQuery
	mu      sync.Mutex
	fail    error
	release chan struct{} // if set, every query waits for it
}

func (f *fakeRanking) Highscores(_ context.Context, q store.HighscoreQuery) ([]store.HighscoreRow, error) {
	f.calls.Add(1)
	if f.release != nil {
		<-f.release
	}
	f.mu.Lock()
	f.last = q
	err := f.fail
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var out []store.HighscoreRow
	for i := q.Offset; i < f.n && len(out) < q.Limit; i++ {
		out = append(out, store.HighscoreRow{Name: fmt.Sprintf("Char%03d", i), Vocation: "guardian", Value: int64(1000 - i)})
	}
	return out, nil
}

type hsBody struct {
	Category, Vocation string
	Page               int
	PageSize           int  `json:"page_size"`
	HasMore            bool `json:"has_more"`
	Entries            []struct {
		Rank           int
		Name, Vocation string
		Value          int64
	}
}

func publicHarness(t *testing.T, f *fakeRanking) *harness {
	t.Helper()
	return newHarness(t, func(c *httpapi.Config) {
		c.Highscores = f
		c.Skills = map[string]int{"sword": 10, "magic": 0}
		c.Vocations = []string{"guardian", "arcanist"}
		c.Status = func() httpapi.Status { return httpapi.Status{Online: true, Players: 7} }
		c.Version = "v1.2.3"
	})
}

func decodeHS(t *testing.T, h *harness, path string) hsBody {
	t.Helper()
	w := h.do(req{method: "GET", path: path})
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s = %d %s", path, w.Code, w.Body.String())
	}
	var b hsBody
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestHighscoresPagingAndParams(t *testing.T) {
	f := &fakeRanking{n: 45}
	h := publicHarness(t, f)

	b := decodeHS(t, h, "/api/highscores")
	if b.Category != "level" || b.Page != 1 || b.PageSize != httpapi.HighscorePageSize || !b.HasMore || len(b.Entries) != 20 {
		t.Fatalf("page 1 = %+v", b)
	}
	if b.Entries[0].Rank != 1 || b.Entries[0].Name != "Char000" || b.Entries[19].Rank != 20 {
		t.Fatalf("entries = %+v", b.Entries)
	}
	if f.last.Skill != "" || f.last.Offset != 0 || f.last.Limit != 21 {
		t.Fatalf("query = %+v", f.last)
	}

	b = decodeHS(t, h, "/api/highscores?category=sword&vocation=arcanist&page=3")
	if b.HasMore || len(b.Entries) != 5 || b.Entries[0].Rank != 41 || b.Vocation != "arcanist" {
		t.Fatalf("page 3 = %+v", b)
	}
	if f.last.Skill != "sword" || f.last.BaseLevel != 10 || f.last.Vocation != "arcanist" || f.last.Offset != 40 {
		t.Fatalf("query = %+v", f.last)
	}
	decodeHS(t, h, "/api/highscores?category=magic")
	if f.last.Skill != "magic" || f.last.BaseLevel != 0 {
		t.Fatalf("query = %+v", f.last)
	}

	for path, code := range map[string]string{
		"/api/highscores?category=dancing":    "invalid_category",
		"/api/highscores?vocation=monk":       "invalid_vocation",
		"/api/highscores?page=0":              "invalid_page",
		"/api/highscores?page=x":              "invalid_page",
		"/api/highscores?page=51":             "invalid_page",
		"/api/highscores?category=level&page": "", // empty page = 1
	} {
		w := h.do(req{method: "GET", path: path})
		if code == "" {
			if w.Code != http.StatusOK {
				t.Fatalf("%s = %d", path, w.Code)
			}
			continue
		}
		expect(t, w, http.StatusBadRequest, code)
	}
}

func TestHighscoresLastPageHasNoMore(t *testing.T) {
	f := &fakeRanking{n: 5000}
	h := publicHarness(t, f)
	b := decodeHS(t, h, fmt.Sprintf("/api/highscores?page=%d", httpapi.HighscoreMaxPages))
	if b.HasMore || len(b.Entries) != 20 {
		t.Fatalf("last page = %+v", b)
	}
}

func TestHighscoresCache(t *testing.T) {
	f := &fakeRanking{n: 3}
	h := publicHarness(t, f)
	decodeHS(t, h, "/api/highscores")
	decodeHS(t, h, "/api/highscores?category=level&page=1")
	if f.calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1 (same key)", f.calls.Load())
	}
	decodeHS(t, h, "/api/highscores?vocation=guardian")
	if f.calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2 (other key)", f.calls.Load())
	}
	h.clock.Advance(59 * time.Second)
	decodeHS(t, h, "/api/highscores")
	if f.calls.Load() != 2 {
		t.Fatalf("calls = %d, want 2 (still fresh)", f.calls.Load())
	}
	h.clock.Advance(2 * time.Second)
	decodeHS(t, h, "/api/highscores")
	if f.calls.Load() != 3 {
		t.Fatalf("calls = %d, want 3 (expired)", f.calls.Load())
	}

	// Errors are not cached.
	f.mu.Lock()
	f.fail = errors.New("db down")
	f.mu.Unlock()
	expect(t, h.do(req{method: "GET", path: "/api/highscores?page=2"}), http.StatusInternalServerError, "internal")
	f.mu.Lock()
	f.fail = nil
	f.mu.Unlock()
	decodeHS(t, h, "/api/highscores?page=2")
	if f.calls.Load() != 5 {
		t.Fatalf("calls = %d, want 5", f.calls.Load())
	}
}

func TestHighscoresConcurrentMissQueriesOnce(t *testing.T) {
	f := &fakeRanking{n: 3, release: make(chan struct{})}
	h := publicHarness(t, f)
	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = h.do(req{method: "GET", path: "/api/highscores", remote: fmt.Sprintf("10.0.0.%d:1", i)}).Code
		}()
	}
	for f.calls.Load() == 0 {
		time.Sleep(time.Millisecond) //nolint:forbidigo // waits for the real goroutines
	}
	time.Sleep(20 * time.Millisecond) //nolint:forbidigo // lets the others reach the cache
	close(f.release)
	wg.Wait()
	if f.calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", f.calls.Load())
	}
	for _, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("codes = %v", codes)
		}
	}
}

func TestPublicRateLimit(t *testing.T) {
	f := &fakeRanking{n: 1}
	h := newHarness(t, func(c *httpapi.Config) {
		c.Highscores = f
		c.PublicRateLimit = httpapi.RateLimit{Burst: 2, Every: time.Minute}
	})
	for i := range 2 {
		if w := h.do(req{method: "GET", path: "/api/status"}); w.Code != http.StatusOK {
			t.Fatalf("request %d = %d", i, w.Code)
		}
	}
	expect(t, h.do(req{method: "GET", path: "/api/highscores"}), http.StatusTooManyRequests, "rate_limited")
	if w := h.do(req{method: "GET", path: "/api/status", remote: "10.9.9.9:1"}); w.Code != http.StatusOK {
		t.Fatalf("other IP = %d", w.Code)
	}
}

func TestStatus(t *testing.T) {
	h := publicHarness(t, &fakeRanking{})
	w := h.do(req{method: "GET", path: "/api/status"})
	var b struct {
		Online  bool
		Players int
		Version string
	}
	if err := json.Unmarshal(w.Body.Bytes(), &b); err != nil || w.Code != 200 {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	if !b.Online || b.Players != 7 || b.Version != "v1.2.3" {
		t.Fatalf("status = %+v", b)
	}

	// Without a status source (API only) the server says it is not running a world.
	h = newHarness(t, nil)
	w = h.do(req{method: "GET", path: "/api/status"})
	if w.Code != 200 || w.Body.String() != `{"online":false,"players":0,"version":""}`+"\n" {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	// No ranking source: 404 like any unknown route.
	expect(t, h.do(req{method: "GET", path: "/api/highscores"}), http.StatusNotFound, "not_found")
}

type panickyRanking struct{ calls atomic.Int32 }

func (p *panickyRanking) Highscores(context.Context, store.HighscoreQuery) ([]store.HighscoreRow, error) {
	if p.calls.Add(1) == 1 {
		panic("boom") //nolint:forbidigo // the panic is what the test checks
	}
	return nil, nil
}

// A query that panics answers the standard 500 and is not cached.
func TestHighscoresQueryPanic(t *testing.T) {
	p := &panickyRanking{}
	h := newHarness(t, func(c *httpapi.Config) { c.Highscores = p })
	expect(t, h.do(req{method: "GET", path: "/api/highscores"}), http.StatusInternalServerError, "internal")
	if w := h.do(req{method: "GET", path: "/api/highscores"}); w.Code != http.StatusOK {
		t.Fatalf("after a panic = %d %s", w.Code, w.Body.String())
	}
}

// blockingRanking blocks every query until its context ends, then returns what pgx does:
// an error that wraps context.DeadlineExceeded.
type blockingRanking struct{ calls atomic.Int32 }

func (b *blockingRanking) Highscores(ctx context.Context, _ store.HighscoreQuery) ([]store.HighscoreRow, error) {
	b.calls.Add(1)
	<-ctx.Done()
	return nil, fmt.Errorf("highscores by level: %w", ctx.Err())
}

// A query over its time budget answers 503 busy, not 500.
func TestHighscoresQueryOverBudgetIsBusy(t *testing.T) {
	b := &blockingRanking{}
	h := newHarness(t, func(c *httpapi.Config) {
		c.Highscores = b
		c.HighscoreQueryTimeout = 50 * time.Millisecond
	})
	expect(t, h.do(req{method: "GET", path: "/api/highscores"}), http.StatusServiceUnavailable, "busy")
	if n := b.calls.Load(); n != 1 {
		t.Fatalf("queries = %d, want 1", n)
	}
}

// A request that never gets a query slot within its budget answers 503 busy.
func TestHighscoresNoSlotIsBusy(t *testing.T) {
	f := &fakeRanking{n: 3, release: make(chan struct{})} // ignores its context
	h := newHarness(t, func(c *httpapi.Config) {
		c.Highscores = f
		c.Vocations = []string{"guardian", "arcanist"}
		c.HighscoreQueryTimeout = 50 * time.Millisecond
	})
	var wg sync.WaitGroup
	for i, p := range []string{"/api/highscores", "/api/highscores?vocation=guardian"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.do(req{method: "GET", path: p, remote: fmt.Sprintf("10.1.0.%d:1", i)})
		}()
	}
	for f.calls.Load() < 2 { // both slots taken
		time.Sleep(time.Millisecond) //nolint:forbidigo // waits for the real goroutines
	}
	expect(t, h.do(req{method: "GET", path: "/api/highscores?vocation=arcanist"}), http.StatusServiceUnavailable, "busy")
	if n := f.calls.Load(); n != 2 {
		t.Fatalf("queries = %d, want 2", n)
	}
	close(f.release)
	wg.Wait()
}
