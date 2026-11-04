// Command gameserver runs the game loop, the HTTP API (accounts, characters, play tokens)
// and the WebSocket gateway at /ws.
//
// It loads the compiled map (world.bin, built by cmd/mapcompile) at startup; without a
// world (-world "") only the HTTP API runs.
//
// Configuration: DATABASE_URL (required), RPG_WORLD (default of -world) plus the flags below.
//
// "gameserver admin ..." runs the operator's commands instead (roles, audit log; see
// admin.go).
package main

import (
	"context"
	crand "crypto/rand"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/app"
	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/buildinfo"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/metrics"
	"github.com/GFenzoR/RPG_Project/server/internal/net/gateway"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

type options struct {
	seed         uint64
	httpAddr     string
	dataDir      string
	databaseURL  string
	migrate      bool
	cookieSecure bool
	trustProxy   bool
	worldPath    string
	// wsOrigins lists extra browser origins allowed on /ws (comma-separated).
	wsOrigins        string
	minClientVersion string
	// authRateBurst overrides the per-IP register/login burst (0 = the default). Only
	// for local test harnesses whose requests all come from one IP, such as the E2E suite.
	authRateBurst int
	// metricsAddr serves /metrics on its own internal listener ("" disables it).
	metricsAddr string
	// metricsExplicit: -metrics-addr or $RPG_METRICS_ADDR was set, so a failed bind is
	// fatal (with the default address it is only a warning).
	metricsExplicit bool
	// startTown is the island new characters start at (empty = the first in world.yaml).
	startTown string
	// boatRoutes replaces data/boat_routes.yaml (E2E fixtures; empty = the data file).
	boatRoutes string
}

// sessionPurgeEvery is how often expired session tokens are deleted.
const sessionPurgeEvery = time.Hour

func main() {
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		os.Exit(runAdmin(os.Args[2:], os.Stdout, os.Stderr))
	}
	var o options
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Uint64Var(&o.seed, "seed", 0, "random seed for the game loop (0 = random)")
	flag.StringVar(&o.httpAddr, "http", ":8080", "HTTP API listen address")
	flag.StringVar(&o.dataDir, "data", "../data", "content directory (data/ of the repo)")
	flag.BoolVar(&o.migrate, "migrate", true, "apply pending database migrations on start")
	flag.BoolVar(&o.cookieSecure, "cookie-secure", true, "set the Secure flag on the session cookie")
	flag.BoolVar(&o.trustProxy, "trust-proxy", false, "take the client IP from X-Forwarded-For (behind Caddy)")
	flag.StringVar(&o.worldPath, "world", defaultWorldPath(), "compiled map from mapcompile; default $RPG_WORLD or ../build/world.bin (empty = run without a world)")
	flag.StringVar(&o.wsOrigins, "ws-origins", os.Getenv("RPG_WS_ORIGINS"), "extra browser origins allowed on /ws, comma-separated (e.g. localhost:5173); default $RPG_WS_ORIGINS")
	flag.StringVar(&o.minClientVersion, "min-client-version", gateway.DefaultMinClientVersion, "oldest client version accepted in Hello (same major required)")
	flag.StringVar(&o.startTown, "start-town", os.Getenv("RPG_START_TOWN"), "island new characters start at; default $RPG_START_TOWN or the first island of world/world.yaml")
	flag.StringVar(&o.boatRoutes, "boat-routes", os.Getenv("RPG_BOAT_ROUTES"), "boat routes file replacing <data>/boat_routes.yaml (tests); default $RPG_BOAT_ROUTES")
	flag.StringVar(&o.metricsAddr, "metrics-addr", envOr("RPG_METRICS_ADDR", defaultMetricsAddr), "internal listener for Prometheus /metrics, never public (empty = off); default $RPG_METRICS_ADDR or "+defaultMetricsAddr)
	flag.IntVar(&o.authRateBurst, "auth-rate-burst", 0, "per-IP register/login burst (0 = default); only for test harnesses that share one IP")
	flag.Parse()
	_, o.metricsExplicit = os.LookupEnv("RPG_METRICS_ADDR")
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "metrics-addr" {
			o.metricsExplicit = true
		}
	})

	if *showVersion {
		fmt.Println(buildinfo.String())
		return
	}
	o.databaseURL = os.Getenv("DATABASE_URL")

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger) // also routes the standard log package through slog
	if err := run(logger, o); err != nil {
		logger.Error("gameserver stopped", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger, o options) error {
	if o.databaseURL == "" {
		return errors.New("DATABASE_URL is not set")
	}
	if o.seed == 0 {
		var b [8]byte
		if _, err := crand.Read(b[:]); err != nil {
			return fmt.Errorf("seed: %w", err)
		}
		o.seed = binary.LittleEndian.Uint64(b[:])
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	clk := clock.Real{}
	vocations, err := content.LoadVocations(o.dataDir)
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	balance, err := content.LoadBalance(o.dataDir)
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	monsters, err := content.LoadMonsters(o.dataDir)
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	items, err := content.LoadItems(o.dataDir)
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	spells, err := content.LoadSpells(o.dataDir)
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	recipes, err := content.LoadRecipes(o.dataDir)
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	routes, err := content.LoadBoatRoutes(o.dataDir)
	if o.boatRoutes != "" {
		routes, err = content.LoadBoatRoutesFile(o.boatRoutes, false)
	}
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	npcs, err := content.LoadNPCs(o.dataDir)
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	quests, err := content.LoadQuests(o.dataDir)
	if err != nil {
		return fmt.Errorf("content: %w", err)
	}
	m, err := loadWorld(logger, o.worldPath)
	if err != nil {
		return err
	}

	st, err := store.Open(ctx, o.databaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if o.migrate {
		if err := st.Migrate(ctx); err != nil {
			return err
		}
	}

	var mets *metrics.Metrics
	if o.metricsAddr != "" {
		mets = metrics.New()
	}
	a, err := app.New(app.Config{
		Metrics:          mets,
		Store:            st,
		Clock:            clk,
		Logger:           logger,
		Seed:             o.seed,
		Vocations:        vocations,
		Balance:          balance,
		Monsters:         monsters,
		Items:            items,
		Spells:           spells,
		Recipes:          recipes,
		BoatRoutes:       routes,
		NPCs:             npcs,
		Quests:           quests,
		Map:              m,
		CookieSecure:     o.cookieSecure,
		TrustProxy:       o.trustProxy,
		OriginPatterns:   splitList(o.wsOrigins),
		MinClientVersion: o.minClientVersion,
		AuthRateLimit:    authRateLimit(o.authRateBurst),
		StartTown:        o.startTown,
	})
	if err != nil {
		return err
	}

	srv, cancelRequests := newHTTPServer(o.httpAddr, a.Handler(), logger)
	defer cancelRequests()
	httpErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			httpErr <- fmt.Errorf("http: %w", err)
		}
		close(httpErr)
	}()
	go purgeSessions(ctx, logger, clk, a.Auth)
	if mets != nil {
		msrv, err := serveMetrics(o.metricsAddr, mets, logger)
		switch {
		case err == nil:
			defer func() { _ = msrv.Close() }()
		case o.metricsExplicit:
			return err
		default:
			logger.Warn("metrics disabled", "err", err)
		}
	}

	logger.Info("gameserver started",
		"version", buildinfo.Version, "commit", buildinfo.Commit, "http", o.httpAddr,
		"ws", m != nil, "tick_ms", game.TickDuration.Milliseconds(), "seed", o.seed)

	loopCtx, stopLoop := context.WithCancel(ctx)
	defer stopLoop()
	loopErr := make(chan error, 1)
	go func() { loopErr <- a.Run(loopCtx) }()

	var runErr error
	select {
	case err := <-loopErr:
		runErr = err
		loopErr = nil
	case err := <-httpErr:
		runErr = err
	}
	stopLoop()
	if loopErr != nil {
		// Run saves every online player and closes the WebSockets before returning.
		if err := <-loopErr; err != nil && runErr == nil {
			runErr = err
		}
	}
	shutdownHTTP(srv, cancelRequests, httpShutdownTimeout, logger)
	logger.Info("gameserver stopped", "ticks", uint64(a.Loop.Tick()))
	return runErr
}

// defaultMetricsAddr is loopback only: /metrics is internal (docs/01-architecture.md).
const defaultMetricsAddr = "127.0.0.1:9100"

func envOr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

// serveMetrics serves /metrics on its own listener, apart from the public API, so a
// reverse proxy in front of the API can never expose it. It binds before returning, so a
// busy address is an error here and "metrics listening" names the address really bound.
func serveMetrics(addr string, m *metrics.Metrics, logger *slog.Logger) (*http.Server, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("metrics listener: %w", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", m.Handler())
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second,
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelError)}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("metrics listener stopped", "addr", ln.Addr().String(), "err", err)
		}
	}()
	logger.Info("metrics listening", "addr", ln.Addr().String())
	return srv, nil
}

// splitList splits a comma-separated flag value, dropping empty entries.
func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// defaultWorldPath is $RPG_WORLD, or ../build/world.bin: like -data, relative to server/,
// where `go run ./cmd/gameserver` runs and `make mapcompile` writes <repo>/build/world.bin.
func defaultWorldPath() string {
	if p := os.Getenv("RPG_WORLD"); p != "" {
		return p
	}
	return filepath.Join("..", "build", "world.bin")
}

// loadWorld loads world.bin; an empty path runs without a world (nil map). A missing or
// invalid file is an error that names the absolute path tried.
func loadWorld(logger *slog.Logger, path string) (*world.Map, error) {
	if path == "" {
		logger.Warn("running without a world (-world is empty)")
		return nil, nil
	}
	m, err := world.Load(path)
	if err != nil {
		abs, absErr := filepath.Abs(path)
		if absErr != nil {
			abs = path
		}
		return nil, fmt.Errorf("%w (looked for %s; build it with `make mapcompile`, or use `make run-server`)", err, abs)
	}
	sectors := 0
	for _, is := range m.Islands() {
		sectors += len(is.Sectors())
	}
	logger.Info("world loaded", "path", path, "islands", len(m.Islands()), "sectors", sectors)
	return m, nil
}

const httpShutdownTimeout = 5 * time.Second

// newHTTPServer builds the API server. Its errors go to slog, and every request context
// derives from a base context that the returned cancel func ends.
func newHTTPServer(addr string, h http.Handler, logger *slog.Logger) (*http.Server, context.CancelFunc) {
	baseCtx, cancel := context.WithCancel(context.Background())
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}, cancel
}

// shutdownHTTP stops srv gracefully, waiting up to timeout for in-flight requests. If
// they do not finish, it cancels their contexts and closes the connections, so the
// deferred store.Close never waits on them forever.
func shutdownHTTP(srv *http.Server, cancelRequests context.CancelFunc, timeout time.Duration, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Warn("http shutdown timed out, closing connections", "err", err)
		cancelRequests()
		if err := srv.Close(); err != nil {
			logger.Warn("http close", "err", err)
		}
	}
}

// purgeSessions deletes expired session tokens periodically until ctx is done.
func purgeSessions(ctx context.Context, logger *slog.Logger, clk clock.Clock, svc *auth.Service) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-clk.After(sessionPurgeEvery):
		}
		n, err := svc.PurgeExpiredSessions(ctx)
		if err != nil {
			logger.Warn("purge expired sessions", "err", err)
			continue
		}
		if n > 0 {
			logger.Info("purged expired sessions", "count", n)
		}
	}
}

// authRateLimit returns the per-IP auth limit for a -auth-rate-burst value: the zero
// RateLimit (httpapi's default) when burst <= 0, otherwise the default refill with a
// larger burst.
func authRateLimit(burst int) httpapi.RateLimit {
	if burst <= 0 {
		return httpapi.RateLimit{}
	}
	return httpapi.RateLimit{Burst: burst, Every: httpapi.DefaultAuthRateLimit.Every}
}
