package bot

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// Logout in a fight (docs/02 "Bloqueo de logout en combate"): the server refuses it with a
// system message and keeps the connection; Bot.Logout asks again every LogoutRetry.

// answer is how fakeServer answers Logout number n (from 1): refuse (combat.logout_locked,
// the connection stays), accept (Disconnect LOGGED_OUT and close) or nothing.
type answer int

const (
	refuse answer = iota
	accept
	silent
)

// fakeServer is a game server that answers a Hello with a Welcome and each Logout as
// logout says. logouts counts the Logouts it read.
func fakeServer(t *testing.T, logouts *atomic.Int32, logout func(n int) answer) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = ws.CloseNow() }()
		ctx := r.Context()
		send := func(e *pb.ServerMessage) {
			raw, err := proto.Marshal(&pb.ServerBatch{Events: []*pb.ServerMessage{e}})
			if err == nil {
				_ = ws.Write(ctx, websocket.MessageBinary, raw)
			}
		}
		for {
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var m pb.ClientMessage
			if proto.Unmarshal(raw, &m) != nil {
				return
			}
			switch m.GetMessage().(type) {
			case *pb.ClientMessage_Hello:
				send(&pb.ServerMessage{Message: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{CreatureId: 7}}})
			case *pb.ClientMessage_Logout:
				switch logout(int(logouts.Add(1))) {
				case refuse:
					send(&pb.ServerMessage{Message: &pb.ServerMessage_ChatMessage{ChatMessage: &pb.Message{
						Kind: pb.MessageKind_MESSAGE_KIND_SYSTEM,
						Body: &pb.Message_Localized{Localized: &pb.LocalizedText{Key: "combat.logout_locked"}},
					}}})
				case accept:
					send(&pb.ServerMessage{Message: &pb.ServerMessage_Disconnect{Disconnect: &pb.Disconnect{
						Reason: pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT,
					}}})
					_ = ws.Close(websocket.StatusNormalClosure, "")
					return
				case silent:
				}
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// connected returns a bot connected to srv with a fake clock, closed at the test's end.
func connected(t *testing.T, ctx context.Context, srv *httptest.Server) (*Bot, *clock.Fake) {
	t.Helper()
	b := New(srv.URL)
	fc := clock.NewFake(time.Time{})
	b.clock = fc
	if err := b.Connect(ctx, "play-token"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	return b, fc
}

// refused waits until the bot heard n logout refusals.
func refused(t *testing.T, ctx context.Context, b *Bot, n int) {
	t.Helper()
	if err := b.Wait(ctx, func() bool { return b.refusals >= n }); err != nil {
		t.Fatal(err)
	}
}

// Refused twice (the bot fought a moment ago), Logout asks again each LogoutRetry and
// returns when the third one is accepted.
func TestLogoutAsksAgainWhileRefused(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var logouts atomic.Int32
	b, fc := connected(t, ctx, fakeServer(t, &logouts, func(n int) answer {
		if n <= 2 {
			return refuse
		}
		return accept
	}))
	done := make(chan error, 1)
	go func() { done <- b.Logout(ctx) }()
	for i := 1; i <= 2; i++ {
		refused(t, ctx, b, i)
		fc.BlockUntil(1) // Logout waits for LogoutRetry
		if n := logouts.Load(); n != int32(i) {
			t.Fatalf("asked %d times before the retry %d", n, i)
		}
		fc.Advance(LogoutRetry)
	}
	select {
	case err := <-done:
		if err != nil || logouts.Load() != 3 {
			t.Fatalf("logout: %v after %d requests", err, logouts.Load())
		}
	case <-ctx.Done():
		t.Fatal("Logout did not return after the accepted request")
	}
}

// A Logout whose ctx ends while the server still refuses it (a monster keeps attacking
// the bot) says so with ErrLogoutLocked: tools/bots leaves such a bot link-dead and counts
// no failure. One that heard nothing is a plain timeout.
func TestLogoutLockedUntilTheDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, a := range []answer{refuse, silent} {
		var logouts atomic.Int32
		read := make(chan struct{}, 8) // the clock never moves: one Logout
		b, _ := connected(t, ctx, fakeServer(t, &logouts, func(int) answer { read <- struct{}{}; return a }))
		lctx, lcancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { done <- b.Logout(lctx) }()
		select { // the server read the Logout (a silent one changes no bot state)
		case <-read:
		case <-ctx.Done():
			t.Fatal("the server never read the Logout")
		}
		if a == refuse {
			refused(t, ctx, b, 1)
		}
		lcancel()
		err := <-done
		if locked := errors.Is(err, ErrLogoutLocked); locked != (a == refuse) || !errors.Is(err, context.Canceled) {
			t.Fatalf("answer %d: logout error %v (locked %v)", a, err, locked)
		}
	}
}

// Ending Logout's ctx stops the asking but never drops the connection, also when it ends
// while the request is being written: coder/websocket closes a connection whose write ctx
// ends before the write returns. Here it ended before Logout, so every write sees it (the
// library takes the lock or not at random: 20 tries).
func TestLogoutEndedCtxKeepsTheConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for i := range 20 {
		var logouts atomic.Int32
		b, _ := connected(t, ctx, fakeServer(t, &logouts, func(n int) answer {
			if n == 1 {
				return silent
			}
			return accept
		}))
		ended, end := context.WithCancel(ctx)
		end()
		if err := b.Logout(ended); !errors.Is(err, context.Canceled) || errors.Is(err, ErrLogoutLocked) {
			t.Fatalf("try %d: logout with an ended ctx: %v", i, err)
		}
		if err := b.Logout(ctx); err != nil { // the same connection still logs out
			t.Fatalf("try %d: the connection did not survive: %v", i, err)
		}
	}
}
