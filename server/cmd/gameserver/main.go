// Command gameserver runs the game loop, the HTTP API (accounts, characters, play tokens)
// and the WebSocket gateway at /ws.
//
// It loads the compiled map (world.bin, built by cmd/mapcompile) at startup; without a
// world (-world "") only the HTTP API runs.
//
// Configuration: DATABASE_URL (required), RPG_WORLD (default of -world) plus the flags below.
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
}

// sessionPurgeEvery is how often expired session tokens are deleted.
const sessionPurgeEvery = time.Hour

func main() {
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
	flag.Parse()

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

	a, err := app.New(app.Config{
		Store:            st,
		Clock:            clk,
		Logger:           logger,
		Seed:             o.seed,
		Vocations:        vocations,
		Balance:          balance,
		Monsters:         monsters,
		Items:            items,
		Map:              m,
		CookieSecure:     o.cookieSecure,
		TrustProxy:       o.trustProxy,
		OriginPatterns:   splitList(o.wsOrigins),
		MinClientVersion: o.minClientVersion,
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
