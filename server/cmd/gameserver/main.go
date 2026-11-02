// Command gameserver runs the game loop and the HTTP API (accounts and characters).
//
// The world, the WebSocket gateway and the play handshake arrive in T1.2 and T1.4.
//
// Configuration: DATABASE_URL (required) plus the flags below.
package main

import (
	"context"
	crand "crypto/rand"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/buildinfo"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

type options struct {
	seed         uint64
	httpAddr     string
	dataDir      string
	databaseURL  string
	migrate      bool
	cookieSecure bool
	trustProxy   bool
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

	authSvc, err := auth.New(auth.Config{Repo: st, Clock: clk, Vocations: vocations})
	if err != nil {
		return err
	}
	api, err := httpapi.New(httpapi.Config{
		Auth:         authSvc,
		Clock:        clk,
		Logger:       logger,
		Health:       st.Ping,
		CookieSecure: o.cookieSecure,
		TrustProxy:   o.trustProxy,
	})
	if err != nil {
		return err
	}

	loop, err := game.New(game.Config{
		Clock:  clk,
		Rand:   rand.New(rand.NewPCG(o.seed, o.seed)),
		Logger: logger,
	})
	if err != nil {
		return fmt.Errorf("game loop: %w", err)
	}

	srv, cancelRequests := newHTTPServer(o.httpAddr, api, logger)
	defer cancelRequests()
	httpErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			httpErr <- fmt.Errorf("http: %w", err)
		}
		close(httpErr)
	}()
	go purgeSessions(ctx, logger, clk, authSvc)

	logger.Info("gameserver started",
		"version", buildinfo.Version, "commit", buildinfo.Commit, "http", o.httpAddr,
		"tick_ms", game.TickDuration.Milliseconds(), "seed", o.seed)

	loopCtx, stopLoop := context.WithCancel(ctx)
	defer stopLoop()
	loopErr := make(chan error, 1)
	go func() { loopErr <- loop.Run(loopCtx) }()

	var runErr error
	select {
	case err := <-loopErr:
		if err != nil {
			runErr = fmt.Errorf("game loop: %w", err)
		}
		loopErr = nil
	case err := <-httpErr:
		runErr = err
	}
	stopLoop()

	shutdownHTTP(srv, cancelRequests, httpShutdownTimeout, logger)
	if loopErr != nil {
		if err := <-loopErr; err != nil && runErr == nil {
			runErr = fmt.Errorf("game loop: %w", err)
		}
	}
	logger.Info("gameserver stopped", "ticks", uint64(loop.Tick()))
	return runErr
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
