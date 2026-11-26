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
	"github.com/GFenzoR/RPG_Project/server/internal/explore"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/metrics"
	"github.com/GFenzoR/RPG_Project/server/internal/net/gateway"
	"github.com/GFenzoR/RPG_Project/server/internal/oauth"
	"github.com/GFenzoR/RPG_Project/server/internal/payments"
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
	Store  Store
	Clock  clock.Clock
	Logger *slog.Logger
	Seed   uint64
	// SeedHi is the second word of the loop's PCG source (0 = Seed again). The gameserver
	// fills both from crypto/rand unless -seed asks for a replayable run.
	SeedHi    uint64
	Vocations content.Vocations
	Balance   content.Balance
	// Monsters and Items come from data/ (session.Config); nil runs a world without monsters.
	Monsters content.Monsters
	Items    content.Items
	// Spells come from data/spells.yaml (session.Config); nil means no spells.
	Spells content.Spells
	// Recipes come from data/recipes.yaml (T3.4); nil means no crafting.
	Recipes content.Recipes
	// TrailWear is data/livingworld/wear.yaml (session.LoadTrailWear); nil turns the
	// living world's trail wear off. With a TrailStore it survives restarts (trailwear.go).
	TrailWear *session.TrailConfig
	// LivingWorld is data/livingworld (session.LoadLivingWorld); nil means no living objects.
	LivingWorld session.LivingDefs
	// DayNight is data/livingworld/daynight.yaml's cycle (session.LoadDayNight); nil: no
	// day and night. The world time starts at the clock's Unix time.
	DayNight *session.DayNightCycle
	// DayNightFixed (-world-time, test harnesses) fixes the day and night at that /time word,
	// stopped (session.Config.DayNightFixed).
	DayNightFixed string
	// Attributes come from data/attributes.yaml (docs/02 "Atributos de items"); nil means
	// no equipable rolls one.
	Attributes content.Attributes
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
	// DeviceKey signs the known-device cookies (httpapi.Config.DeviceKey; $RPG_DEVICE_KEY).
	// Empty: a random key per process.
	DeviceKey []byte
	// AutosaveEvery overrides session.DefaultAutosaveEvery (tests).
	AutosaveEvery game.Tick
	// WSLimits bounds the /ws connections, handshakes and queued commands
	// (gateway.Limits; zero fields take gateway.DefaultLimits).
	WSLimits gateway.Limits
	// WSExemptLoopback skips the per-client /ws limits for loopback clients (development,
	// bots and E2E on one machine; gateway.Config.ExemptLoopback).
	WSExemptLoopback bool
	// MaxCharactersPerAccount caps the characters of one account online at once
	// (session.Config; 0 = session.DefaultMaxCharactersPerAccount, negative = no cap).
	MaxCharactersPerAccount int
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
	// Cosmetics is data/cosmetics.yaml (T5.7); nil turns the shop off. With a Store that
	// implements ShopStore (Postgres) the catalog is synced to the cosmetics table at
	// start and /api/shop is served.
	Cosmetics *content.CosmeticShop
	// ReservedNames are names new characters may not take (auth.Config.ReservedNames):
	// the NPCs' names (auth.NPCReservedNames). Nil: only the staff words are reserved.
	ReservedNames []string
	// Looks is data/looks.yaml (docs/02 "Apariencia"): the bodies a new character may pick
	// and the game checks. Nil: no looks (a look sent at creation is ignored).
	Looks *content.Looks
	// Payments is the payment provider (payments.FromEnv); nil: GET /api/shop says
	// enabled: false and nothing can be bought.
	Payments payments.Provider
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
	// trail writes the trail wear (trailwear.go); nil without a TrailStore.
	trail *trailWriter
	// loopDone is closed when the game loop stopped (commands can no longer run).
	loopDone chan struct{}
	// storeBeat is the database heartbeat (houses.go heartbeat; 0: none).
	storeBeat time.Duration
	// acks are the snapshot acks a full loop queue refused (acks.go).
	acks ackRetry
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
		Repo: cfg.Store, Clock: cfg.Clock, Vocations: cfg.Vocations, Looks: cfg.Looks,
		Mail: cfg.Mail, PublicURL: cfg.PublicURL, RequireVerifiedEmail: cfg.RequireVerifiedEmail,
		SessionsRevoked:     a.sessionsRevoked,
		SignedOutEverywhere: a.signedOutEverywhere,
		Providers:           cfg.Providers,
		OAuth:               oauthRepo,
		ReservedNames:       cfg.ReservedNames,
		Log:                 a.log,
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
	houseOwners, _ := cfg.Store.(httpapi.PublicHouses)
	var houses []httpapi.HouseInfo
	if cfg.Map != nil {
		for _, h := range cfg.Map.Houses() {
			size := 0
			for _, r := range h.Rects {
				size += int(r.W) * int(r.H)
			}
			houses = append(houses, httpapi.HouseInfo{ID: h.ID, Name: h.Name, Island: h.Island, Rent: h.Rent, Size: size})
		}
	}
	if !cfg.Balance.Houses.Enabled || len(houses) == 0 {
		houseOwners = nil
	}
	shop, err := a.shopConfig()
	if err != nil {
		return nil, err
	}
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
		DeviceKey:     cfg.DeviceKey,
		Highscores:    highscores,
		Guilds:        publicGuilds,
		Houses:        houses,
		HouseOwners:   houseOwners,
		Skills:        skills,
		Vocations:     vocations,
		Status:        a.status,
		Version:       buildinfo.Version,
		Observe:       httpObserver(cfg.Metrics),

		MapSubmissions:  submissions,
		MapSubmitted:    a.mapSubmitted,
		MapSubmitLimits: cfg.MapSubmitLimits,
		MapPRWorker:     cfg.MapPRWorker,

		Shop: shop,
	})
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/", api)
	a.handler = mux

	var systems []game.System
	// The loop's seeded source; the World rolls item attributes with it too (session.Config.Rand).
	// SeedHi 0 = Seed again: the replayable (seed, seed) source of -seed and the tests.
	seedHi := cfg.SeedHi
	if seedHi == 0 {
		seedHi = cfg.Seed
	}
	rng := rand.New(rand.NewPCG(cfg.Seed, seedHi))
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
			Tainted:       a.charactersTainted,
		})
		if err != nil {
			return nil, err
		}
		a.saver = saver
		a.admin = newAdminWorker(cfg.Store, cfg.Clock, cfg.Logger, a.adminDone, a.rolesChanged)
		a.admin.shop, _ = cfg.Store.(ShopStore)
		a.admin.shopChanged = a.shopChanged
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
		var houseData *session.HouseData
		if ms != nil {
			transfer = saver.SubmitTransfer
			// Loaded even with the market off: the trade window's transfers continue
			// from the last transfer id written.
			if market, err = loadMarket(ms, cfg.Clock.Now(), cfg.Balance.Market); err != nil {
				return nil, err
			}
			// Houses (T5.4) are loaded once, like the market, before the loop owns them.
			if hs, ok := cfg.Store.(HouseStore); ok && cfg.Balance.Houses.Enabled {
				if houseData, err = loadHouses(hs); err != nil {
					return nil, err
				}
			}
		}
		if houseData != nil && cfg.Store != nil {
			a.storeBeat = storeHeartbeat // content audit M6: a database outage is not absence
		}
		// The living world's trail wear (trailwear.go): read once, before the loop owns it.
		var trailData []byte
		var trailDown int64
		var saveTrail func(session.TrailSnapshot) bool
		if ts, ok := cfg.Store.(TrailStore); ok && cfg.TrailWear != nil {
			trailData, trailDown = loadTrail(ts, cfg.Clock, cfg.Logger)
			a.trail = newTrailWriter(ts, cfg.Clock, cfg.Logger)
			saveTrail = a.trail.Submit
		}
		w, err := session.New(session.Config{
			Trail:           cfg.TrailWear,
			TrailData:       trailData,
			TrailDowntimeMs: trailDown,
			SaveTrail:       saveTrail,
			DayNight:        cfg.DayNight,
			DayNightEpochMs: cfg.Clock.Now().UnixMilli(),
			DayNightFixed:   cfg.DayNightFixed,

			StoreHeartbeat: a.storeBeat,
			Transfer:       transfer,
			Market:         market,
			Houses:         houseData,
			Map:            cfg.Map,
			StartTown:      cfg.StartTown,
			Balance:        cfg.Balance,
			Vocations:      cfg.Vocations,
			Monsters:       cfg.Monsters,
			Items:          cfg.Items,
			Spells:         cfg.Spells,
			Recipes:        cfg.Recipes,
			LivingWorld:    cfg.LivingWorld,
			Attributes:     cfg.Attributes,
			Rand:           rng,
			BoatRoutes:     cfg.BoatRoutes,
			Tutorial:       cfg.Tutorial,
			Cosmetics:      cfg.Cosmetics,
			Looks:          cfg.Looks,
			NPCs:           cfg.NPCs,
			Quests:         cfg.Quests,
			Save:           saver.Submit,
			Admin:          a.admin.Submit,
			Guilds:         guilds,
			Economy:        a.economy.Submit,
			Alert:          economyAlert(cfg.Metrics),
			AutosaveEvery:  cfg.AutosaveEvery,
			Logger:         cfg.Logger,

			MaxCharactersPerAccount: cfg.MaxCharactersPerAccount,
		})
		if err != nil {
			return nil, err
		}
		a.World = w
		cfg.Metrics.EconomyAlertKinds(session.AlertMismatch, session.AlertGoldOutlier, session.AlertItemsOutlier, session.AlertLogDropped)
		if err := cfg.Metrics.PlayersOnline(w.PublishedOnline); err != nil {
			return nil, fmt.Errorf("metrics: %w", err)
		}
		if err := cfg.Metrics.PersistenceBacklog(func() int { return saver.Backlog() + w.PendingJobs() }); err != nil {
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
		Rand:    rng,
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
			TrustProxy:       cfg.TrustProxy,
			Limits:           cfg.WSLimits,
			ExemptLoopback:   cfg.WSExemptLoopback,
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
	if a.trail != nil {
		a.trail.Start()
	}
	a.running.Store(true)
	if a.storeBeat > 0 {
		go a.heartbeat()
	}
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
	// The jobs the saver's queue could not take when SaveAll ran, with the saver's rules
	// (a failed transfer taints its characters; their later jobs are skipped, T5.3).
	stage("final saves", func(ctx context.Context) error { return a.saver.WritePending(ctx, pending) })
	stage("audit log did not drain", a.admin.Stop)
	stage("pending audit entries", func(ctx context.Context) error { return a.admin.writePending(ctx, pendingAdmin) })
	stage("economy log did not drain", a.economy.Stop)
	stage("pending economy entries", func(ctx context.Context) error { return a.economy.writePending(ctx, pendingEconomy) })
	if a.trail != nil {
		// The loop has stopped: the wear as it is now is the last copy to write.
		if snap, ok := a.World.TrailSnapshot(); ok {
			a.trail.Submit(snap)
		}
		stage("trail wear not saved", a.trail.Stop)
	}
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
		Explored:   storeExplored(s.Explored),
		Conditions: storeConditions(s.Conditions),
		PvP: store.PvPState{Skull: s.PvP.Skull, SkullUntil: s.PvP.SkullUntil, Kills: s.PvP.Kills,
			Unjust: s.PvP.Unjust},
		Cosmetics: store.Cosmetics{Outfit: s.Cosmetics.Outfit, Color: s.Cosmetics.Color, NameEffect: s.Cosmetics.NameEffect},
		Look: store.Look{Sex: s.Look.Sex, Body: s.Look.Body, Skin: s.Look.Skin, Hair: s.Look.Hair, HairColor: s.Look.HairColor,
			Beard: s.Look.Beard},
		Options: store.GameOptions{Stance: int(s.Options.Stance), Chase: s.Options.Chase, Unsafe: s.Options.Unsafe},
		SavedAt: a.cfg.Clock.Now(),
	}
}

// storeExplored is a snapshot's explored sectors as saved (character_explored).
func storeExplored(in []explore.SectorState) []store.ExploredSector {
	out := make([]store.ExploredSector, len(in))
	for i, s := range in {
		out[i] = store.ExploredSector{Z: int(s.Key.Z()), SX: s.Key.SX(), SY: s.Key.SY(), Bits: append([]byte(nil), s.Bits[:]...)}
	}
	return out
}

func storeConditions(in []session.ConditionState) []store.Condition {
	out := make([]store.Condition, len(in))
	for i, c := range in {
		out[i] = store.Condition{ID: c.ID, LeftMs: c.LeftMs, Ticks: c.Ticks, Damage: c.Damage,
			Author: c.Author, AuthorHit: c.AuthorHit, AuthorUnjust: c.AuthorUnjust, SavedAt: c.SavedAt}
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
		out = append(out, store.InventoryItem{ItemID: int(it.ItemID), Count: it.Count, Slot: it.Slot,
			Mods: storeMods(it.Mods), Items: storeItems(it.Items), Pocket: it.Pocket})
	}
	return out
}

// storeMods is an instance's mods as saved (nil: a plain item).
func storeMods(m session.Mods) *store.ItemMods {
	if m.Zero() {
		return nil
	}
	return &store.ItemMods{Attribute: m.Attr, Value: m.Value, Refine: m.Refine}
}

// sessionMods is saved mods as the loop holds them (nil: a plain item). Only a hand edit
// of the database writes numbers out of range, and the loop must not trust them (a
// negative refine level would index the forge's table before its first level): the
// refine level is kept to 0..content.MaxRefineLevel and the value to
// 0..content.MaxAttributeValue (final review of lote 11).
func sessionMods(m *store.ItemMods) session.Mods {
	if m == nil {
		return session.Mods{}
	}
	return session.Mods{Attr: m.Attribute, Value: min(max(m.Value, 0), content.MaxAttributeValue),
		Refine: min(max(m.Refine, 0), content.MaxRefineLevel)}
}

// adminDone hands a ban or unban result to the loop. It must not be lost (a banned
// player would stay online), so a full queue is retried until the loop has room or
// stops; it blocks only the admin goroutine.
func (a *App) adminDone(r session.AdminResult) { a.enqueueRetry(a.World.AdminDone(r)) }

// sessionsRevoked disconnects the online characters of an account whose password was
// reset (T2.1). Like a ban it must not be lost, so a full queue is retried, in its own
// goroutine: the HTTP handler that reset the password does not wait for the loop. The
// time is taken here, after the revocation committed: a login that redeemed its play
// token before it is refused at its Join (session.Character.RedeemedAt).
func (a *App) sessionsRevoked(accountID int64) {
	if a.World == nil {
		return
	}
	go a.enqueueRetry(a.World.KickAccount(accountID, a.cfg.Clock.Now()))
}

// signedOutEverywhere disconnects the online characters of an account that used "sign
// out everywhere" (lote 17), like sessionsRevoked: retried, never blocking the handler.
func (a *App) signedOutEverywhere(accountID int64) {
	if a.World == nil {
		return
	}
	go a.enqueueRetry(a.World.SignOutAccount(accountID, a.cfg.Clock.Now()))
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

// charactersTainted hands characters whose transfer was not stored to the loop (T5.3): it
// must not be lost, so a full queue is retried in its own goroutine (the persistence
// goroutine never waits for the loop). After the loop stopped there is nothing to tell.
func (a *App) charactersTainted(ids []int64) {
	if a.World == nil {
		return
	}
	go a.enqueueRetry(a.World.Tainted(ids))
}
