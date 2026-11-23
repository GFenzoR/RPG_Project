package httpapi_test

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Regression tests of the second review of the lote 16 API limits (minor findings).

// Minor 3: a 429 of the per-network hashing cap gives back the per-IP and per-network
// tokens rateLimited spent, so people behind one NAT who retry while two of them are
// logging in do not burn their per-IP burst.
func TestHashingCapRefundsThePerIPBudget(t *testing.T) {
	entered := make(chan struct{}, 10)
	release := make(chan struct{})
	acc := &fakeAccounts{login: func() (auth.Token, error) {
		entered <- struct{}{}
		<-release
		return auth.Token{Token: "t", ExpiresAt: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)}, nil
	}}
	h, _ := newCountingAPI(t, acc, nil) // fake clock: no refill during the test
	body := `{"email":"ana@example.org","password":"secreto123"}`
	done := make(chan int, httpapi.DefaultNetHashing)
	for i := 0; i < httpapi.DefaultNetHashing; i++ {
		go func() { done <- serve(h, "POST", "/api/auth/login", body, "5.5.5.5:1", nil).Code }()
		<-entered
	}
	for i := 0; i < 3*httpapi.DefaultAuthRateLimit.Burst; i++ {
		expect(t, serve(h, "POST", "/api/auth/login", body, "5.5.5.5:1", nil), http.StatusTooManyRequests, "rate_limited")
	}
	close(release)
	for i := 0; i < httpapi.DefaultNetHashing; i++ {
		if code := <-done; code != http.StatusOK {
			t.Fatalf("held login: %d", code)
		}
	}
	// The retries cost nothing: the address still has budget left.
	if code := serve(h, "POST", "/api/auth/login", body, "5.5.5.5:1", nil).Code; code != http.StatusOK {
		t.Fatalf("login after the hashing 429s got %d: the per-IP budget was spent", code)
	}
}

// takenNames rejects every character name as taken.
type takenNames struct{ *countingAccounts }

func (takenNames) CreateCharacter(context.Context, int64, string, string, *content.Look) (store.Character, error) {
	return store.Character{}, auth.ErrNameTaken
}

// Minor 8: trying names that are taken or invalid writes nothing, so it does not spend
// the account's write budget (play still works after many rejected names).
func TestRejectedCharacterNamesKeepTheWriteBudget(t *testing.T) {
	acc := takenNames{newCounting()}
	h, _ := newCountingAPI(t, acc, func(c *httpapi.Config) {
		c.TokenRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
		c.AccountRateLimit = httpapi.RateLimit{Burst: 10000, Every: time.Millisecond}
	})
	good := map[string]string{"Authorization": "Bearer good"}
	for i := 0; i < 3*httpapi.DefaultAccountWriteRateLimit.Burst; i++ {
		expect(t, serve(h, "POST", "/api/characters", fmt.Sprintf(`{"name":"Ana%c","vocation":"guardian"}`, 'a'+i%26), "10.0.0.1:1", good), http.StatusConflict, "name_taken")
		expect(t, serve(h, "POST", "/api/characters", `{not json`, "10.0.0.1:1", good), http.StatusBadRequest, "")
	}
	expect(t, serve(h, "POST", "/api/play", `{"character_id":1}`, "10.0.0.1:1", good), http.StatusOK, "")
}

// deadlineAccounts records whether the lookups before an unlink password check ran
// with a deadline.
type deadlineAccounts struct {
	*fakeAccounts
	authDeadline, profileDeadline atomic.Bool
}

func (d *deadlineAccounts) Authenticate(ctx context.Context, _ string) (int64, error) {
	_, ok := ctx.Deadline()
	d.authDeadline.Store(ok)
	return 7, nil
}

func (d *deadlineAccounts) Profile(ctx context.Context, _ int64) (store.Profile, error) {
	_, ok := ctx.Deadline()
	d.profileDeadline.Store(ok)
	return store.Profile{Email: "ana@example.org"}, nil
}

// Minor 2: unlink with a password looks up the session and the profile under the same
// short deadline as the authed routes.
func TestReauthLookupsHaveADeadline(t *testing.T) {
	acc := &deadlineAccounts{fakeAccounts: &fakeAccounts{login: wrongPassword}}
	h, _ := newCountingAPI(t, acc, nil)
	w := serve(h, "POST", "/api/account/unlink", `{"provider":"google","password":"secreto123"}`, "1.2.3.4:1",
		map[string]string{"Authorization": "Bearer good"})
	if w.Code != http.StatusNoContent {
		t.Fatalf("unlink: %d %s", w.Code, w.Body.String())
	}
	if !acc.authDeadline.Load() || !acc.profileDeadline.Load() {
		t.Fatalf("no deadline: Authenticate %v, Profile %v", acc.authDeadline.Load(), acc.profileDeadline.Load())
	}
}

// Minor 6: a health check whose caller left while waiting for the shared ping is not
// logged as a dependency outage.
func TestHealthzCallerLeavingIsNotLogged(t *testing.T) {
	logs := &recordLogs{}
	entered := make(chan struct{})
	release := make(chan struct{})
	h, _ := newCountingAPI(t, newCounting(), func(c *httpapi.Config) {
		c.Logger = slog.New(logs)
		c.Health = func(context.Context) error {
			close(entered)
			<-release
			return nil
		}
	})
	first := make(chan int, 1)
	go func() { first <- serve(h, "GET", "/healthz", "", "1.1.1.1:1", nil).Code }()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("GET", "/healthz", strings.NewReader("")).WithContext(ctx)
	h.ServeHTTP(httptest.NewRecorder(), r)
	close(release)
	if code := <-first; code != http.StatusOK {
		t.Fatalf("pinging request: %d", code)
	}
	if n, _ := logs.count("healthz: dependency down"); n != 0 {
		t.Fatalf("%d outage lines for a caller that left", n)
	}
}
