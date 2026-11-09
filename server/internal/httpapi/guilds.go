package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/guild"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Public guild pages (T5.1): GET /api/guilds lists every guild and GET /api/guilds/{id}
// shows one with its members and ranks. Only public data: names, ranks, vocation and
// level (as on the highscores, with the same exclusions: staff, disabled and banned
// accounts); never the message of the day, online status or anything of the accounts.
//
// Caching: the list lives in a cache of its own, so no other key can push it out. A
// page id above the highest guild id ever issued (as of the cached list) is a 404
// without a query. Pages of guilds that exist are cached apart from 404s (ids of
// disbanded guilds, at most as many as guilds ever founded), which have a small cache
// of their own: junk ids cannot fill the page cache. Like the highscores they share the public rate limit, the query slots
// and a cache of DefaultHighscoreCacheTTL (a change shows up within that time).

// PublicGuilds is the source of the public guild pages. *store.Store implements it.
type PublicGuilds interface {
	PublicGuilds(ctx context.Context, n int, now time.Time) (store.PublicGuildList, error)
	PublicGuild(ctx context.Context, id int64, now time.Time) (store.PublicGuildDetail, error)
}

var _ PublicGuilds = (*store.Store)(nil)

// MaxPublicGuilds is the most guilds GET /api/guilds lists (by name).
const MaxPublicGuilds = 500

// guildCacheEntries bounds the cache of guild pages and guildMissingEntries the one of
// 404s.
const (
	guildCacheEntries   = 1024
	guildMissingEntries = 256
)

// errGuildMissing: the guild of a page does not exist (a 404, cached apart).
var errGuildMissing = errors.New("guild not found")

type guildSummary struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Leader    string    `json:"leader"`
	Members   int       `json:"members"`
	CreatedAt time.Time `json:"created_at"`
}

type guildListResponse struct {
	Guilds []guildSummary `json:"guilds"`
}

type guildMemberEntry struct {
	Name     string `json:"name"`
	Vocation string `json:"vocation"`
	Level    int    `json:"level"`
	// Rank is "leader", "vice" or "member".
	Rank string `json:"rank"`
}

type guildPageResponse struct {
	ID        int64              `json:"id"`
	Name      string             `json:"name"`
	CreatedAt time.Time          `json:"created_at"`
	Members   []guildMemberEntry `json:"members"`
}

// guildList serves GET /api/guilds.
func (a *api) guildList(w http.ResponseWriter, r *http.Request) {
	body, err := a.listBody(r)
	a.writeGuildJSON(w, r, body, err)
}

// listBody returns the cached guild list, reading it when stale. Reading it also
// updates guildHigh.
func (a *api) listBody(r *http.Request) ([]byte, error) {
	return a.guildListC.get(r.Context(), "list", a.guildQuery(r, func(ctx context.Context) (any, error) {
		l, err := a.cfg.Guilds.PublicGuilds(ctx, MaxPublicGuilds, a.cfg.Clock.Now())
		if err != nil {
			return nil, err
		}
		a.guildHigh.Store(l.IDHigh)
		out := guildListResponse{Guilds: make([]guildSummary, len(l.Guilds))}
		for i, g := range l.Guilds {
			out.Guilds[i] = guildSummary{ID: g.ID, Name: g.Name, Leader: g.Leader, Members: g.Members, CreatedAt: g.CreatedAt.UTC()}
		}
		return out, nil
	}))
}

// guildPage serves GET /api/guilds/{id}.
func (a *api) guildPage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid_id")
		return
	}
	// A guild founded after the cached list was read shows up when the list does (60 s).
	if _, err := a.listBody(r); err == nil {
		if high := a.guildHigh.Load(); high >= 0 && id > high {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
	}
	key := strconv.FormatInt(id, 10)
	if _, missing := a.guildMissing.peek(key); missing {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	body, err := a.guildPages.get(r.Context(), key, a.guildQuery(r, func(ctx context.Context) (any, error) {
		g, err := a.cfg.Guilds.PublicGuild(ctx, id, a.cfg.Clock.Now())
		if errors.Is(err, store.ErrNotFound) {
			return nil, errGuildMissing // errors are not cached here: guildMissing keeps it
		}
		if err != nil {
			return nil, err
		}
		out := guildPageResponse{ID: g.ID, Name: g.Name, CreatedAt: g.CreatedAt.UTC(),
			Members: make([]guildMemberEntry, len(g.Members))}
		for i, m := range g.Members {
			out.Members[i] = guildMemberEntry{Name: m.Name, Vocation: m.Vocation, Level: m.Level, Rank: guild.Rank(m.Rank).String()}
		}
		return out, nil
	}))
	if errors.Is(err, errGuildMissing) {
		_, _ = a.guildMissing.get(r.Context(), key, func() ([]byte, error) { return []byte{}, nil })
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	a.writeGuildJSON(w, r, body, err)
}

// guildQuery wraps fill as a cache fill: JSON of its value, run with the highscores'
// query slots and time budget.
func (a *api) guildQuery(r *http.Request, fill func(context.Context) (any, error)) func() ([]byte, error) {
	return func() ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), a.cfg.HighscoreQueryTimeout)
		defer cancel()
		select {
		case a.querySlots <- struct{}{}:
			defer func() { <-a.querySlots }()
		case <-ctx.Done():
			return nil, errBusy
		}
		if ctx.Err() != nil {
			return nil, errBusy
		}
		v, err := fill(ctx)
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errBusy
		}
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		if err := json.NewEncoder(&buf).Encode(v); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}
}

func (a *api) writeGuildJSON(w http.ResponseWriter, r *http.Request, body []byte, err error) {
	switch {
	case errors.Is(err, errBusy):
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	case err != nil:
		a.fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=30")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
