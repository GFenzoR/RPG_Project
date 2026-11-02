package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// serveRecovered runs h behind the recoverer and returns the status, body and any
// transport error while reading the response.
func serveRecovered(t *testing.T, h http.HandlerFunc) (int, string, error) {
	t.Helper()
	a := &api{log: slog.New(slog.DiscardHandler)}
	srv := httptest.NewServer(a.recoverer(h))
	t.Cleanup(srv.Close)
	resp, err := http.Get(srv.URL)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), err
}

func TestRecoverBeforeWriteSends500(t *testing.T) {
	status, body, err := serveRecovered(t, func(http.ResponseWriter, *http.Request) {
		var none []int
		_ = none[len(body0())] // runtime panic before anything is written
	})
	if err != nil || status != 500 || !strings.Contains(body, `"internal"`) {
		t.Fatalf("got %d %q %v", status, body, err)
	}
}

// TestRecoverAfterWriteAborts: a panic mid-response must not look like a complete body.
func TestRecoverAfterWriteAborts(t *testing.T) {
	_, body, err := serveRecovered(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "100")
		_, _ = w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		var none []int
		_ = none[len(body0())]
	})
	if err == nil {
		t.Fatalf("expected an aborted response, got complete body %q", body)
	}
	if strings.Contains(body, "internal") {
		t.Fatal("must not append a 500 body to a started response")
	}
}

func body0() string { return "" }
