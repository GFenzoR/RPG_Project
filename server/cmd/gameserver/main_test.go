package main

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
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
	if srv.BaseContext(nil) == context.Background() {
		t.Fatal("requests must derive from a cancellable base context")
	}
}
