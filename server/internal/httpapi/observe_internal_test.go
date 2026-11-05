package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

type observed struct {
	route string
	code  int
	d     time.Duration
}

// observeHarness wraps h like New does (observe outside recoverer, a mux inside).
func observeHarness(t *testing.T, h http.HandlerFunc) (http.Handler, *clock.Fake, *[]observed) {
	t.Helper()
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	var got []observed
	a := &api{cfg: Config{Clock: clk, Observe: func(route string, code int, d time.Duration) {
		got = append(got, observed{route, code, d})
	}}, log: slog.New(slog.DiscardHandler)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /x", h)
	return a.observe(a.recoverer(mux)), clk, &got
}

// The duration comes from the injected clock, and Flush and http.ResponseController
// still reach the real writer through statusWriter.
func TestObserveDurationAndFlush(t *testing.T) {
	var clk *clock.Fake
	h, clk, got := observeHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		clk.Advance(30 * time.Millisecond)
		w.WriteHeader(http.StatusAccepted)
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("ResponseController.Flush: %v", err)
		}
		w.(http.Flusher).Flush()
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	if !rec.Flushed || rec.Code != http.StatusAccepted {
		t.Fatalf("recorder flushed=%v code=%d", rec.Flushed, rec.Code)
	}
	if len(*got) != 1 || (*got)[0] != (observed{"GET /x", 202, 30 * time.Millisecond}) {
		t.Fatalf("observed %+v", *got)
	}
}

// A panic before the response started is a 500 from recoverer; after it started, the
// response is aborted (http.ErrAbortHandler goes on to net/http) and still counted.
func TestObservePanics(t *testing.T) {
	started := false
	h, _, got := observeHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		if started {
			_, _ = w.Write([]byte("partial"))
		}
		panic("boom") //nolint:forbidigo // the panic under test
	})
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))

	started = true
	func() {
		defer func() {
			if v := recover(); v == nil || !errors.Is(v.(error), http.ErrAbortHandler) {
				t.Errorf("recovered %v, want http.ErrAbortHandler", v)
			}
		}()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
	}()
	if len(*got) != 2 || (*got)[0].code != 500 || (*got)[1].code != 500 || (*got)[1].route != "GET /x" {
		t.Fatalf("observed %+v", *got)
	}
}
