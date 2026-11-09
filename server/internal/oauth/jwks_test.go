package oauth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// jwksServer serves a key set it can rotate and hold: while held, each fetch blocks until
// release is closed.
type jwksServer struct {
	*httptest.Server
	fetches atomic.Int32
	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	hold    chan struct{} // nil = answer at once
	entered chan struct{}
}

func newJWKSServer(t *testing.T, keys map[string]*rsa.PublicKey) *jwksServer {
	s := &jwksServer{keys: keys, entered: make(chan struct{}, 16)}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		s.fetches.Add(1)
		s.mu.Lock()
		hold, keys := s.hold, s.keys
		s.mu.Unlock()
		if hold != nil {
			s.entered <- struct{}{}
			<-hold
		}
		var out []map[string]string
		for kid, k := range keys {
			out = append(out, map[string]string{"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
				"n": base64.RawURLEncoding.EncodeToString(k.N.Bytes()),
				"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.E)).Bytes())})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": out})
	}))
	t.Cleanup(s.Close)
	return s
}

// set changes the served keys and whether fetches are held (it returns the release).
func (s *jwksServer) set(keys map[string]*rsa.PublicKey, held bool) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys, s.hold = keys, nil
	if held {
		s.hold = make(chan struct{})
	}
	return s.hold
}

func rsaKey(t *testing.T) *rsa.PublicKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return &k.PublicKey
}

// countWaiters makes jwksWaiting report each lookup that waits for the fetch in flight.
func countWaiters(t *testing.T) chan struct{} {
	ch := make(chan struct{}, 64)
	jwksWaiting = func() { ch <- struct{}{} }
	t.Cleanup(func() { jwksWaiting = func() {} })
	return ch
}

// lookups runs n concurrent key(kid) lookups with ctx and returns their results.
func lookups(j *jwks, ctx context.Context, n int, kid string, at time.Time) chan error {
	errs := make(chan error, n)
	for range n {
		go func() {
			k, err := j.key(ctx, kid, at)
			if err == nil && k == nil {
				err = ErrInvalidToken
			}
			errs <- err
		}()
	}
	return errs
}

func waitAll(t *testing.T, errs chan error, n int) {
	t.Helper()
	for range n {
		select {
		case err := <-errs:
			if err != nil {
				t.Fatalf("lookup: %v", err)
			}
		case <-time.After(10 * time.Second): //nolint:forbidigo // test timeout
			t.Fatal("a lookup never returned")
		}
	}
}

func waitN(t *testing.T, ch chan struct{}, n int) {
	t.Helper()
	for range n {
		select {
		case <-ch:
		case <-time.After(10 * time.Second): //nolint:forbidigo // test timeout
			t.Fatal("not every lookup waited")
		}
	}
}

// The JWKS cache never holds its lock during the fetch: while a slow provider answers, a
// known key is still served, and concurrent misses share the fetch in flight.
func TestJWKSFetchWithoutLock(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	ctx := context.Background()
	k1, k2 := rsaKey(t), rsaKey(t)

	t.Run("rotation", func(t *testing.T) {
		srv := newJWKSServer(t, map[string]*rsa.PublicKey{"k1": k1})
		j := &jwks{url: srv.URL, client: srv.Client()}
		if _, err := j.key(ctx, "k1", t0); err != nil {
			t.Fatal(err)
		}
		waiting := countWaiters(t)
		release := srv.set(map[string]*rsa.PublicKey{"k1": k1, "k2": k2}, true) // rotated, held
		later := t0.Add(2 * jwksMaxAge)                                         // stale: refetch
		leader := lookups(j, ctx, 1, "k2", later)
		<-srv.entered
		// With the fetch stuck, the known (stale) key is served at once.
		if k, err := j.key(ctx, "k1", later); err != nil || k == nil {
			t.Fatalf("cached key while fetching: %v", err)
		}
		// The new kid: these wait for that same fetch and get the rotated key.
		misses := lookups(j, ctx, 8, "k2", later)
		waitN(t, waiting, 8)
		close(release)
		waitAll(t, leader, 1)
		waitAll(t, misses, 8)
		if n := srv.fetches.Load(); n != 2 {
			t.Fatalf("fetches = %d, want 2 (start, one shared)", n)
		}
	})

	t.Run("cold start", func(t *testing.T) {
		srv := newJWKSServer(t, map[string]*rsa.PublicKey{"k1": k1})
		j := &jwks{url: srv.URL, client: srv.Client()}
		waiting := countWaiters(t)
		release := srv.set(map[string]*rsa.PublicKey{"k1": k1}, true)
		errs := lookups(j, ctx, 10, "k1", t0)
		<-srv.entered
		waitN(t, waiting, 9) // all but the one fetching
		close(release)
		waitAll(t, errs, 10)
		if n := srv.fetches.Load(); n != 1 {
			t.Fatalf("fetches = %d, want 1", n)
		}
	})

	t.Run("leader cancelled", func(t *testing.T) {
		srv := newJWKSServer(t, map[string]*rsa.PublicKey{"k1": k1})
		j := &jwks{url: srv.URL, client: srv.Client()}
		waiting := countWaiters(t)
		release := srv.set(map[string]*rsa.PublicKey{"k1": k1}, true)
		lctx, cancel := context.WithCancel(ctx)
		leader := lookups(j, lctx, 1, "k1", t0)
		<-srv.entered
		misses := lookups(j, ctx, 4, "k1", t0)
		waitN(t, waiting, 4)
		cancel()                          // the shared fetch has its own deadline: the waiters still get the key
		time.Sleep(20 * time.Millisecond) //nolint:forbidigo // give a cancellation time to (wrongly) cut the fetch
		close(release)
		waitAll(t, misses, 4)
		waitAll(t, leader, 1)
		if n := srv.fetches.Load(); n != 1 {
			t.Fatalf("fetches = %d, want 1", n)
		}
	})
}
