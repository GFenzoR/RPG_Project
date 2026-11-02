// Package app assembles the game server: game loop, session world, persistence
// goroutine, WebSocket gateway and HTTP API. cmd/gameserver and the integration tests
// build the same stack through it.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/net/gateway"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Store is the persistence the server needs. *store.Store implements it.
type Store interface {
	auth.Repo
	gateway.Characters
	SaveCharacterState(ctx context.Context, c store.CharacterState) error
	Ping(ctx context.Context) error
}

// Config configures an App.
type Config struct {
	Store     Store
	Clock     clock.Clock
	Logger    *slog.Logger
	Seed      uint64
	Vocations content.Vocations
	Balance   content.Balance
	// Monsters and Items come from data/ (session.Config); nil runs a world without monsters.
	Monsters content.Monsters
	Items    content.Items
	// Map is the loaded world. Nil runs the HTTP API only (no /ws).
	Map *world.Map

	CookieSecure     bool
	TrustProxy       bool
	OriginPatterns   []string
	MinClientVersion string
	// AutosaveEvery overrides session.DefaultAutosaveEvery (tests).
	AutosaveEvery game.Tick
	// ShutdownTimeout bounds the final saves and the closing of connections (default 10 s).
	ShutdownTimeout time.Duration
}

// App is an assembled server. Serve Handler over HTTP and call Run once.
type App struct {
	cfg     Config
	log     *slog.Logger
	Auth    *auth.Service
	Loop    *game.Loop
	World   *session.World
	Gateway *gateway.Gateway
	saver   *session.Saver
	handler http.Handler
}

// New builds the stack. Nothing runs until Run.
func New(cfg Config) (*App, error) {
	if cfg.Store == nil || cfg.Clock == nil {
		return nil, errors.New("app: Store and Clock are required")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	if cfg.ShutdownTimeout <= 0 {
		cfg.ShutdownTimeout = 10 * time.Second
	}
	a := &App{cfg: cfg, log: cfg.Logger}
	authSvc, err := auth.New(auth.Config{Repo: cfg.Store, Clock: cfg.Clock, Vocations: cfg.Vocations})
	if err != nil {
		return nil, err
	}
	a.Auth = authSvc
	api, err := httpapi.New(httpapi.Config{
		Auth:         authSvc,
		Clock:        cfg.Clock,
		Logger:       cfg.Logger,
		Health:       cfg.Store.Ping,
		CookieSecure: cfg.CookieSecure,
		TrustProxy:   cfg.TrustProxy,
	})
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/", api)
	a.handler = mux

	var systems []game.System
	if cfg.Map != nil {
		saver, err := session.NewSaver(session.SaverConfig{
			Write:  a.writeSnapshot,
			Saved:  a.snapshotSaved,
			Clock:  cfg.Clock,
			Logger: cfg.Logger,
		})
		if err != nil {
			return nil, err
		}
		a.saver = saver
		w, err := session.New(session.Config{
			Map:           cfg.Map,
			Balance:       cfg.Balance,
			Vocations:     cfg.Vocations,
			Monsters:      cfg.Monsters,
			Items:         cfg.Items,
			Save:          saver.Submit,
			AutosaveEvery: cfg.AutosaveEvery,
			Logger:        cfg.Logger,
		})
		if err != nil {
			return nil, err
		}
		a.World = w
		mv, fight, flush := w.Systems()
		systems = append(systems, mv, fight, flush)
	}

	loop, err := game.New(game.Config{
		Clock:   cfg.Clock,
		Rand:    rand.New(rand.NewPCG(cfg.Seed, cfg.Seed)),
		Systems: systems,
		Logger:  cfg.Logger,
	})
	if err != nil {
		return nil, fmt.Errorf("game loop: %w", err)
	}
	a.Loop = loop

	if a.World != nil {
		gw, err := gateway.New(gateway.Config{
			Accounts:         authSvc,
			Characters:       cfg.Store,
			Loop:             loop,
			World:            a.World,
			Clock:            cfg.Clock,
			Logger:           cfg.Logger,
			MinClientVersion: cfg.MinClientVersion,
			OriginPatterns:   cfg.OriginPatterns,
		})
		if err != nil {
			return nil, err
		}
		a.Gateway = gw
		mux.Handle("GET /ws", gw)
	} else {
		cfg.Logger.Warn("no world loaded: /ws is disabled")
	}
	return a, nil
}

// Handler serves the HTTP API and /ws.
func (a *App) Handler() http.Handler { return a.handler }

// Run runs the game loop until ctx is done, then saves every online player, closes
// every connection and waits for the persistence goroutine to finish (bounded by
// Config.ShutdownTimeout).
func (a *App) Run(ctx context.Context) error {
	if a.saver != nil {
		a.saver.Start()
	}
	runErr := a.Loop.Run(ctx)
	if runErr != nil {
		runErr = fmt.Errorf("game loop: %w", runErr)
	}
	if a.World == nil {
		return runErr
	}
	// The loop has stopped: this goroutine now owns the world. Each stage gets its own
	// deadline so a slow database cannot eat the others' time.
	online := a.World.Online()
	pending := a.World.SaveAll()
	stage := func(name string, fn func(context.Context) error) {
		sctx, cancel := context.WithTimeout(context.Background(), a.cfg.ShutdownTimeout)
		defer cancel()
		if err := fn(sctx); err != nil {
			a.log.Error("shutdown: "+name, "err", err)
		}
	}
	stage("closing connections", a.Gateway.Shutdown)
	// Drain the saver first: its queue holds older snapshots of the same characters, and
	// writing the pending (newer) ones concurrently could let an old one land last.
	stage("persistence did not drain", a.saver.Stop)
	stage("final saves", func(ctx context.Context) error {
		var errs []error
		for _, s := range pending { // the saver's queue was full when SaveAll ran
			if err := a.writeSnapshot(ctx, s); err != nil {
				errs = append(errs, fmt.Errorf("character %d: %w", s.CharacterID, err))
			}
		}
		return errors.Join(errs...)
	})
	a.log.Info("players saved at shutdown", "online", online, "ticks", uint64(a.Loop.Tick()))
	return runErr
}

func (a *App) writeSnapshot(ctx context.Context, s session.Snapshot) error {
	err := a.cfg.Store.SaveCharacterState(ctx, store.CharacterState{
		ID:         s.CharacterID,
		Level:      s.Level,
		Experience: s.Experience,
		Health:     s.Health,
		Mana:       s.Mana,
		X:          int(s.Pos.X),
		Y:          int(s.Pos.Y),
		Z:          int(s.Pos.Z),
		Skills:     storeSkills(s.Skills),
		SavedAt:    a.cfg.Clock.Now(),
	})
	switch {
	case errors.Is(err, store.ErrNotFound):
		return session.ErrGone
	case store.Permanent(err):
		return fmt.Errorf("%w: %w", session.ErrPermanent, err)
	}
	return err
}

func storeSkills(in []session.SkillState) []store.Skill {
	out := make([]store.Skill, len(in))
	for i, s := range in {
		out[i] = store.Skill{ID: s.ID, Level: s.Level, Tries: s.Tries}
	}
	return out
}

func (a *App) snapshotSaved(s session.Snapshot) {
	if s.Final {
		_ = a.Loop.Enqueue(a.World.Saved(s.CharacterID, s.Seq)) // lost ack: harmless
	}
}
