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
	Chat      int // chat messages received
	Dialogs   int // DialogOpen received
	Pongs     int
}

// CreatureKind tells players, monsters and NPCs apart.
type CreatureKind int

// Creature kinds.
const (
	KindUnknown CreatureKind = iota
	KindPlayer
	KindMonster
	KindNPC
)

// Creature is a creature the bot knows (it is in the bot's view).
type Creature struct {
	ID        uint32
	Kind      CreatureKind
	ContentID string
	Pos       Pos
}

// Dialog is the NPC dialog the bot has open.
type Dialog struct {
	ID      uint32
	NPC     uint32
	Options []uint32
}

// Presence is a presence check waiting for an answer (T4.1): the question's key and the
// key of each option, by option id.
type Presence struct {
	ID       uint32
	Question string
	Options  map[uint32]string
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
	creatures  map[uint32]*Creature
	dialog     *Dialog
	presence   *Presence
	pingSeq    uint64
	pings      map[uint64]time.Time
	latencies  []time.Duration
}

// New returns a bot for the server at baseURL (e.g. "http://localhost:8080").
func New(baseURL string) *Bot {
	return &Bot{
		base:      strings.TrimSuffix(baseURL, "/"),
		http:      &http.Client{Timeout: 10 * time.Second},
		clock:     clock.Real{},
		changed:   make(chan struct{}),
		done:      make(chan struct{}),
		creatures: map[uint32]*Creature{},
		pings:     map[uint64]time.Time{},
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
		clear(b.creatures)
		for _, c := range m.FullMapView.GetArea().GetCreatures() {
			b.see(c)
			if c.GetId() == b.creatureID {
				b.pos = toPos(c.GetPos())
			}
		}
	case *pb.ServerMessage_CreatureMove:
		if c := b.creatures[m.CreatureMove.GetId()]; c != nil {
			c.Pos = toPos(m.CreatureMove.GetTo())
		}
		if m.CreatureMove.GetId() == b.creatureID {
			b.pos = toPos(m.CreatureMove.GetTo())
			b.stats.Moves++
		}
	case *pb.ServerMessage_WalkRejected:
		b.pos = toPos(m.WalkRejected.GetPos())
		b.stats.Rejected++
	case *pb.ServerMessage_CreatureAppear:
		b.see(m.CreatureAppear.GetCreature())
		b.stats.Appear++
	case *pb.ServerMessage_CreatureDisappear:
		delete(b.creatures, m.CreatureDisappear.GetId())
		b.stats.Disappear++
	case *pb.ServerMessage_ChatMessage:
		b.stats.Chat++
	case *pb.ServerMessage_DialogOpen:
		d := &Dialog{ID: m.DialogOpen.GetDialogId(), NPC: m.DialogOpen.GetNpcCreatureId()}
		for _, o := range m.DialogOpen.GetOptions() {
			d.Options = append(d.Options, o.GetOptionId())
		}
		b.dialog = d
		b.stats.Dialogs++
	case *pb.ServerMessage_PresenceCheck:
		c := m.PresenceCheck
		pr := &Presence{ID: c.GetCheckId(), Question: c.GetQuestion().GetKey(), Options: map[uint32]string{}}
		for _, o := range c.GetOptions() {
			pr.Options[o.GetOptionId()] = o.GetText().GetKey()
		}
		b.presence = pr
	case *pb.ServerMessage_DialogClose:
		if b.dialog != nil && b.dialog.ID == m.DialogClose.GetDialogId() {
			b.dialog = nil
		}
	case *pb.ServerMessage_Pong:
		if sent, ok := b.pings[m.Pong.GetClientTime()]; ok {
			delete(b.pings, m.Pong.GetClientTime())
			b.latencies = append(b.latencies, b.clock.Now().Sub(sent))
			b.stats.Pongs++
		}
	case *pb.ServerMessage_MapSlice:
		b.stats.Slices++
	case *pb.ServerMessage_Disconnect:
		b.disconnect = strings.TrimPrefix(m.Disconnect.GetReason().String(), "DISCONNECT_REASON_")
	}
}

func (b *Bot) see(c *pb.Creature) {
	if c == nil {
		return
	}
	b.creatures[c.GetId()] = &Creature{
		ID: c.GetId(), Kind: CreatureKind(c.GetKind()), ContentID: c.GetContentId(), Pos: toPos(c.GetPos()),
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

// Creatures returns the creatures the bot sees (itself excluded) of the given kind.
func (b *Bot) Creatures(kind CreatureKind) []Creature {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []Creature
	for _, c := range b.creatures {
		if c.Kind == kind && c.ID != b.creatureID {
			out = append(out, *c)
		}
	}
	return out
}

// Sees reports whether the creature id is in the bot's view.
func (b *Bot) Sees(id uint32) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.creatures[id]
	return ok
}

// Dialog returns the open NPC dialog, or nil.
func (b *Bot) Dialog() *Dialog {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.dialog == nil {
		return nil
	}
	d := *b.dialog
	d.Options = append([]uint32(nil), d.Options...)
	return &d
}

// TakeLatencies returns the Ping round trips measured since the last call and forgets
// them. A round trip is the command latency of the server (received, run on the next
// tick, sent in that tick's batch) plus the network.
func (b *Bot) TakeLatencies() []time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.latencies
	b.latencies = nil
	return out
}

// Ping sends a Ping; its Pong adds a latency sample (TakeLatencies).
func (b *Bot) Ping(ctx context.Context) error {
	b.mu.Lock()
	b.pingSeq++
	seq := b.pingSeq
	b.pings[seq] = b.clock.Now()
	if len(b.pings) > 64 { // lost pongs (the connection is going away): forget the oldest
		for k := range b.pings {
			if k < seq-32 {
				delete(b.pings, k)
			}
		}
	}
	b.mu.Unlock()
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: seq}}})
}

// SetFightMode sets a balanced stance and whether the player chases its target.
func (b *Bot) SetFightMode(ctx context.Context, chase bool) error {
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_SetFightMode{SetFightMode: &pb.SetFightMode{
		Stance: pb.FightStance_FIGHT_STANCE_BALANCED, Chase: chase,
	}}})
}

// SetTarget selects the creature to attack (0 clears the target).
func (b *Bot) SetTarget(ctx context.Context, id uint32) error {
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_SetTarget{SetTarget: &pb.SetTarget{CreatureId: id}}})
}

// Say speaks on the local (say) channel.
func (b *Bot) Say(ctx context.Context, text string) error {
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_Say{Say: &pb.Say{Channel: pb.ChatChannel_CHAT_CHANNEL_SAY, Text: text}}})
}

// TalkTo asks an NPC for its dialog (DialogOpen arrives if it is close enough).
func (b *Bot) TalkTo(ctx context.Context, npc uint32) error {
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_NpcTalk{NpcTalk: &pb.NpcTalk{CreatureId: npc}}})
}

// Choose picks an option of the open dialog (0 closes it).
func (b *Bot) Choose(ctx context.Context, dialogID, option uint32) error {
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_DialogChoose{DialogChoose: &pb.DialogChoose{DialogId: dialogID, OptionId: option}}})
}

// TakePresence returns the presence check waiting for an answer and forgets it, or nil.
func (b *Bot) TakePresence() *Presence {
	b.mu.Lock()
	defer b.mu.Unlock()
	pr := b.presence
	b.presence = nil
	return pr
}

// AnswerPresence answers presence check id with option.
func (b *Bot) AnswerPresence(ctx context.Context, id, option uint32) error {
	return b.send(ctx, &pb.ClientMessage{Message: &pb.ClientMessage_PresenceAnswer{PresenceAnswer: &pb.PresenceAnswer{CheckId: id, OptionId: option}}})
}

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
