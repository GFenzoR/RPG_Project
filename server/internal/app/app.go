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
	"github.com/GFenzoR/RPG_Project/server/internal/metrics"
	"github.com/GFenzoR/RPG_Project/server/internal/net/gateway"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Store is the persistence the server needs. *store.Store implements it.
type Store interface {
	auth.Repo
	gateway.Characters
	AdminStore
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
	// Spells come from data/spells.yaml (session.Config); nil means no spells.
	Spells content.Spells
	// Recipes come from data/recipes.yaml (T3.4); nil means no crafting.
	Recipes content.Recipes
	// BoatRoutes come from data/boat_routes.yaml (T3.5); nil means no boat travel.
	BoatRoutes content.BoatRoutes
	// NPCs and Quests come from data/npcs and data/quests (session.Config); nil means
	// no NPCs.
	NPCs   content.NPCs
	Quests content.Quests
	// Map is the loaded world. Nil runs the HTTP API only (no /ws).
	Map *world.Map

	CookieSecure     bool
	TrustProxy       bool
	OriginPatterns   []string
	MinClientVersion string
	// StartTown is the island new characters start at (session.Config.StartTown).
	StartTown string
	// AuthRateLimit overrides httpapi.DefaultAuthRateLimit when non-zero (test harnesses).
	AuthRateLimit httpapi.RateLimit
	// AutosaveEvery overrides session.DefaultAutosaveEvery (tests).
	AutosaveEvery game.Tick
	// Metrics, if set, records the tick and network metrics (internal/metrics).
	Metrics *metrics.Metrics
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
	admin   *adminWorker
	// loopDone is closed when the game loop stopped (commands can no longer run).
	loopDone chan struct{}
	handler  http.Handler
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
	a := &App{cfg: cfg, log: cfg.Logger, loopDone: make(chan struct{})}
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
		// The zero value keeps httpapi.DefaultAuthRateLimit.
		AuthRateLimit: cfg.AuthRateLimit,
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
		a.admin = newAdminWorker(cfg.Store, cfg.Clock, cfg.Logger, a.adminDone, a.rolesChanged)
		w, err := session.New(session.Config{
			Map:           cfg.Map,
			StartTown:     cfg.StartTown,
			Balance:       cfg.Balance,
			Vocations:     cfg.Vocations,
			Monsters:      cfg.Monsters,
			Items:         cfg.Items,
			Spells:        cfg.Spells,
			Recipes:       cfg.Recipes,
			BoatRoutes:    cfg.BoatRoutes,
			NPCs:          cfg.NPCs,
			Quests:        cfg.Quests,
			Save:          saver.Submit,
			Admin:         a.admin.Submit,
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
		OnTick:  onTick(cfg.Metrics),
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
			Metrics:          gatewayMetrics(cfg.Metrics),
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

// onTick is the loop's OnTick hook for m (nil without metrics).
func onTick(m *metrics.Metrics) func(game.TickStats) {
	if m == nil {
		return nil
	}
	return m.ObserveTick
}

// gatewayMetrics avoids handing the gateway a non-nil interface holding a nil pointer.
func gatewayMetrics(m *metrics.Metrics) gateway.Observer {
	if m == nil {
		return nil
	}
	return m
}

// Handler serves the HTTP API and /ws.
func (a *App) Handler() http.Handler { return a.handler }

// Run runs the game loop until ctx is done, then saves every online player, closes
// every connection and waits for the persistence goroutine to finish (bounded by
// Config.ShutdownTimeout).
func (a *App) Run(ctx context.Context) error {
	if a.saver != nil {
		a.saver.Start()
		a.admin.Start()
	}
	runErr := a.Loop.Run(ctx)
	close(a.loopDone)
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
	pendingAdmin := a.World.PendingAdmin()
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
	stage("audit log did not drain", a.admin.Stop)
	stage("pending audit entries", func(ctx context.Context) error { return a.admin.writePending(ctx, pendingAdmin) })
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
		Inventory:  storeItems(s.Inventory),
		Storage:    s.Storage,
		Conditions: storeConditions(s.Conditions),
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

func storeConditions(in []session.ConditionState) []store.Condition {
	out := make([]store.Condition, len(in))
	for i, c := range in {
		out[i] = store.Condition{ID: c.ID, LeftMs: c.LeftMs, Ticks: c.Ticks, Damage: c.Damage}
	}
	return out
}

func storeSkills(in []session.SkillState) []store.Skill {
	out := make([]store.Skill, len(in))
	for i, s := range in {
		out[i] = store.Skill{ID: s.ID, Level: s.Level, Tries: s.Tries}
	}
	return out
}

func storeItems(in []session.ItemState) []store.InventoryItem {
	var out []store.InventoryItem
	for _, it := range in {
		out = append(out, store.InventoryItem{ItemID: int(it.ItemID), Count: it.Count, Slot: it.Slot, Items: storeItems(it.Items)})
	}
	return out
}

// adminDone hands a ban or unban result to the loop. It must not be lost (a banned
// player would stay online), so a full queue is retried until the loop has room or
// stops; it blocks only the admin goroutine.
func (a *App) adminDone(r session.AdminResult) { a.enqueueRetry(a.World.AdminDone(r)) }

// rolesChanged hands the current roles of online staff to the loop (a lowered role
// must not be lost either).
func (a *App) rolesChanged(roles map[int64]session.Role) { a.enqueueRetry(a.World.RolesChanged(roles)) }

// enqueueRetry enqueues cmd, retrying a full queue every tick until the loop stops.
func (a *App) enqueueRetry(cmd game.Command) {
	for a.Loop.Enqueue(cmd) != nil {
		select {
		case <-a.loopDone:
			return
		case <-a.cfg.Clock.After(game.TickDuration):
		}
	}
}

func (a *App) snapshotSaved(s session.Snapshot) {
	if s.Final {
		_ = a.Loop.Enqueue(a.World.Saved(s.CharacterID, s.Seq)) // lost ack: harmless
	}
}
