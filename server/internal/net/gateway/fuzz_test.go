package gateway

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// FuzzClientFrame (lote 16) sends one arbitrary frame after a good handshake, through the
// real gateway (decode, rate limit, enqueue) and session dispatch, then a Ping. A frame
// the gateway cannot take (a text frame, bytes that are not a ClientMessage, one with no
// oneof set) must end the connection with KICKED; any other must be handled or ignored
// and the connection must still answer the Ping (a Logout ends it as LOGGED_OUT). The
// server must not crash either way.
//
// The seeds (f.Add plus testdata/fuzz/FuzzClientFrame) run in make test; make fuzz
// mutates them (docs/08). Every input starts its own stack, so this target is slow to
// fuzz: session.FuzzInputDispatch covers the dispatch in depth.
func FuzzClientFrame(f *testing.F) {
	seeds := []*pb.ClientMessage{
		{Message: &pb.ClientMessage_Walk{Walk: &pb.Walk{Dir: pb.Direction_DIRECTION_EAST}}},
		{Message: &pb.ClientMessage_Walk{Walk: &pb.Walk{Dir: pb.Direction(1 << 30)}}},
		{Message: &pb.ClientMessage_Say{Say: &pb.Say{Text: "hola"}}},
		{Message: &pb.ClientMessage_Hello{Hello: &pb.Hello{SessionToken: "again", ClientVersion: "0.1.0"}}},
		{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}},
		{Message: &pb.ClientMessage_SetTarget{SetTarget: &pb.SetTarget{CreatureId: 1}}},
		{}, // no oneof: KICKED
	}
	for _, m := range seeds {
		raw, err := proto.Marshal(m)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(raw, false)
	}
	f.Add([]byte{0xff, 0xff, 0xff}, false)       // not protobuf
	f.Add([]byte("\x12\x00"), true)              // a text frame
	f.Add([]byte{0x0a, 0x80, 0x80, 0x80}, false) // truncated length prefix
	f.Fuzz(func(t *testing.T, raw []byte, text bool) {
		if len(raw) > MaxMessageBytes {
			t.Skip("over the read limit: TestOversizedMessageCloses")
		}
		msg := &pb.ClientMessage{}
		valid := !text && proto.Unmarshal(raw, msg) == nil && msg.GetMessage() != nil
		s := newStack(t, nil)
		c := s.login("fuzz", 7)
		typ := websocket.MessageBinary
		if text {
			typ = websocket.MessageText
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := c.ws.Write(ctx, typ, raw); err != nil {
			t.Fatal(err)
		}
		if !valid {
			if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_KICKED {
				t.Fatalf("frame %x (text %v): reason %v, want KICKED", raw, text, r)
			}
			return
		}
		if msg.GetLogout() != nil {
			if r := c.disconnect(); r != pb.DisconnectReason_DISCONNECT_REASON_LOGGED_OUT {
				t.Fatalf("logout: reason %v", r)
			}
			return
		}
		if err := c.send(&pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: 4242}}}); err != nil {
			t.Fatal(err)
		}
		c.until("pong", func(e *pb.ServerMessage) bool {
			if d := e.GetDisconnect(); d != nil {
				t.Fatalf("message %v: disconnected with %v", msg, d.GetReason())
			}
			return e.GetPong().GetClientTime() == 4242
		})
	})
}
