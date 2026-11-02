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
			Save:          saver.Submit,
			AutosaveEvery: cfg.AutosaveEvery,
			Logger:        cfg.Logger,
		})
		if err != nil {
			return nil, err
		}
		a.World = w
		mv, flush := w.Systems()
		systems = append(systems, mv, flush)
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
	// The loop has stopped: this goroutine now owns the world.
	sctx, cancel := context.WithTimeout(context.Background(), a.cfg.ShutdownTimeout)
	defer cancel()
	online := a.World.Online()
	for _, s := range a.World.SaveAll() { // the saver's queue was full: write them here
		if err := a.writeSnapshot(sctx, s); err != nil {
			a.log.Error("final save failed", "character", s.CharacterID, "err", err)
		}
	}
	if err := a.Gateway.Shutdown(sctx); err != nil {
		a.log.Warn("closing connections", "err", err)
	}
	if err := a.saver.Stop(sctx); err != nil {
		a.log.Error("persistence did not drain", "err", err)
	}
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
		SavedAt:    a.cfg.Clock.Now(),
	})
	if errors.Is(err, store.ErrNotFound) {
		return session.ErrGone
	}
	return err
}

func (a *App) snapshotSaved(s session.Snapshot) {
	if s.Final {
		_ = a.Loop.Enqueue(a.World.Saved(s.CharacterID, s.Seq)) // lost ack: harmless
	}
}
