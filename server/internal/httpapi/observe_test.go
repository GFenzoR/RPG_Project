package httpapi_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
)

// The observer gets the route pattern (never the raw path) and the status, also through
// an outer ServeMux like the one app mounts the API on.
func TestObserveReportsRouteAndStatus(t *testing.T) {
	var mu sync.Mutex
	var got []string
	healthy := true
	h := newHarness(t, func(c *httpapi.Config) {
		c.Observe = func(route string, code int, _ time.Duration) {
			mu.Lock()
			got = append(got, fmt.Sprintf("%s=%d", route, code))
			mu.Unlock()
		}
		c.Health = func(context.Context) error {
			if healthy {
				return nil
			}
			return errors.New("db down")
		}
	})
	outer := http.NewServeMux()
	outer.Handle("/", h.h)
	for _, path := range []string{"/healthz", "/api/no/such/thing?x=1", "/elsewhere"} {
		outer.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
	}
	healthy = false
	outer.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/healthz", nil))
	h.do(req{method: "GET", path: "/elsewhere"}) // without the outer mux

	want := fmt.Sprint([]string{"GET /healthz=200", "/api/=404", "unmatched=404", "GET /healthz=503", "unmatched=404"})
	mu.Lock()
	defer mu.Unlock()
	if fmt.Sprint(got) != want {
		t.Fatalf("observed %v, want %v", got, want)
	}
}
