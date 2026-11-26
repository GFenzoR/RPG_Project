package gateway

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Audit lote 16: the connection, handshake and player limits of /ws.

// limited is a stack whose clients are told apart by X-Forwarded-For (TrustProxy) and
// get no loopback exemption.
func limited(t *testing.T, lim Limits, mutate func(*Config)) *stack {
	t.Helper()
	return newStack(t, func(c *Config) {
		c.TrustProxy = true
		c.ExemptLoopback = false
		c.Limits = lim
		if mutate != nil {
			mutate(c)
		}
	})
}

// dialFrom dials as client ip; on a refused upgrade it returns the HTTP status.
func (s *stack) dialFrom(ip string) (*client, int) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, s.url, &websocket.DialOptions{HTTPHeader: http.Header{"X-Forwarded-For": {ip}}}) //nolint:bodyclose // websocket.Dial closes the response body itself
	if err != nil {
		if resp == nil {
			s.t.Fatalf("dial %s: %v", ip, err)
		}
		return nil, resp.StatusCode
	}
	ws.SetReadLimit(1 << 20)
	s.t.Cleanup(func() { _ = ws.CloseNow() })
	return &client{t: s.t, ws: ws}, 0
}

func (s *stack) mustDialFrom(ip string) *client {
	s.t.Helper()
	c, status := s.dialFrom(ip)
	if c == nil {
		s.t.Fatalf("dial %s refused with %d", ip, status)
	}
	return c
}

func (s *stack) loginFrom(ip, tok string, char int64) *client {
	s.t.Helper()
	s.token(tok, char)
	c := s.mustDialFrom(ip)
	if err := c.send(hello(tok, DefaultMinClientVersion)); err != nil {
		s.t.Fatal(err)
	}
	c.until("welcome", func(e *pb.ServerMessage) bool { return e.GetWelcome() != nil })
	return c
}

// closed waits until the server closes c.
func (c *client) closed() {
	c.t.Helper()
	for {
		if _, err := c.next(); err != nil {
			return
		}
	}
}

func TestPerClientConnectionCap(t *testing.T) {
	s := limited(t, Limits{MaxConnsPerClient: 3, MaxPendingPerClient: -1, HandshakeBurst: -1}, nil)
	s.loginFrom("203.0.113.1", "a", 7) // a logged-in connection counts too
	for range 2 {
		s.mustDialFrom("203.0.113.1")
	}
	if c, status := s.dialFrom("203.0.113.1"); c != nil || status != http.StatusTooManyRequests {
		t.Fatalf("4th connection: %v, status %d", c != nil, status)
	}
	if n := s.accounts.calls.Load(); n != 1 {
		t.Fatalf("redeems %d, want only the login's", n)
	}
	// Another client is not affected.
	s.loginFrom("198.51.100.9", "b", 8)
	// An IPv6 /64 is one client.
	for i := range 3 {
		s.mustDialFrom("2001:db8:0:1::" + string(rune('1'+i)))
	}
	if _, status := s.dialFrom("2001:db8:0:1:ffff::1"); status != http.StatusTooManyRequests {
		t.Fatalf("same /64: status %d", status)
	}
}

func TestPendingSlotsFreeAfterHelloWait(t *testing.T) {
	s := limited(t, Limits{MaxConnsPerClient: -1, MaxPendingPerClient: 2, HandshakeBurst: -1},
		func(c *Config) { c.HelloWait = 100 * time.Millisecond })
	idle := []*client{s.mustDialFrom("203.0.113.2"), s.mustDialFrom("203.0.113.2")}
	if _, status := s.dialFrom("203.0.113.2"); status != http.StatusTooManyRequests {
		t.Fatalf("3rd pending: status %d", status)
	}
	for _, c := range idle {
		c.closed() // the Hello wait ran out
	}
	waitFor(t, func() bool { u, _, _ := s.gw.adm.counts(); return u == 0 })
	s.loginFrom("203.0.113.2", "a", 7)
	if n := s.accounts.calls.Load(); n != 1 {
		t.Fatalf("redeems %d", n)
	}
}

func TestHandshakeBucketBoundsRedeems(t *testing.T) {
	// The gateway's fake clock never moves: the bucket gives its burst of 5 and no more.
	s := limited(t, Limits{}, nil)
	refused := 0
	for range 50 {
		c, status := s.dialFrom("203.0.113.3")
		if c == nil {
			if status != http.StatusTooManyRequests {
				t.Fatalf("status %d", status)
			}
			refused++
			continue
		}
		var raw [32]byte
		_, _ = rand.Read(raw[:])
		if err := c.send(helloRaw(base64.RawURLEncoding.EncodeToString(raw[:]), DefaultMinClientVersion)); err != nil {
			t.Fatal(err)
		}
		if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION {
			t.Fatalf("reason %v", r)
		}
	}
	if n := s.accounts.calls.Load(); n > int32(DefaultLimits.HandshakeBurst) || refused < 45 {
		t.Fatalf("%d redeems, %d refused", n, refused)
	}
}

func TestMalformedTokensNeverReachTheRepository(t *testing.T) {
	s := newStack(t, nil)
	for _, tok := range []string{
		strings.Repeat("a", 10), strings.Repeat("a", 129), strings.Repeat("a", 42), strings.Repeat("a", 44),
		strings.Repeat("a", 42) + "=", strings.Repeat("a", 42) + "+", "",
	} {
		c := s.dial()
		if err := c.send(helloRaw(tok, DefaultMinClientVersion)); err != nil {
			t.Fatal(err)
		}
		if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION {
			t.Fatalf("%q: reason %v", tok, r)
		}
	}
	if n := s.accounts.calls.Load(); n != 0 {
		t.Fatalf("%d redeems of malformed tokens", n)
	}
	if !validToken(tk("x")) {
		t.Fatal("a real token shape refused")
	}
}

func TestFullHandshakeSemaphoreRefusesBeforeHello(t *testing.T) {
	s := limited(t, Limits{MaxHandshakes: 1}, nil)
	release := make(chan struct{})
	s.accounts.mu.Lock()
	s.accounts.block = release
	s.accounts.mu.Unlock()
	s.token("a", 7)
	first := s.mustDialFrom("203.0.113.4")
	if err := first.send(hello("a", DefaultMinClientVersion)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return s.accounts.calls.Load() == 1 }) // holds the only slot
	if c, status := s.dialFrom("198.51.100.4"); c != nil || status != http.StatusServiceUnavailable {
		t.Fatalf("while the slot is busy: %v, status %d", c != nil, status)
	}
	s.accounts.mu.Lock()
	s.accounts.block = nil
	s.accounts.mu.Unlock()
	close(release)
	first.until("welcome", func(e *pb.ServerMessage) bool { return e.GetWelcome() != nil })
	if n := s.accounts.calls.Load(); n != 1 {
		t.Fatalf("redeems %d", n)
	}
	s.loginFrom("198.51.100.4", "b", 8) // free again
}

// A Hello with a forged token of the right shape must not hold a MaxPlayers slot while
// its redeem runs (review of lote 16): with the slot reserved before the redeem, enough
// forged Hellos kept real players out with SERVER_FULL.
func TestForgedTokenHoldsNoPlayerSlot(t *testing.T) {
	s := newStack(t, func(c *Config) { c.Limits = Limits{MaxPlayers: 1} })
	release := make(chan struct{})
	s.accounts.mu.Lock()
	s.accounts.block = release
	s.accounts.mu.Unlock()
	forged := s.dial()
	if err := forged.send(hello("forged", DefaultMinClientVersion)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return s.accounts.calls.Load() == 1 }) // inside its redeem
	if _, players, _ := s.gw.adm.counts(); players != 0 {
		t.Fatalf("a login still redeeming holds %d player slots", players)
	}
	s.accounts.mu.Lock()
	s.accounts.block = nil
	s.accounts.mu.Unlock()
	close(release)
	if r := forged.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION {
		t.Fatalf("forged token: reason %v", r)
	}
	s.login("a", 7) // the only slot was never taken
	if _, players, _ := s.gw.adm.counts(); players != 1 {
		t.Fatalf("player slots %d after a login", players)
	}
}

// Two logins race for the last slot: both pass the early check, the one whose redeem
// ends second gets SERVER_FULL and holds nothing.
func TestLastPlayerSlotTakenAfterRedeem(t *testing.T) {
	s := newStack(t, func(c *Config) { c.Limits = Limits{MaxPlayers: 1} })
	release := make(chan struct{})
	s.accounts.mu.Lock()
	s.accounts.block = release
	s.accounts.mu.Unlock()
	s.token("a", 7)
	s.token("b", 8)
	slow := s.dial()
	if err := slow.send(hello("a", DefaultMinClientVersion)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return s.accounts.calls.Load() == 1 })
	s.accounts.mu.Lock()
	s.accounts.block = nil
	s.accounts.mu.Unlock()
	s.login("b", 8) // passes while the first is still redeeming
	close(release)
	if r := slow.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_SERVER_FULL {
		t.Fatalf("reason %v", r)
	}
	waitFor(t, func() bool { _, players, _ := s.gw.adm.counts(); return players == 1 })
}

func TestGlobalUnauthenticatedCap(t *testing.T) {
	s := limited(t, Limits{MaxUnauthenticated: 2}, nil)
	s.mustDialFrom("203.0.113.5")
	s.mustDialFrom("203.0.113.6")
	if _, status := s.dialFrom("203.0.113.7"); status != http.StatusServiceUnavailable {
		t.Fatalf("status %d", status)
	}
}

func TestMaxPlayersGivesServerFull(t *testing.T) {
	s := newStack(t, func(c *Config) { c.Limits = Limits{MaxPlayers: 1} })
	first := s.login("a", 7)
	calls := s.accounts.calls.Load()
	s.token("b", 8)
	c := s.dial()
	if err := c.send(hello("b", DefaultMinClientVersion)); err != nil {
		t.Fatal(err)
	}
	if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_SERVER_FULL {
		t.Fatalf("reason %v", r)
	}
	if n := s.accounts.calls.Load(); n != calls {
		t.Fatalf("the refused login reached the repository (%d redeems)", n)
	}
	if err := first.send(&pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}}); err != nil {
		t.Fatal(err)
	}
	first.disconnect()
	waitFor(t, func() bool { return s.gw.Connections() == 0 })
	s.login("b", 8) // the slot is free; the token was not spent
}

// refusingLoop refuses every shared-queue command while refuse is set (lifecycle
// commands still pass), like a queue flooded by others.
type refusingLoop struct {
	inner  Loop
	refuse atomic.Bool
}

func (l *refusingLoop) Enqueue(cmd game.Command) error {
	if _, life := cmd.(game.LifecycleFunc); !life && l.refuse.Load() {
		return game.ErrQueueFull
	}
	return l.inner.Enqueue(cmd)
}

// recordCounter counts the log records with one message and sums their "count".
type recordCounter struct {
	msg     string
	mu      sync.Mutex
	records int
	total   int64
}

func (h *recordCounter) Enabled(context.Context, slog.Level) bool { return true }
func (h *recordCounter) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h *recordCounter) WithGroup(string) slog.Handler            { return h }
func (h *recordCounter) Handle(_ context.Context, r slog.Record) error {
	if r.Message != h.msg {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records++
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "count" {
			h.total += a.Value.Int64()
		}
		return true
	})
	return nil
}

func TestDroppedCommandsAreLoggedOnce(t *testing.T) {
	logs := &recordCounter{msg: "gateway: commands dropped"}
	var rl *refusingLoop
	s := newStack(t, func(c *Config) {
		rl = &refusingLoop{inner: c.Loop}
		c.Loop = rl
		c.Logger = slog.New(logs)
		c.RateLimit = RateLimit{PerSecond: 1e9, Burst: 1e9, MaxDebt: 1}
	})
	c := s.login("a", 7)
	rl.refuse.Store(true)
	ping := &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: 1}}}
	for range 1000 {
		if err := c.send(ping); err != nil {
			t.Fatal(err)
		}
	}
	_ = c.ws.Close(websocket.StatusNormalClosure, "")
	waitFor(t, func() bool { return s.gw.Connections() == 0 })
	logs.mu.Lock()
	defer logs.mu.Unlock()
	if logs.records < 1 || logs.records > 2 || logs.total != 1000 {
		t.Fatalf("%d records counting %d drops", logs.records, logs.total)
	}
}

// A connection never holds more than MaxQueuedPerConn commands in the loop.
func TestPerConnectionQuota(t *testing.T) {
	q := game.NewQuota(DefaultLimits.MaxQueuedPerConn)
	hold := &holdLoop{}
	n := 0
	for range 100 {
		if q.Enqueue(hold, game.CommandFunc(func(*game.TickContext) {})) == nil {
			n++
		}
	}
	if n != DefaultLimits.MaxQueuedPerConn {
		t.Fatalf("queued %d", n)
	}
	if !errors.Is(q.Enqueue(hold, game.CommandFunc(func(*game.TickContext) {})), game.ErrQuotaExceeded) {
		t.Fatal("quota not enforced")
	}
}

type holdLoop struct{ cmds []game.Command }

func (h *holdLoop) Enqueue(cmd game.Command) error { h.cmds = append(h.cmds, cmd); return nil }

func TestLogEvery(t *testing.T) {
	l := &logEvery{interval: 10 * time.Second}
	t0 := time.Unix(0, 0)
	if n := l.hit(t0); n != 1 {
		t.Fatalf("first hit reports %d", n)
	}
	for range 99 {
		if l.hit(t0.Add(time.Second)) != 0 {
			t.Fatal("reported inside the interval")
		}
	}
	if n := l.hit(t0.Add(11 * time.Second)); n != 100 {
		t.Fatalf("after the interval: %d", n)
	}
	l.hit(t0.Add(12 * time.Second))
	if n := l.flush(); n != 1 {
		t.Fatalf("flush %d", n)
	}
}

// Many honest players behind one public IPv4 (mobile CGNAT, a cybercafe, a school) each
// hold a logged-in connection: with 8 per client the 9th got 429. They join a bit apart
// (the handshake bucket refills) and all stay in.
func TestSharedIPv4FitsManyPlayers(t *testing.T) {
	a := newAdmission(DefaultLimits.withDefaults())
	now := time.Unix(0, 0)
	const players = 24
	for i := range players {
		tk, status := a.admit("203.0.113.50", false, now)
		if tk == nil {
			t.Fatalf("player %d behind the shared IP refused with %d", i+1, status)
		}
		if !tk.reservePlayer() {
			t.Fatalf("player %d: no player slot", i+1)
		}
		tk.authenticated()
		now = now.Add(DefaultLimits.HandshakeEvery)
	}
	// The pending cap and the bucket still bound the handshakes of that IP.
	for range DefaultLimits.MaxPendingPerClient {
		if tk, _ := a.admit("203.0.113.50", false, now); tk == nil {
			break
		}
	}
	if tk, status := a.admit("203.0.113.50", false, now); tk != nil || status != http.StatusTooManyRequests {
		t.Fatalf("handshakes of the shared IP not bounded: %v, %d", tk != nil, status)
	}
}

// A burst the rate limiter accepts must fit the connection's quota: before, the quota
// (16) dropped the 17th to 60th command of a burst of 60 without telling the client.
func TestQuotaHoldsTheLimiterBurst(t *testing.T) {
	now := time.Unix(0, 0)
	lim := newLimiter(DefaultRateLimit, now)
	q := game.NewQuota(DefaultLimits.MaxQueuedPerConn)
	hold := &holdLoop{}
	accepted := 0
	for lim.take(now) == allow {
		accepted++
		if err := q.Enqueue(hold, game.CommandFunc(func(*game.TickContext) {})); err != nil {
			t.Fatalf("command %d of an accepted burst dropped: %v", accepted, err)
		}
	}
	if accepted < int(DefaultRateLimit.Burst) {
		t.Fatalf("limiter accepted %d of its burst %v", accepted, DefaultRateLimit.Burst)
	}
}

// refusalCounter is an Observer that counts the refusals by reason.
type refusalCounter struct {
	mu      sync.Mutex
	refused map[string]int
}

func (r *refusalCounter) Sent(int)    {}
func (r *refusalCounter) ConnOpened() {}
func (r *refusalCounter) ConnClosed() {}
func (r *refusalCounter) ConnRefused(reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refused[reason]++
}

func (r *refusalCounter) get(reason string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.refused[reason]
}

// The refusals of the limits reach the metrics by reason, so an attack or a badly tuned
// limit shows in /metrics (ws_refused_total).
func TestRefusalsAreCounted(t *testing.T) {
	obs := &refusalCounter{refused: map[string]int{}}
	s := limited(t, Limits{MaxConnsPerClient: 1, MaxUnauthenticated: 1, MaxPlayers: 1}, func(c *Config) { c.Metrics = obs })
	s.loginFrom("203.0.113.60", "a", 7)
	if _, status := s.dialFrom("203.0.113.60"); status != http.StatusTooManyRequests {
		t.Fatalf("429 expected, got %d", status)
	}
	c := s.mustDialFrom("198.51.100.61") // the only unauthenticated place
	if _, status := s.dialFrom("198.51.100.62"); status != http.StatusServiceUnavailable {
		t.Fatalf("503 expected, got %d", status)
	}
	s.token("b", 8)
	if err := c.send(hello("b", DefaultMinClientVersion)); err != nil {
		t.Fatal(err)
	}
	if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_SERVER_FULL {
		t.Fatalf("reason %v", r)
	}
	for _, reason := range []string{RefusedClientLimit, RefusedServerBusy, RefusedServerFull} {
		if obs.get(reason) != 1 {
			t.Fatalf("refusals %v, want one of each", obs.refused)
		}
	}
}
