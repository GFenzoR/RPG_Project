package oauth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/oauth/oauthtest"
)

// The JWKS cache never holds its lock during the fetch: while a slow provider answers,
// a known key is still served, and concurrent misses share that one fetch.
func TestJWKSFetchWithoutLock(t *testing.T) {
	f := oauthtest.New()
	var fetches atomic.Int32
	var block atomic.Bool
	entered, release := make(chan struct{}, 16), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		if block.Load() {
			entered <- struct{}{}
			<-release
		}
		f.ServeHTTP(w, r)
	}))
	defer srv.Close()
	f.Base = srv.URL
	j := &jwks{url: srv.URL + "/google/jwks", client: srv.Client()}
	ctx := context.Background()
	t0 := time.Unix(1_700_000_000, 0)
	if _, err := j.key(ctx, "fake-1", t0); err != nil {
		t.Fatal(err)
	}

	block.Store(true)
	later := t0.Add(2 * jwksMaxAge) // stale: the next lookup refetches
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // the leader: refetches and blocks in the provider
		defer wg.Done()
		if _, err := j.key(ctx, "fake-1", later); err != nil {
			t.Error(err)
		}
	}()
	<-entered

	// With the fetch stuck, the known key is served at once.
	done := make(chan error, 1)
	go func() { _, err := j.key(ctx, "fake-1", later); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second): //nolint:forbidigo // test timeout
		t.Fatal("a cached key waited for the fetch")
	}

	// Unknown kids wait for the fetch in flight instead of starting their own.
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := j.key(ctx, "nope", later)
			errs <- err
		}()
	}
	time.Sleep(50 * time.Millisecond) //nolint:forbidigo // let the waiters reach the call
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("unknown kid: %v", err)
		}
	}
	if n := fetches.Load(); n != 2 {
		t.Fatalf("fetches = %d, want 2 (one at start, one shared)", n)
	}
}
