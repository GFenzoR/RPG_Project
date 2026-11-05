package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Public endpoints of the website (T4.3): the highscores and the server status. They need
// no account, so they share one per-IP limiter of their own (failOpen, like the auth one).

// Highscores is the ranking source. *store.Store implements it.
type Highscores interface {
	Highscores(ctx context.Context, q store.HighscoreQuery) ([]store.HighscoreRow, error)
}

var _ Highscores = (*store.Store)(nil)

// Status is what /api/status reports. The App reads it from values the game loop
// publishes (atomics), never from the world itself.
type Status struct {
	Online  bool
	Players int
}

// Highscore paging (docs/05-network-protocol.md, "API HTTP").
const (
	HighscorePageSize = 20
	HighscoreMaxPages = 50
	// LevelCategory ranks by level; every other category is a skill id.
	LevelCategory = "level"
)

// Defaults of the public endpoints.
var (
	// DefaultPublicRateLimit: highscores and status requests per client IP (IPv6: /64).
	DefaultPublicRateLimit = RateLimit{Burst: 30, Every: 500 * time.Millisecond}
	// DefaultHighscoreCacheTTL: how long a page of the ranking is served from memory.
	DefaultHighscoreCacheTTL = 60 * time.Second
)

// Ranking queries at once (different keys) and how long one may wait for its turn and
// run: the pgx pool is shared with the game's saves, so the website never takes more than
// this from it.
const (
	maxHighscoreQueries   = 2
	highscoreQueryTimeout = 5 * time.Second
)

type highscoreEntry struct {
	Rank     int    `json:"rank"`
	Name     string `json:"name"`
	Vocation string `json:"vocation"`
	Value    int64  `json:"value"`
}

type highscoreResponse struct {
	Category string           `json:"category"`
	Vocation string           `json:"vocation"`
	Page     int              `json:"page"`
	PageSize int              `json:"page_size"`
	HasMore  bool             `json:"has_more"`
	Entries  []highscoreEntry `json:"entries"`
}

type statusResponse struct {
	Online  bool   `json:"online"`
	Players int    `json:"players"`
	Version string `json:"version"`
}

// cacheEntry is one cached page. While the first request computes it (done false), the
// others wait on ready instead of querying Postgres too.
type cacheEntry struct {
	ready   chan struct{}
	done    bool
	body    []byte
	err     error
	expires time.Time
}

// pageCache is a small TTL cache of encoded responses with one query in flight per key.
// Its size is bounded by max, the number of valid keys (category × vocation × page).
type pageCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	max     int
	clock   clock.Clock
	entries map[string]*cacheEntry
}

func newPageCache(ttl time.Duration, maxEntries int, clk clock.Clock) *pageCache {
	return &pageCache{ttl: ttl, max: maxEntries, clock: clk, entries: make(map[string]*cacheEntry)}
}

// get returns the body cached under key, or computes it with fill. Errors are not cached.
// A request waiting for another one's query gives up when its own ctx ends.
func (c *pageCache) get(ctx context.Context, key string, fill func() ([]byte, error)) (body []byte, err error) {
	now := c.clock.Now()
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && (!e.done || now.Before(e.expires)) {
		c.mu.Unlock()
		select {
		case <-e.ready:
			return e.body, e.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if len(c.entries) >= c.max {
		for k, e := range c.entries {
			if e.done && !now.Before(e.expires) {
				delete(c.entries, k)
			}
		}
	}
	e := &cacheEntry{ready: make(chan struct{})}
	if len(c.entries) < c.max {
		c.entries[key] = e
	}
	c.mu.Unlock()

	defer func() { // also runs if fill panics: waiters never hang and the caller gets a 500
		if v := recover(); v != nil {
			body, err = nil, fmt.Errorf("highscores: query panicked: %v", v)
		}
		c.mu.Lock()
		// The TTL counts from the end of the query, not from the request.
		e.body, e.err, e.done, e.expires = body, err, true, c.clock.Now().Add(c.ttl)
		if err != nil && c.entries[key] == e {
			delete(c.entries, key)
		}
		c.mu.Unlock()
		close(e.ready)
	}()
	return fill()
}

// errBusy: every ranking query slot stayed taken for highscoreQueryTimeout.
var errBusy = errors.New("highscores: database busy")

// highscores serves GET /api/highscores?category=level|<skill>&vocation=<id>&page=N.
func (a *api) highscores(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	category := q.Get("category")
	if category == "" {
		category = LevelCategory
	}
	base, isSkill := a.cfg.Skills[category]
	if category != LevelCategory && !isSkill {
		writeError(w, http.StatusBadRequest, "invalid_category")
		return
	}
	vocation := q.Get("vocation")
	if vocation != "" && !a.vocations[vocation] {
		writeError(w, http.StatusBadRequest, "invalid_vocation")
		return
	}
	page := 1
	if p := q.Get("page"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > HighscoreMaxPages {
			writeError(w, http.StatusBadRequest, "invalid_page")
			return
		}
		page = n
	}
	key := category + "\x00" + vocation + "\x00" + strconv.Itoa(page)
	body, err := a.cache.get(r.Context(), key, func() ([]byte, error) {
		// The query outlives a client that goes away (others may be waiting on it), but not
		// highscoreQueryTimeout, waiting for a free slot included.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), highscoreQueryTimeout)
		defer cancel()
		select {
		case a.querySlots <- struct{}{}:
			defer func() { <-a.querySlots }()
		case <-ctx.Done():
			return nil, errBusy
		}
		now := a.cfg.Clock.Now()
		skill := ""
		if isSkill {
			skill = category
		}
		rows, err := a.cfg.Highscores.Highscores(ctx, store.HighscoreQuery{
			Skill: skill, BaseLevel: base, Vocation: vocation,
			Offset: (page - 1) * HighscorePageSize, Limit: HighscorePageSize + 1, Now: now,
		})
		if err != nil {
			return nil, err
		}
		resp := highscoreResponse{
			Category: category, Vocation: vocation, Page: page, PageSize: HighscorePageSize,
			HasMore: len(rows) > HighscorePageSize && page < HighscoreMaxPages,
			Entries: make([]highscoreEntry, 0, min(len(rows), HighscorePageSize)),
		}
		for i, row := range rows[:min(len(rows), HighscorePageSize)] {
			resp.Entries = append(resp.Entries, highscoreEntry{
				Rank: (page-1)*HighscorePageSize + i + 1, Name: row.Name, Vocation: row.Vocation, Value: row.Value,
			})
		}
		var buf bytes.Buffer
		if err := json.NewEncoder(&buf).Encode(resp); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	})
	if errors.Is(err, errBusy) {
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// Same answer for everyone; a browser may keep it a little (the server caches longer).
	w.Header().Set("Cache-Control", "public, max-age=30")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// status serves GET /api/status: cheap, no database.
func (a *api) status(w http.ResponseWriter, _ *http.Request) {
	var s Status
	if a.cfg.Status != nil {
		s = a.cfg.Status()
	}
	writeJSON(w, http.StatusOK, statusResponse{Online: s.Online, Players: s.Players, Version: a.cfg.Version})
}

func (a *api) publicLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ok, _ := a.publicLimiter.allow(a.clientKey(r)); !ok {
			a.tooMany(w, a.cfg.PublicRateLimit)
			return
		}
		next(w, r)
	}
}
