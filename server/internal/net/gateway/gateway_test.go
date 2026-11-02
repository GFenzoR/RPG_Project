package gateway

import (
	"context"
	"errors"
	"math/rand/v2"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
)

type fakeAccounts struct {
	mu     sync.Mutex
	tokens map[string][2]int64
}

func (f *fakeAccounts) RedeemPlayToken(_ context.Context, tok string) (int64, int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.tokens[tok]
	if !ok {
		return 0, 0, auth.ErrUnauthorized
	}
	delete(f.tokens, tok)
	return v[0], v[1], nil
}

type fakeChars struct{}

func (fakeChars) PlayCharacter(_ context.Context, acc, id int64, _ time.Time) (store.PlayCharacter, error) {
	if id == 404 {
		return store.PlayCharacter{}, store.ErrNotFound
	}
	return store.PlayCharacter{ID: id, AccountID: acc, Name: "Mira", Vocation: "guardian", Level: 1, Health: 100}, nil
}

type stack struct {
	t        *testing.T
	gw       *Gateway
	url      string
	accounts *fakeAccounts
	gwClock  *clock.Fake
	mu       sync.Mutex
	saves    []session.Snapshot
}

func newStack(t *testing.T, mutate func(*Config)) *stack {
	t.Helper()
	s := &stack{t: t, accounts: &fakeAccounts{tokens: map[string][2]int64{}}, gwClock: clock.NewFake(time.Time{})}
	var bal content.Balance
	bal.Movement = content.Movement{BaseStepMs: 1000, DiagonalCost: 1.5, MaxPathTiles: 100}
	w, err := session.New(session.Config{
		Map:     worldtest.Open(t, 0, 0, 32, 32),
		Balance: bal,
		Vocations: content.Vocations{"guardian": {ID: "guardian",
			Start: content.VocationStats{Health: 145, Mana: 20, Capacity: 1000, Speed: 1000}}},
		Save: func(snap session.Snapshot) bool {
			s.mu.Lock()
			s.saves = append(s.saves, snap)
			s.mu.Unlock()
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	mv, flush := w.Systems()
	loop, err := game.New(game.Config{Clock: clock.Real{}, Rand: rand.New(rand.NewPCG(1, 1)), Systems: []game.System{mv, flush}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	loopDone := make(chan struct{})
	go func() { _ = loop.Run(ctx); close(loopDone) }()
	cfg := Config{Accounts: s.accounts, Characters: fakeChars{}, Loop: loop, World: w, Clock: s.gwClock}
	if mutate != nil {
		mutate(&cfg)
	}
	gw, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s.gw = gw
	srv := httptest.NewServer(gw)
	s.url = "ws" + strings.TrimPrefix(srv.URL, "http")
	t.Cleanup(func() {
		sctx, scancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer scancel()
		_ = gw.Shutdown(sctx)
		srv.Close()
		cancel()
		<-loopDone
	})
	return s
}

func (s *stack) token(tok string, char int64) {
	s.accounts.mu.Lock()
	s.accounts.tokens[tok] = [2]int64{1, char}
	s.accounts.mu.Unlock()
}

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

func (s *stack) dial() *client {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, s.url, nil) //nolint:bodyclose // websocket.Dial closes the response body itself
	if err != nil {
		s.t.Fatal(err)
	}
	ws.SetReadLimit(1 << 20)
	s.t.Cleanup(func() { _ = ws.CloseNow() })
	return &client{t: s.t, ws: ws}
}

func (c *client) send(m *pb.ClientMessage) error {
	raw, err := proto.Marshal(m)
	if err != nil {
		c.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageBinary, raw)
}

func hello(tok, ver string) *pb.ClientMessage {
	return &pb.ClientMessage{Message: &pb.ClientMessage_Hello{Hello: &pb.Hello{SessionToken: tok, ClientVersion: ver, Locale: "es"}}}
}

// next reads the next batch; ok is false when the connection closed.
func (c *client) next() (*pb.ServerBatch, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, raw, err := c.ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	var b pb.ServerBatch
	if err := proto.Unmarshal(raw, &b); err != nil {
		c.t.Fatal(err)
	}
	return &b, nil
}

// until reads batches until an event satisfies match, failing on close or timeout.
func (c *client) until(what string, match func(*pb.ServerMessage) bool) *pb.ServerMessage {
	c.t.Helper()
	for {
		b, err := c.next()
		if err != nil {
			c.t.Fatalf("waiting for %s: %v", what, err)
		}
		for _, e := range b.GetEvents() {
			if match(e) {
				return e
			}
		}
	}
}

// disconnect reads until the server's Disconnect and then the close.
func (c *client) disconnect() pb.DisconnectReason {
	c.t.Helper()
	e := c.until("disconnect", func(e *pb.ServerMessage) bool { return e.GetDisconnect() != nil })
	for {
		if _, err := c.next(); err != nil {
			return e.GetDisconnect().GetReason()
		}
	}
}

func (s *stack) login(tok string, char int64) *client {
	s.t.Helper()
	s.token(tok, char)
	c := s.dial()
	if err := c.send(hello(tok, "0.1.0")); err != nil {
		s.t.Fatal(err)
	}
	c.until("welcome", func(e *pb.ServerMessage) bool { return e.GetWelcome() != nil })
	return c
}

func TestHandshakeAndWalk(t *testing.T) {
	s := newStack(t, nil)
	s.token("tok", 7)
	c := s.dial()
	if err := c.send(hello("tok", "0.2.0-dev")); err != nil {
		t.Fatal(err)
	}
	b, err := c.next()
	if err != nil {
		t.Fatal(err)
	}
	evs := b.GetEvents()
	if len(evs) != 5 || evs[0].GetWelcome() == nil || evs[1].GetFullMapView() == nil || evs[2].GetPlayerStats() == nil {
		t.Fatalf("first batch %v", b)
	}
	id := evs[0].GetWelcome().GetCreatureId()
	if err := c.send(&pb.ClientMessage{Message: &pb.ClientMessage_Walk{Walk: &pb.Walk{Dir: pb.Direction_DIRECTION_EAST}}}); err != nil {
		t.Fatal(err)
	}
	mv := c.until("move", func(e *pb.ServerMessage) bool { return e.GetCreatureMove() != nil }).GetCreatureMove()
	if mv.GetId() != id || mv.GetTo().GetX() != mv.GetFrom().GetX()+1 {
		t.Fatalf("move %v", mv)
	}
	if err := c.send(&pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: 99}}}); err != nil {
		t.Fatal(err)
	}
	if p := c.until("pong", func(e *pb.ServerMessage) bool { return e.GetPong() != nil }); p.GetPong().GetClientTime() != 99 {
		t.Fatalf("pong %v", p)
	}
	if err := c.send(&pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}}); err != nil {
		t.Fatal(err)
	}
	if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT {
		t.Fatalf("reason %v", r)
	}
	waitFor(t, func() bool { return s.gw.Connections() == 0 })
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.saves) != 1 || !s.saves[0].Final || s.saves[0].CharacterID != 7 {
		t.Fatalf("saves %+v", s.saves)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := wall.Now().Add(5 * time.Second)
	for !cond() {
		if wall.Now().After(deadline) {
			t.Fatal("condition not met in 5 s")
		}
		<-wall.After(5 * time.Millisecond)
	}
}

func TestHandshakeRefusals(t *testing.T) {
	s := newStack(t, nil)
	s.token("good", 7)
	s.token("gone", 404)
	cases := []struct {
		name string
		msg  *pb.ClientMessage
		want pb.DisconnectReason
	}{
		{"not a hello", &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{}}}, pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION},
		{"unknown token", hello("nope", "0.1.0"), pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION},
		{"older client", hello("good", "0.0.9"), pb.DisconnectReason_DISCONNECT_REASON_OUTDATED_CLIENT},
		{"other major", hello("good", "1.0.0"), pb.DisconnectReason_DISCONNECT_REASON_OUTDATED_CLIENT},
		{"no version", hello("good", ""), pb.DisconnectReason_DISCONNECT_REASON_OUTDATED_CLIENT},
		{"character gone", hello("gone", "0.1.0"), pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION},
	}
	for _, c := range cases {
		cl := s.dial()
		if err := cl.send(c.msg); err != nil {
			t.Fatal(err)
		}
		if r := cl.disconnect(); r != c.want {
			t.Errorf("%s: reason %v, want %v", c.name, r, c.want)
		}
	}
	// The good token was not spent by the refused version checks.
	s.login("good", 7)
}

func TestOversizedMessageCloses(t *testing.T) {
	s := newStack(t, nil)
	c := s.login("tok", 7)
	big := &pb.ClientMessage{Message: &pb.ClientMessage_Say{Say: &pb.Say{Text: strings.Repeat("x", MaxMessageBytes)}}}
	_ = c.send(big)
	for {
		if _, err := c.next(); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
				t.Fatalf("close %v", err)
			}
			break
		}
	}
	waitFor(t, func() bool { return s.gw.Connections() == 0 })
}

func TestRateLimitDisconnects(t *testing.T) {
	// The gateway's fake clock never moves: no refill, so the 60-token burst plus 30 of
	// debt are spent by message 91, whatever the timing.
	s := newStack(t, nil)
	c := s.login("tok", 7)
	ping := &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: 1}}}
	pongs := 0
	go func() {
		for range 200 {
			if c.send(ping) != nil {
				return
			}
		}
	}()
	var reason pb.DisconnectReason
	for {
		b, err := c.next()
		if err != nil {
			break
		}
		for _, e := range b.GetEvents() {
			if e.GetPong() != nil {
				pongs++
			}
			if d := e.GetDisconnect(); d != nil {
				reason = d.GetReason()
			}
		}
	}
	if reason != pb.DisconnectReason_DISCONNECT_REASON_RATE_LIMITED || pongs > 60 {
		t.Fatalf("reason %v after %d pongs", reason, pongs)
	}
}

func TestLoginElsewhereAndShutdown(t *testing.T) {
	s := newStack(t, nil)
	first := s.login("a", 7)
	second := s.login("b", 7)
	if r := first.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_LOGGED_IN_ELSEWHERE {
		t.Fatalf("first: %v", r)
	}
	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		done <- s.gw.Shutdown(ctx)
	}()
	if r := second.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_SERVER_SHUTDOWN {
		t.Fatalf("second: %v", r)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// After shutdown new connections are turned away.
	c := s.dial()
	if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_SERVER_SHUTDOWN {
		t.Fatalf("late: %v", r)
	}
}

func TestHelloTimeout(t *testing.T) {
	s := newStack(t, func(c *Config) { c.HelloWait = 50 * time.Millisecond })
	c := s.dial()
	if _, err := c.next(); err == nil {
		t.Fatal("connection without Hello stayed open")
	}
}

func TestSendNeverBlocks(t *testing.T) {
	c := &conn{out: make(chan *pb.ServerBatch, 1), closing: make(chan struct{})}
	if !c.Send(&pb.ServerBatch{}) || c.Send(&pb.ServerBatch{}) {
		t.Fatal("Send must fail when the queue is full")
	}
	c.Close(pb.DisconnectReason_DISCONNECT_REASON_SLOW_CLIENT)
	c.Close(pb.DisconnectReason_DISCONNECT_REASON_KICKED) // second call ignored
	if c.reason != pb.DisconnectReason_DISCONNECT_REASON_SLOW_CLIENT {
		t.Fatal("first Close must win")
	}
}

func TestLimiter(t *testing.T) {
	t0 := time.Unix(0, 0)
	l := newLimiter(DefaultRateLimit, t0)
	var got [3]int
	for range 100 {
		got[l.take(t0)]++
	}
	if got[allow] != 60 || got[drop] != 30 || got[abuse] != 10 {
		t.Fatalf("burst verdicts %v", got)
	}
	// 30 msg/s sustained is always allowed once the bucket refilled.
	l = newLimiter(DefaultRateLimit, t0)
	now := t0
	for i := range 3000 {
		now = now.Add(time.Second / 30)
		if v := l.take(now); v != allow {
			t.Fatalf("message %d at 30/s: %v", i, v)
		}
	}
	// 40 msg/s: allowed for a while, then dropped, then disconnected (sustained excess).
	l = newLimiter(DefaultRateLimit, t0)
	now = t0
	var first [3]time.Duration
	for range 10000 {
		now = now.Add(time.Second / 40)
		v := l.take(now)
		if first[v] == 0 {
			first[v] = now.Sub(t0)
		}
		if v == abuse {
			break
		}
	}
	if first[drop] < 5*time.Second || first[abuse] < 8*time.Second || first[abuse] > 10*time.Second {
		t.Fatalf("40/s: first drop %v, disconnect %v", first[drop], first[abuse])
	}
}

func TestVersions(t *testing.T) {
	min, _ := parseVersion("0.1.0")
	for v, want := range map[string]bool{
		"0.1.0": true, "0.1.5": true, "0.2.0": true, "0.10.0": true, "0.1.0-dev": true, "0.1.0+abc": true,
		"0.0.9": false, "1.0.0": false, "": false, "0.1": false, "a.b.c": false, "0.01.0": false, "0.1.0.0": false, "-1.0.0": false,
	} {
		p, ok := parseVersion(v)
		if got := ok && p.compatible(min); got != want {
			t.Errorf("%q: %v, want %v", v, got, want)
		}
	}
	if _, err := New(Config{MinClientVersion: "x"}); err == nil {
		t.Fatal("nil deps accepted")
	}
}

var _ = errors.New
var wall clock.Clock = clock.Real{}
