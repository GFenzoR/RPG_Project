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
// level (as on the highscores); never the message of the day, online status or anything
// of the accounts. Like the highscores they share the public rate limit, the query slots
// and a cache of DefaultHighscoreCacheTTL (a change shows up within that time).

// PublicGuilds is the source of the public guild pages. *store.Store implements it.
type PublicGuilds interface {
	PublicGuilds(ctx context.Context, n int) ([]store.PublicGuildSummary, error)
	PublicGuild(ctx context.Context, id int64) (store.PublicGuildDetail, error)
}

var _ PublicGuilds = (*store.Store)(nil)

// MaxPublicGuilds is the most guilds GET /api/guilds lists (by name).
const MaxPublicGuilds = 500

// guildCacheEntries bounds the guild cache: the list plus this many guild pages.
const guildCacheEntries = 1024

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
	a.cachedGuildJSON(w, r, "list", func(ctx context.Context) (any, error) {
		gs, err := a.cfg.Guilds.PublicGuilds(ctx, MaxPublicGuilds)
		if err != nil {
			return nil, err
		}
		out := guildListResponse{Guilds: make([]guildSummary, len(gs))}
		for i, g := range gs {
			out.Guilds[i] = guildSummary{ID: g.ID, Name: g.Name, Leader: g.Leader, Members: g.Members, CreatedAt: g.CreatedAt.UTC()}
		}
		return out, nil
	})
}

// guildPage serves GET /api/guilds/{id}.
func (a *api) guildPage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid_id")
		return
	}
	a.cachedGuildJSON(w, r, "g"+strconv.FormatInt(id, 10), func(ctx context.Context) (any, error) {
		g, err := a.cfg.Guilds.PublicGuild(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			return nil, nil // cached as a 404 too: random ids cannot reach the database
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
	})
}

// cachedGuildJSON answers with the cached JSON of key, computing it with fill (a nil
// value is a 404). It uses the highscores' query slots and time budget.
func (a *api) cachedGuildJSON(w http.ResponseWriter, r *http.Request, key string, fill func(context.Context) (any, error)) {
	body, err := a.guildCache.get(r.Context(), key, func() ([]byte, error) {
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
		if v == nil {
			return []byte{}, nil
		}
		var buf bytes.Buffer
		if err := json.NewEncoder(&buf).Encode(v); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	})
	switch {
	case errors.Is(err, errBusy):
		writeError(w, http.StatusServiceUnavailable, "busy")
		return
	case err != nil:
		a.fail(w, r, err)
		return
	case len(body) == 0:
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=30")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
