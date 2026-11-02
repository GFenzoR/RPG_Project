// Package bot is a headless game client for integration tests and load tests
// (tools/bots): it registers an account, creates a character, logs in through
// POST /api/play and the WebSocket Hello, and walks.
//
// It lives outside internal/ so that tools/bots (another module) can import it; its API
// does not expose the generated protocol types.
package bot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
)

// ClientVersion is the version the bot sends in Hello.
const ClientVersion = "0.1.0"

// Direction is a walking direction, clockwise from north.
type Direction int

// Directions.
const (
	North Direction = iota
	NorthEast
	East
	SouthEast
	South
	SouthWest
	West
	NorthWest
)

// Delta returns the x and y offsets of one step.
func (d Direction) Delta() (dx, dy int) {
	return [8]int{0, 1, 1, 1, 0, -1, -1, -1}[d&7], [8]int{-1, -1, 0, 1, 1, 1, 0, -1}[d&7]
}

func (d Direction) msg() pb.Direction { return pb.Direction(d&7) + 1 }

// Pos is a tile position.
type Pos struct{ X, Y, Z int }

// Stats counts what a bot received.
type Stats struct {
	Batches   int
	Bytes     int
	Moves     int // own confirmed steps
	Rejected  int // WalkRejected
	Appear    int
	Disappear int
	Slices    int
}

// Bot is one connected player. Its methods are safe for concurrent use.
type Bot struct {
	base  string
	http  *http.Client
	clock clock.Clock
	ws    *websocket.Conn

	mu         sync.Mutex
	creatureID uint32
	pos        Pos
	stats      Stats
	disconnect string
	changed    chan struct{} // closed and replaced on every received batch
	done       chan struct{} // closed when the reader stops
	readErr    error
}

// New returns a bot for the server at baseURL (e.g. "http://localhost:8080").
func New(baseURL string) *Bot {
	return &Bot{
		base:    strings.TrimSuffix(baseURL, "/"),
		http:    &http.Client{Timeout: 10 * time.Second},
		clock:   clock.Real{},
		changed: make(chan struct{}),
		done:    make(chan struct{}),
	}
}

// APIError is a non-2xx answer of the HTTP API.
type APIError struct {
	Status int
	Code   string
	// RetryAfter is the Retry-After of a 429, in seconds.
	RetryAfter int
}

func (e *APIError) Error() string { return fmt.Sprintf("api: %d %s", e.Status, e.Code) }

func (b *Bot) call(ctx context.Context, method, path, token string, in, out any) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("encode %s: %w", path, err)
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, b.base+path, body)
	if err != nil {
		return fmt.Errorf("request %s: %w", path, err)
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := b.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		var e struct {
			Error struct{ Code string } `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		retry, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		return &APIError{Status: resp.StatusCode, Code: e.Error.Code, RetryAfter: retry}
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("decode %s: %w", path, err)
		}
	}
	return nil
}

// Account is what Enter needs to get a character in the world.
type Account struct {
	Email, Password string
	// Character is the name to play; it is created with Vocation if missing.
	Character, Vocation string
}

// Enter logs in (registering the account if new) and plays acc.Character.
func (b *Bot) Enter(ctx context.Context, acc Account) error {
	token, err := b.Login(ctx, acc.Email, acc.Password)
	if err != nil {
		return err
	}
	return b.Play(ctx, token, acc.Character, acc.Vocation)
}

// Login registers the account if it does not exist and returns an account token. A
// 429 (the per-IP login limit; many bots share one address) is retried after its
// Retry-After until ctx is done.
func (b *Bot) Login(ctx context.Context, email, password string) (string, error) {
	creds := map[string]any{"email": email, "password": password}
	var apiErr *APIError
	err := b.retry(ctx, func() error { return b.call(ctx, "POST", "/api/auth/register", "", creds, nil) })
	if err != nil && (!errors.As(err, &apiErr) || apiErr.Code != "email_taken") {
		return "", err
	}
	var login struct{ Token string }
	creds["token_in_body"] = true
	if err := b.retry(ctx, func() error { return b.call(ctx, "POST", "/api/auth/login", "", creds, &login) }); err != nil {
		return "", err
	}
	return login.Token, nil
}

func (b *Bot) retry(ctx context.Context, fn func() error) error {
	for {
		err := fn()
		var apiErr *APIError
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w (gave up: %w)", err, ctx.Err())
		case <-b.clock.After(time.Duration(max(apiErr.RetryAfter, 1)) * time.Second):
		}
	}
}

// Play creates the character on the account if missing, gets a play token
// (POST /api/play) and opens the WebSocket.
func (b *Bot) Play(ctx context.Context, accountToken, character, vocation string) error {
	var list struct {
		Characters []struct {
			ID   int64
			Name string
		}
	}
	if err := b.call(ctx, "GET", "/api/characters", accountToken, nil, &list); err != nil {
		return err
	}
	var charID int64
	for _, c := range list.Characters {
		if c.Name == character {
			charID = c.ID
		}
	}
	if charID == 0 {
		var created struct{ Character struct{ ID int64 } }
		if err := b.call(ctx, "POST", "/api/characters", accountToken, map[string]string{"name": character, "vocation": vocation}, &created); err != nil {
			return err
		}
		charID = created.Character.ID
	}
	var play struct {
		SessionToken string `json:"session_token"`
	}
	if err := b.call(ctx, "POST", "/api/play", accountToken, map[string]int64{"character_id": charID}, &play); err != nil {
		return err
	}
	return b.Connect(ctx, play.SessionToken)
}

// Connect opens the WebSocket with a play token and waits for Welcome.
func (b *Bot) Connect(ctx context.Context, playToken string) error {
	wsURL := "ws" + strings.TrimPrefix(b.base, "http") + "/ws"
	ws, _, err := websocket.Dial(ctx, wsURL, nil) //nolint:bodyclose // websocket.Dial closes the response body itself
	if err != nil {
		return fmt.Errorf("dial %s: %w", wsURL, err)
	}
	ws.SetReadLimit(1 << 20)
	b.ws = ws
	if err := b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_Hello{Hello: &pb.Hello{
		SessionToken: playToken, ClientVersion: ClientVersion, Locale: "en",
	}}}); err != nil {
		return err
	}
	go b.read()
	return b.Wait(ctx, func() bool { return b.creatureID != 0 })
}

func (b *Bot) send(ctx context.Context, m *pb.ClientMessage) error {
	raw, err := proto.Marshal(m)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	if err := b.ws.Write(ctx, websocket.MessageBinary, raw); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	return nil
}

func (b *Bot) read() {
	defer close(b.done)
	for {
		_, raw, err := b.ws.Read(context.Background())
		if err != nil {
			b.mu.Lock()
			b.readErr = err
			b.notify()
			b.mu.Unlock()
			return
		}
		var batch pb.ServerBatch
		if err := proto.Unmarshal(raw, &batch); err != nil {
			_ = b.ws.CloseNow()
			continue
		}
		b.mu.Lock()
		b.stats.Batches++
		b.stats.Bytes += len(raw)
		for _, e := range batch.GetEvents() {
			b.apply(e)
		}
		b.notify()
		b.mu.Unlock()
	}
}

func (b *Bot) notify() {
	close(b.changed)
	b.changed = make(chan struct{})
}

func toPos(p *pb.Position) Pos { return Pos{X: int(p.GetX()), Y: int(p.GetY()), Z: int(p.GetZ())} }

func (b *Bot) apply(e *pb.ServerMessage) {
	switch m := e.GetMessage().(type) {
	case *pb.ServerMessage_Welcome:
		b.creatureID = m.Welcome.GetCreatureId()
	case *pb.ServerMessage_FullMapView:
		for _, c := range m.FullMapView.GetArea().GetCreatures() {
			if c.GetId() == b.creatureID {
				b.pos = toPos(c.GetPos())
			}
		}
	case *pb.ServerMessage_CreatureMove:
		if m.CreatureMove.GetId() == b.creatureID {
			b.pos = toPos(m.CreatureMove.GetTo())
			b.stats.Moves++
		}
	case *pb.ServerMessage_WalkRejected:
		b.pos = toPos(m.WalkRejected.GetPos())
		b.stats.Rejected++
	case *pb.ServerMessage_CreatureAppear:
		b.stats.Appear++
	case *pb.ServerMessage_CreatureDisappear:
		b.stats.Disappear++
	case *pb.ServerMessage_MapSlice:
		b.stats.Slices++
	case *pb.ServerMessage_Disconnect:
		b.disconnect = strings.TrimPrefix(m.Disconnect.GetReason().String(), "DISCONNECT_REASON_")
	}
}

// Wait blocks until cond (called with the bot's state locked) holds, the connection
// closes or ctx is done.
func (b *Bot) Wait(ctx context.Context, cond func() bool) error {
	for {
		b.mu.Lock()
		ok, err, ch := cond(), b.readErr, b.changed
		b.mu.Unlock()
		if ok {
			return nil
		}
		if err != nil {
			return fmt.Errorf("connection closed (%s): %w", b.Disconnected(), err)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("bot wait: %w", ctx.Err())
		case <-ch:
		}
	}
}

// WaitMoves waits until the bot has n confirmed steps in total.
func (b *Bot) WaitMoves(ctx context.Context, n int) error {
	return b.Wait(ctx, func() bool { return b.stats.Moves >= n })
}

// CreatureID returns the bot's creature id (0 before Welcome).
func (b *Bot) CreatureID() uint32 { b.mu.Lock(); defer b.mu.Unlock(); return b.creatureID }

// Pos returns the bot's last known position.
func (b *Bot) Pos() Pos { b.mu.Lock(); defer b.mu.Unlock(); return b.pos }

// Stats returns a copy of the counters.
func (b *Bot) Stats() Stats { b.mu.Lock(); defer b.mu.Unlock(); return b.stats }

// Disconnected returns the Disconnect reason the server sent ("" if none), e.g. "LOGGED_OUT".
func (b *Bot) Disconnected() string { b.mu.Lock(); defer b.mu.Unlock(); return b.disconnect }

// Walk asks for one step.
func (b *Bot) Walk(ctx context.Context, d Direction) error {
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_Walk{Walk: &pb.Walk{Dir: d.msg()}}})
}

// WalkPath asks for a sequence of steps (at most 100).
func (b *Bot) WalkPath(ctx context.Context, steps []Direction) error {
	ds := make([]pb.Direction, len(steps))
	for i, s := range steps {
		ds[i] = s.msg()
	}
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_WalkPath{WalkPath: &pb.WalkPath{Steps: ds}}})
}

// Logout asks to leave and waits until the server closes the connection.
func (b *Bot) Logout(ctx context.Context) error {
	if err := b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_Logout{Logout: &pb.Logout{}}}); err != nil {
		return err
	}
	select {
	case <-b.done:
	case <-ctx.Done():
		return fmt.Errorf("logout: %w", ctx.Err())
	}
	if r := b.Disconnected(); r != "LOGGED_OUT" {
		return fmt.Errorf("logout: disconnected with %q", r)
	}
	return nil
}

// Done is closed when the connection has closed.
func (b *Bot) Done() <-chan struct{} { return b.done }

// Close drops the connection without logging out.
func (b *Bot) Close() {
	if b.ws != nil {
		_ = b.ws.CloseNow()
	}
}
