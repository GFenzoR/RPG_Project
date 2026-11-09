package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/metrics"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
	"github.com/GFenzoR/RPG_Project/server/internal/world/compile"
)

// TestShutdownCancelsStuckRequests: a request that ignores graceful shutdown has its
// context cancelled and its connection closed once the timeout expires.
func TestShutdownCancelsStuckRequests(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))

	started := make(chan struct{})
	cancelled := make(chan struct{})
	h := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done() // stuck until its context ends
		close(cancelled)
	})
	srv, cancelRequests := newHTTPServer("127.0.0.1:0", h, logger)
	defer cancelRequests()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/")
		if err == nil {
			_ = resp.Body.Close()
		}
	}()
	<-started

	done := make(chan struct{})
	go func() {
		shutdownHTTP(srv, cancelRequests, 50*time.Millisecond, logger)
		close(done)
	}()
	select {
	case <-done:
	case <-clock.Real{}.After(5 * time.Second):
		t.Fatal("shutdown did not return")
	}
	select {
	case <-cancelled:
	case <-clock.Real{}.After(5 * time.Second):
		t.Fatal("stuck request was not cancelled")
	}
	if !strings.Contains(logs.String(), "http shutdown timed out") {
		t.Fatalf("missing log: %s", logs.String())
	}
}

// TestHTTPServerErrorsGoToSlog: net/http's own error log is routed through slog.
func TestHTTPServerErrorsGoToSlog(t *testing.T) {
	var logs bytes.Buffer
	srv, cancel := newHTTPServer(":0", http.NotFoundHandler(), slog.New(slog.NewJSONHandler(&logs, nil)))
	defer cancel()
	srv.ErrorLog.Print("http: TLS handshake error")
	if !strings.Contains(logs.String(), `"level":"ERROR"`) || !strings.Contains(logs.String(), "TLS handshake error") {
		t.Fatalf("not logged as JSON error: %s", logs.String())
	}
	base := srv.BaseContext(nil)
	if base.Err() != nil {
		t.Fatal("base context cancelled too early")
	}
	cancel()
	select {
	case <-base.Done():
	default:
		t.Fatal("cancel must end the context every request derives from")
	}
}

func TestDefaultWorldPath(t *testing.T) {
	t.Setenv("RPG_WORLD", "/srv/rpg/world.bin")
	if got := defaultWorldPath(); got != "/srv/rpg/world.bin" {
		t.Errorf("with RPG_WORLD: %q", got)
	}
	t.Setenv("RPG_WORLD", "")
	if got := defaultWorldPath(); got != filepath.Join("..", "build", "world.bin") {
		t.Errorf("without RPG_WORLD: %q", got)
	}
}

// A missing world.bin names the absolute path that was tried, so running from the wrong
// directory is obvious.
func TestLoadWorldReportsAbsolutePath(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	_, err := loadWorld(logger, filepath.Join("no", "such", "world.bin"))
	want, _ := filepath.Abs(filepath.Join("no", "such", "world.bin"))
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want it to mention %s", err, want)
	}
}

func TestLoadWorld(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if m, err := loadWorld(logger, ""); m != nil || err != nil {
		t.Fatalf("empty path: %v, %v", m, err)
	}
	m, err := compile.Compile(filepath.Join("..", "..", "internal", "world", "compile", "testdata", "miniworld"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "world.bin")
	var buf bytes.Buffer
	if err := world.Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := loadWorld(logger, path)
	if err != nil || got.Island("mini") == nil {
		t.Fatalf("loadWorld = %v, %v", got, err)
	}
}

func TestAuthRateLimit(t *testing.T) {
	if got := authRateLimit(0); got != (httpapi.RateLimit{}) {
		t.Errorf("authRateLimit(0) = %+v, want the zero value (httpapi default)", got)
	}
	if got := authRateLimit(-3); got != (httpapi.RateLimit{}) {
		t.Errorf("authRateLimit(-3) = %+v, want the zero value", got)
	}
	want := httpapi.RateLimit{Burst: 1000, Every: httpapi.DefaultAuthRateLimit.Every}
	if got := authRateLimit(1000); got != want {
		t.Errorf("authRateLimit(1000) = %+v, want %+v", got, want)
	}
}

// TestServeMetricsBindsBeforeReturning: the listener is bound when serveMetrics returns
// (the log names the real address), and a busy address is an error, not a later warning.
func TestServeMetricsBindsBeforeReturning(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	srv, err := serveMetrics("127.0.0.1:0", metrics.New(), logger)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	var line struct{ Addr string }
	for _, l := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if strings.Contains(l, "metrics listening") {
			_ = json.Unmarshal([]byte(l), &line)
		}
	}
	if line.Addr == "" || strings.HasSuffix(line.Addr, ":0") {
		t.Fatalf("log %q does not name the bound address", logs.String())
	}
	resp, err := http.Get("http://" + line.Addr + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(body), "tick_duration_ms") {
		t.Fatalf("metrics body lacks tick_duration_ms")
	}

	if _, err := serveMetrics(line.Addr, metrics.New(), logger); err == nil {
		t.Fatal("binding a busy address succeeded")
	}
}

func TestMetricsLingerOnlyAfterAbandonedWrites(t *testing.T) {
	m := metrics.New()
	if d := metricsLinger(m, true, 20*time.Second); d != 0 {
		t.Fatalf("linger %v without abandoned writes", d)
	}
	m.PersistenceError(metrics.WriterEconomy, metrics.OutcomeRetry)
	if d := metricsLinger(m, true, 20*time.Second); d != 0 {
		t.Fatalf("linger %v after a retry only", d)
	}
	m.PersistenceError(metrics.WriterEconomy, metrics.OutcomeAbandoned)
	if d := metricsLinger(m, true, 20*time.Second); d != 20*time.Second {
		t.Fatalf("linger %v, want 20s", d)
	}
	if d := metricsLinger(m, false, 20*time.Second); d != 0 {
		t.Fatalf("linger %v with no metrics listener", d)
	}
	if d := metricsLinger(nil, true, 20*time.Second); d != 0 {
		t.Fatalf("linger %v without metrics", d)
	}
}

func TestProvidersFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	ps, names, err := providersFromEnv(env(map[string]string{"GOOGLE_CLIENT_ID": "id", "GOOGLE_CLIENT_SECRET": "s"}))
	if err != nil || len(ps) != 1 || names[0] != "google" {
		t.Fatalf("%v %v", names, err)
	}
	if ps, _, err := providersFromEnv(env(nil)); err != nil || len(ps) != 0 {
		t.Fatal("no keys must mean no providers")
	}
	if _, _, err := providersFromEnv(env(map[string]string{"DISCORD_CLIENT_ID": "id"})); err == nil {
		t.Fatal("half a provider accepted")
	}
}
