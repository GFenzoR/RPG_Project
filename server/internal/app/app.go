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
	"sync/atomic"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/buildinfo"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/metrics"
	"github.com/GFenzoR/RPG_Project/server/internal/net/gateway"
	"github.com/GFenzoR/RPG_Project/server/internal/oauth"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Store is the persistence the server needs. *store.Store implements it.
type Store interface {
	auth.Repo
	gateway.Characters
	AdminStore
	EconomyStore
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
	// Tutorial comes from data/tutorial.yaml (T4.2); nil means no tutorial.
	Tutorial *content.Tutorial
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
	// Metrics, if set, records the tick, network, persistence and HTTP metrics
	// (internal/metrics). One App per *metrics.Metrics: New registers players_online on it
	// and fails if that is already registered.
	Metrics *metrics.Metrics
	// MapSubmitLimits bounds the map submission portal (T4.5; httpapi.MapSubmitLimits).
	MapSubmitLimits httpapi.MapSubmitLimits
	// MapPRWorker: the map PR worker runs (httpapi.Config.MapPRWorker).
	MapPRWorker bool
	// Mail sends the account emails (T2.1); nil turns verification and reset off.
	Mail auth.Emailer
	// PublicURL is the website's base URL for the links of the emails (required with Mail).
	PublicURL string
	// Providers are the OAuth providers with keys (T2.1 2/2); they need PublicURL and a
	// Store that implements auth.OAuthRepo (Postgres does).
	Providers []*oauth.Provider
	// RequireVerifiedEmail: only accounts with a verified email may play.
	RequireVerifiedEmail bool
	// ShutdownTimeout bounds the final saves and the closing of connections (default 10 s).
	ShutdownTimeout time.Duration
}

// guildLoadTimeout bounds the read of every guild at start.
const guildLoadTimeout = 30 * time.Second

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
	economy *economyWriter
	// loopDone is closed when the game loop stopped (commands can no longer run).
	loopDone chan struct{}
	// running is true while the game loop runs (GET /api/status).
	running atomic.Bool
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
	a := &App{cfg: cfg, log: cfg.Logger, loopDone: make(chan struct{})}
	// OAuth lives in Postgres; fake stores of tests may not implement it.
	oauthRepo, _ := cfg.Store.(auth.OAuthRepo)
	authSvc, err := auth.New(auth.Config{
		Repo: cfg.Store, Clock: cfg.Clock, Vocations: cfg.Vocations,
		Mail: cfg.Mail, PublicURL: cfg.PublicURL, RequireVerifiedEmail: cfg.RequireVerifiedEmail,
		SessionsRevoked: a.sessionsRevoked,
		Providers:       cfg.Providers,
		OAuth:           oauthRepo,
	})
	if err != nil {
		return nil, err
	}
	a.Auth = authSvc
	// The ranking reads Postgres; fake stores of tests may not implement it.
	highscores, _ := cfg.Store.(httpapi.Highscores)
	// The map submission portal (T4.5) also lives in Postgres only.
	submissions, _ := cfg.Store.(httpapi.MapSubmissions)
	// The public guild pages too (T5.1).
	publicGuilds, _ := cfg.Store.(httpapi.PublicGuilds)
	skills := make(map[string]int, len(cfg.Balance.Skills.Base))
	for id, b := range cfg.Balance.Skills.Base {
		skills[id] = b.StartLevel
	}
	vocations := make([]string, 0, len(cfg.Vocations))
	for id := range cfg.Vocations {
		vocations = append(vocations, id)
	}
	api, err := httpapi.New(httpapi.Config{
		Auth:         authSvc,
		Clock:        cfg.Clock,
		Logger:       cfg.Logger,
		Health:       cfg.Store.Ping,
		CookieSecure: cfg.CookieSecure,
		TrustProxy:   cfg.TrustProxy,
		// The zero value keeps httpapi.DefaultAuthRateLimit.
		AuthRateLimit: cfg.AuthRateLimit,
		Highscores:    highscores,
		Guilds:        publicGuilds,
		Skills:        skills,
		Vocations:     vocations,
		Status:        a.status,
		Version:       buildinfo.Version,
		Observe:       httpObserver(cfg.Metrics),

		MapSubmissions:  submissions,
		MapSubmitted:    a.mapSubmitted,
		MapSubmitLimits: cfg.MapSubmitLimits,
		MapPRWorker:     cfg.MapPRWorker,
	})
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/", api)
	a.handler = mux

	var systems []game.System
	if cfg.Map != nil {
		ms, _ := cfg.Store.(MarketStore)
		var writeTransfer func(context.Context, session.Transfer) error
		if ms != nil {
			writeTransfer = a.writeTransfer
		}
		saver, err := session.NewSaver(session.SaverConfig{
			Write:         a.writeSnapshot,
			WriteTransfer: writeTransfer,
			Saved:         a.snapshotSaved,
			Clock:         cfg.Clock,
			Logger:        cfg.Logger,
			Failed:        saveFailed(cfg.Metrics),
		})
		if err != nil {
			return nil, err
		}
		a.saver = saver
		a.admin = newAdminWorker(cfg.Store, cfg.Clock, cfg.Logger, a.adminDone, a.rolesChanged)
		el := cfg.Balance.Economy.Log
		a.economy = newEconomyWriter(cfg.Store, cfg.Clock, cfg.Logger, time.Duration(el.FlushMs)*time.Millisecond, el.BatchSize)
		a.admin.metrics, a.economy.metrics = cfg.Metrics, cfg.Metrics
		// Guilds (T5.1) are loaded once, before the loop owns them.
		var guilds *session.GuildData
		if gs, ok := cfg.Store.(GuildStore); ok {
			ctx, cancel := context.WithTimeout(context.Background(), guildLoadTimeout)
			rows, err := gs.LoadGuilds(ctx, cfg.Clock.Now())
			cancel()
			if err != nil {
				return nil, err
			}
			a.admin.guilds, guilds = gs, guildData(rows)
		}
		// The market and the trade window (T5.3) need transactions across characters: only
		// a store that writes transfers (Postgres) turns them on. The market is loaded once,
		// before the loop owns it.
		var transfer func(session.Transfer) bool
		var market *session.MarketData
		if ms != nil {
			transfer = saver.SubmitTransfer
			// Loaded even with the market off: the trade window's transfers continue
			// from the last transfer id written.
			if market, err = loadMarket(ms, cfg.Clock.Now(), cfg.Balance.Market); err != nil {
				return nil, err
			}
		}
		w, err := session.New(session.Config{
			Transfer:      transfer,
			Market:        market,
			Map:           cfg.Map,
			StartTown:     cfg.StartTown,
			Balance:       cfg.Balance,
			Vocations:     cfg.Vocations,
			Monsters:      cfg.Monsters,
			Items:         cfg.Items,
			Spells:        cfg.Spells,
			Recipes:       cfg.Recipes,
			BoatRoutes:    cfg.BoatRoutes,
			Tutorial:      cfg.Tutorial,
			NPCs:          cfg.NPCs,
			Quests:        cfg.Quests,
			Save:          saver.Submit,
			Admin:         a.admin.Submit,
			Guilds:        guilds,
			Economy:       a.economy.Submit,
			Alert:         economyAlert(cfg.Metrics),
			AutosaveEvery: cfg.AutosaveEvery,
			Logger:        cfg.Logger,
		})
		if err != nil {
			return nil, err
		}
		a.World = w
		cfg.Metrics.EconomyAlertKinds(session.AlertMismatch, session.AlertGoldOutlier, session.AlertItemsOutlier, session.AlertLogDropped)
		if err := cfg.Metrics.PlayersOnline(w.PublishedOnline); err != nil {
			return nil, fmt.Errorf("metrics: %w", err)
		}
		if err := cfg.Metrics.AntiBot(w.AntiBotStats()); err != nil {
			return nil, fmt.Errorf("metrics: %w", err)
		}
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

// economyAlert counts economy alerts in m (nil without metrics).
func economyAlert(m *metrics.Metrics) func(string) {
	if m == nil {
		return nil
	}
	return m.EconomyAlert
}

// httpObserver records the HTTP API requests in m (nil without metrics).
func httpObserver(m *metrics.Metrics) httpapi.RequestObserver {
	if m == nil {
		return nil
	}
	return m.HTTPRequest
}

// saveFailed counts the failed character saves in m (nil without metrics).
func saveFailed(m *metrics.Metrics) func(string) {
	if m == nil {
		return nil
	}
	return func(outcome string) { m.PersistenceError(metrics.WriterCharacter, outcome) }
}

// gatewayMetrics avoids handing the gateway a non-nil interface holding a nil pointer.
func gatewayMetrics(m *metrics.Metrics) gateway.Observer {
	if m == nil {
		return nil
	}
	return m
}

// status is what GET /api/status reports. It reads only atomics the game loop publishes:
// the HTTP goroutine never touches the world (CLAUDE.md, principle 2).
func (a *App) status() httpapi.Status {
	s := httpapi.Status{Online: a.running.Load()}
	if a.World != nil && s.Online {
		s.Players = a.World.PublishedOnline()
	}
	return s
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
		a.economy.Start()
	}
	a.running.Store(true)
	runErr := a.Loop.Run(ctx)
	a.running.Store(false)
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
	pendingEconomy := a.World.PendingEconomy(a.cfg.Clock.Now())
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
		for _, j := range pending { // the saver's queue was full when SaveAll ran
			if a.saver.Tainted(j) {
				errs = append(errs, errors.New("save skipped: a transfer of its character was not stored"))
				continue
			}
			if j.Transfer != nil {
				if err := a.writeTransfer(ctx, *j.Transfer); err != nil {
					errs = append(errs, fmt.Errorf("transfer %d: %w", j.Transfer.ID, err))
				}
			} else if err := a.writeSnapshot(ctx, j.Snapshot); err != nil {
				errs = append(errs, fmt.Errorf("character %d: %w", j.Snapshot.CharacterID, err))
			}
		}
		return errors.Join(errs...)
	})
	stage("audit log did not drain", a.admin.Stop)
	stage("pending audit entries", func(ctx context.Context) error { return a.admin.writePending(ctx, pendingAdmin) })
	stage("economy log did not drain", a.economy.Stop)
	stage("pending economy entries", func(ctx context.Context) error { return a.economy.writePending(ctx, pendingEconomy) })
	a.log.Info("players saved at shutdown", "online", online, "ticks", uint64(a.Loop.Tick()))
	return runErr
}

func (a *App) writeSnapshot(ctx context.Context, s session.Snapshot) error {
	err := a.cfg.Store.SaveCharacterState(ctx, a.characterState(s))
	switch {
	case errors.Is(err, store.ErrNotFound):
		return session.ErrGone
	case store.Permanent(err):
		return fmt.Errorf("%w: %w", session.ErrPermanent, err)
	}
	return err
}

func (a *App) characterState(s session.Snapshot) store.CharacterState {
	return store.CharacterState{
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
		PvP: store.PvPState{Skull: s.PvP.Skull, SkullUntil: s.PvP.SkullUntil, Kills: s.PvP.Kills,
			Unjust: s.PvP.Unjust},
		SavedAt: a.cfg.Clock.Now(),
	}
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

// sessionsRevoked disconnects the online characters of an account whose password was
// reset (T2.1). Like a ban it must not be lost, so a full queue is retried, in its own
// goroutine: the HTTP handler that reset the password does not wait for the loop.
func (a *App) sessionsRevoked(accountID int64) {
	if a.World == nil {
		return
	}
	go a.enqueueRetry(a.World.KickAccount(accountID))
}

// mapSubmitted tells the online GMs about a new map submission (T4.5) through the loop:
// the HTTP handler never touches the world. A full queue drops the notice (the
// submission is in the moderation queue anyway) instead of making the upload wait.
func (a *App) mapSubmitted(id int64, title string) {
	if a.World == nil || a.Loop == nil {
		return
	}
	if err := a.Loop.Enqueue(a.World.MapSubmitted(id, title)); err != nil {
		a.log.Warn("map submission notice dropped", "id", id, "err", err)
	}
}

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
