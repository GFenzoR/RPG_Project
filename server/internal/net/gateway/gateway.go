// Package gateway is the WebSocket gateway at /ws (docs/05-network-protocol.md): the
// Hello handshake, one reader and one writer goroutine per connection, the per-connection
// rate limit and the bounded outgoing queue.
//
// Network goroutines never touch game state: the reader decodes and checks each
// ClientMessage and enqueues the command built by session.World; the writer serializes
// the ServerBatch values the loop hands over through session.Client.Send.
package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/game"
	pb "github.com/GFenzoR/RPG_Project/server/internal/net/pb/game/v1"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/world"
)

// Defaults for Config.
const (
	// DefaultMinClientVersion is the oldest client version the server accepts.
	DefaultMinClientVersion = "0.1.0"
	// MaxMessageBytes is the largest client frame (docs/05: 4 KB).
	MaxMessageBytes  = 4096
	DefaultHelloWait = 10 * time.Second
	// DefaultOutQueue bounds the batches waiting for a connection: 128 ticks ≈ 6.4 s.
	DefaultOutQueue     = 128
	DefaultWriteTimeout = 10 * time.Second
	// dbTimeout bounds each database call of the handshake.
	dbTimeout = 5 * time.Second
)

// Accounts redeems play tokens. *auth.Service implements it.
type Accounts interface {
	RedeemPlayToken(ctx context.Context, token string) (accountID, characterID int64, err error)
}

// Characters loads characters to play. *store.Store implements it.
type Characters interface {
	PlayCharacter(ctx context.Context, accountID, id int64, now time.Time) (store.PlayCharacter, error)
}

// Loop is where commands go. *game.Loop implements it.
type Loop interface {
	Enqueue(cmd game.Command) error
}

// Config configures a Gateway.
type Config struct {
	Accounts   Accounts
	Characters Characters
	Loop       Loop
	// World builds the commands. Its Join, Input and Leave only capture their
	// arguments, so calling them from network goroutines is safe.
	World  *session.World
	Clock  clock.Clock
	Logger *slog.Logger
	// MinClientVersion (MAJOR.MINOR.PATCH): Hello.client_version must have the same
	// major version and not be older. Default DefaultMinClientVersion.
	MinClientVersion string
	// OriginPatterns lists the browser origins allowed besides the server's own host
	// (e.g. "localhost:5173" for the Vite dev server, "tauri.localhost").
	OriginPatterns []string
	RateLimit      RateLimit     // default DefaultRateLimit
	HelloWait      time.Duration // default DefaultHelloWait
	OutQueue       int           // default DefaultOutQueue
	WriteTimeout   time.Duration // default DefaultWriteTimeout
	// Metrics, if set, counts the connections and the bytes sent (internal/metrics).
	Metrics Observer
}

// Observer receives network metrics. Its methods are called from connection goroutines.
type Observer interface {
	Sent(bytes int)
	ConnOpened()
	ConnClosed()
}

// Gateway serves /ws.
type Gateway struct {
	cfg    Config
	minVer version
	log    *slog.Logger

	mu       sync.Mutex
	conns    map[*conn]struct{}
	stopping bool
	wg       sync.WaitGroup
	stopCh   chan struct{}
}

// New validates cfg and builds a Gateway.
func New(cfg Config) (*Gateway, error) {
	if cfg.Accounts == nil || cfg.Characters == nil || cfg.Loop == nil || cfg.World == nil || cfg.Clock == nil {
		return nil, errors.New("gateway: Accounts, Characters, Loop, World and Clock are required")
	}
	if cfg.MinClientVersion == "" {
		cfg.MinClientVersion = DefaultMinClientVersion
	}
	minVer, ok := parseVersion(cfg.MinClientVersion)
	if !ok {
		return nil, fmt.Errorf("gateway: invalid MinClientVersion %q", cfg.MinClientVersion)
	}
	if cfg.RateLimit.PerSecond <= 0 || cfg.RateLimit.Burst <= 0 {
		cfg.RateLimit = DefaultRateLimit
	}
	if cfg.HelloWait <= 0 {
		cfg.HelloWait = DefaultHelloWait
	}
	if cfg.OutQueue <= 0 {
		cfg.OutQueue = DefaultOutQueue
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = DefaultWriteTimeout
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	return &Gateway{cfg: cfg, minVer: minVer, log: cfg.Logger, conns: map[*conn]struct{}{}, stopCh: make(chan struct{})}, nil
}

// Connections returns how many connections are open.
func (g *Gateway) Connections() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.conns)
}

// Shutdown closes every connection with SERVER_SHUTDOWN and waits until their
// goroutines end or ctx is done. New connections are refused from then on. Call it
// after the game loop stopped (and its final saves were taken).
func (g *Gateway) Shutdown(ctx context.Context) error {
	g.mu.Lock()
	if !g.stopping {
		g.stopping = true
		close(g.stopCh)
	}
	conns := make([]*conn, 0, len(g.conns))
	for c := range g.conns {
		conns = append(conns, c)
	}
	g.mu.Unlock()
	for _, c := range conns {
		c.Close(pb.DisconnectReason_DISCONNECT_REASON_SERVER_SHUTDOWN)
	}
	done := make(chan struct{})
	go func() { g.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		for _, c := range conns {
			_ = c.ws.CloseNow()
		}
		return fmt.Errorf("gateway shutdown: %w", ctx.Err())
	}
}

func (g *Gateway) track(c *conn) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopping {
		return false
	}
	g.conns[c] = struct{}{}
	g.wg.Add(1)
	if g.cfg.Metrics != nil {
		g.cfg.Metrics.ConnOpened()
	}
	return true
}

func (g *Gateway) untrack(c *conn) {
	g.mu.Lock()
	delete(g.conns, c)
	g.mu.Unlock()
	if g.cfg.Metrics != nil {
		g.cfg.Metrics.ConnClosed()
	}
	g.wg.Done()
}

// ServeHTTP upgrades the request and runs the connection until it closes.
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// http.Server's read and write timeouts would stay on the hijacked connection and
	// cut it after a few seconds; the gateway bounds reads and writes itself.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: g.cfg.OriginPatterns})
	if err != nil {
		return // Accept already answered the request
	}
	ws.SetReadLimit(MaxMessageBytes)
	c := &conn{
		g:       g,
		ws:      ws,
		out:     make(chan *pb.ServerBatch, g.cfg.OutQueue),
		closing: make(chan struct{}),
		done:    make(chan struct{}),
	}
	if !g.track(c) {
		// Not counted in the metrics on purpose: this connection was never tracked.
		_, _ = writeDisconnect(r.Context(), ws, pb.DisconnectReason_DISCONNECT_REASON_SERVER_SHUTDOWN, g.cfg.WriteTimeout)
		_ = ws.Close(websocket.StatusGoingAway, "")
		return
	}
	defer g.untrack(c)
	c.run(r.Context())
}

// ---- connection -------------------------------------------------------------------

type conn struct {
	g   *Gateway
	ws  *websocket.Conn
	out chan *pb.ServerBatch

	closeOnce sync.Mutex
	closed    bool
	reason    pb.DisconnectReason
	closing   chan struct{} // closed by Close: the writer drains and closes the socket
	done      chan struct{} // closed when the writer ended
}

// Send implements session.Client: non-blocking, false when the queue is full.
func (c *conn) Send(b *pb.ServerBatch) bool {
	select {
	case c.out <- b:
		return true
	default:
		return false
	}
}

// Close implements session.Client. The first call wins.
func (c *conn) Close(reason pb.DisconnectReason) {
	c.closeOnce.Lock()
	defer c.closeOnce.Unlock()
	if c.closed {
		return
	}
	c.closed, c.reason = true, reason
	close(c.closing)
}

func (c *conn) run(ctx context.Context) {
	g := c.g
	char, ok := c.handshake(ctx)
	if !ok {
		return
	}
	if err := g.cfg.Loop.Enqueue(g.cfg.World.Join(char, c)); err != nil {
		g.log.Warn("gateway: loop queue full, login refused", "character", char.ID)
		c.abortLogin(char.ID)
		_ = g.writeDisconnect(ctx, c.ws, pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED)
		_ = c.ws.Close(websocket.StatusTryAgainLater, "")
		return
	}
	go c.writer()
	c.reader(ctx, char.ID)
	c.leave()
	c.Close(pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED)
	<-c.done
}

// handshake reads the Hello and loads the character. On failure it has already told the
// client why and closed the socket.
func (c *conn) handshake(ctx context.Context) (session.Character, bool) {
	g := c.g
	refuse := func(reason pb.DisconnectReason) (session.Character, bool) {
		_ = g.writeDisconnect(ctx, c.ws, reason)
		_ = c.ws.Close(websocket.StatusPolicyViolation, "")
		return session.Character{}, false
	}
	hctx, cancel := context.WithTimeout(ctx, g.cfg.HelloWait)
	typ, data, err := c.ws.Read(hctx)
	cancel()
	if err != nil {
		_ = c.ws.CloseNow()
		return session.Character{}, false
	}
	var msg pb.ClientMessage
	if typ != websocket.MessageBinary || proto.Unmarshal(data, &msg) != nil || msg.GetHello() == nil {
		return refuse(pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION)
	}
	hello := msg.GetHello()
	if v, ok := parseVersion(hello.GetClientVersion()); !ok || !v.compatible(g.minVer) {
		return refuse(pb.DisconnectReason_DISCONNECT_REASON_OUTDATED_CLIENT)
	}
	rctx, rcancel := context.WithTimeout(ctx, dbTimeout)
	accountID, charID, err := g.cfg.Accounts.RedeemPlayToken(rctx, hello.GetSessionToken())
	rcancel()
	if errors.Is(err, auth.ErrUnauthorized) {
		return refuse(pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION)
	}
	if err != nil {
		g.log.Error("gateway: redeem play token", "err", err)
		return refuse(pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED)
	}
	// Tell the loop a read is in flight before reading, so the ack of a save this read
	// may miss cannot drop the snapshot the Join will need (see session.LoginStarted).
	if err := g.cfg.Loop.Enqueue(g.cfg.World.LoginStarted(charID)); err != nil {
		g.log.Warn("gateway: loop queue full, login refused", "character", charID)
		return refuse(pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED)
	}
	pctx, pcancel := context.WithTimeout(ctx, dbTimeout)
	pc, err := g.cfg.Characters.PlayCharacter(pctx, accountID, charID, g.cfg.Clock.Now())
	pcancel()
	if err != nil {
		c.abortLogin(charID)
		if errors.Is(err, store.ErrNotFound) {
			return refuse(pb.DisconnectReason_DISCONNECT_REASON_INVALID_SESSION)
		}
		g.log.Error("gateway: load character", "character", charID, "err", err)
		return refuse(pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED)
	}
	return toCharacter(pc), true
}

func toCharacter(pc store.PlayCharacter) session.Character {
	c := session.Character{
		ID:         pc.ID,
		AccountID:  pc.AccountID,
		Name:       pc.Name,
		Vocation:   pc.Vocation,
		Level:      pc.Level,
		Experience: pc.Experience,
		Health:     pc.Health,
		Mana:       pc.Mana,
		Town:       pc.Town,
		Role:       session.RoleFromString(pc.Role),
		Storage:    pc.Storage,
	}
	for _, s := range pc.Skills {
		c.Skills = append(c.Skills, session.SkillState{ID: s.ID, Level: s.Level, Tries: s.Tries})
	}
	for _, k := range pc.Conditions {
		c.Conditions = append(c.Conditions, session.ConditionState{ID: k.ID, LeftMs: k.LeftMs, Ticks: k.Ticks, Damage: k.Damage})
	}
	c.Inventory = itemStates(pc.Inventory)
	if pc.HasPos && pc.X >= 0 && pc.X <= 0xFFFF && pc.Y >= 0 && pc.Y <= 0xFFFF && pc.Z >= 0 && pc.Z <= world.MaxFloor {
		c.HasPos = true
		c.Pos = world.Pos{X: uint16(pc.X), Y: uint16(pc.Y), Z: uint8(pc.Z)}
	}
	return c
}

// itemStates converts saved inventory rows; ids outside uint16 cannot be items.
func itemStates(in []store.InventoryItem) []session.ItemState {
	var out []session.ItemState
	for _, it := range in {
		if it.ItemID <= 0 || it.ItemID > 0xFFFF {
			continue
		}
		out = append(out, session.ItemState{ItemID: uint16(it.ItemID), Count: it.Count, Slot: it.Slot, Items: itemStates(it.Items)})
	}
	return out
}

// reader decodes client frames and enqueues them until the connection fails, the client
// abuses the rate limit or sends something malformed.
func (c *conn) reader(ctx context.Context, charID int64) {
	g := c.g
	lim := newLimiter(g.cfg.RateLimit, g.cfg.Clock.Now())
	// Reads stop when the writer closes the socket (Close, slow client, shutdown).
	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		switch lim.take(g.cfg.Clock.Now()) {
		case drop:
			continue
		case abuse:
			g.log.Warn("gateway: rate limit exceeded, disconnecting", "character", charID)
			c.Close(pb.DisconnectReason_DISCONNECT_REASON_RATE_LIMITED)
			return
		}
		msg := &pb.ClientMessage{}
		if typ != websocket.MessageBinary || proto.Unmarshal(data, msg) != nil || msg.GetMessage() == nil {
			g.log.Warn("gateway: malformed message, disconnecting", "character", charID)
			c.Close(pb.DisconnectReason_DISCONNECT_REASON_KICKED)
			return
		}
		if msg.GetHello() != nil {
			continue
		}
		if err := g.cfg.Loop.Enqueue(g.cfg.World.Input(c, msg)); err != nil {
			g.log.Warn("gateway: loop queue full, command dropped", "character", charID)
		}
	}
}

// abortLogin ends a LoginStarted whose Join will not be enqueued.
func (c *conn) abortLogin(charID int64) { c.mustEnqueue(c.g.cfg.World.LoginAborted(charID)) }

// leave tells the loop the connection is gone. It must not be lost (the player would
// stay in the world), so a full queue is retried until it has room or the server stops.
func (c *conn) leave() { c.mustEnqueue(c.g.cfg.World.Leave(c)) }

// mustEnqueue retries cmd until the queue has room or the server stops.
func (c *conn) mustEnqueue(cmd game.Command) {
	g := c.g
	for {
		if g.cfg.Loop.Enqueue(cmd) == nil {
			return
		}
		select {
		case <-g.stopCh:
			return // the loop is stopping: SaveAll takes everyone's final snapshot
		case <-g.cfg.Clock.After(game.TickDuration):
		}
	}
}

var bufPool = sync.Pool{New: func() any { b := make([]byte, 0, 4096); return &b }}

// writer sends batches until Close, then the queued batches (unless the client is too
// slow for them) and a Disconnect, and closes the socket.
func (c *conn) writer() {
	defer close(c.done)
	g := c.g
	ctx := context.Background()
	for {
		select {
		case b := <-c.out:
			if err := c.write(ctx, b); err != nil {
				_ = c.ws.CloseNow()
				<-c.closing // the reader fails, leaves and closes
				return
			}
		case <-c.closing:
			c.closeOnce.Lock()
			reason := c.reason
			c.closeOnce.Unlock()
			if reason != pb.DisconnectReason_DISCONNECT_REASON_SLOW_CLIENT {
				c.drain(ctx)
			}
			if reason != pb.DisconnectReason_DISCONNECT_REASON_UNSPECIFIED {
				_ = g.writeDisconnect(ctx, c.ws, reason)
			}
			_ = c.ws.Close(closeStatus(reason), "")
			return
		}
	}
}

func (c *conn) drain(ctx context.Context) {
	for {
		select {
		case b := <-c.out:
			if c.write(ctx, b) != nil {
				return
			}
		default:
			return
		}
	}
}

func (c *conn) write(ctx context.Context, b *pb.ServerBatch) error {
	bp := bufPool.Get().(*[]byte)
	defer bufPool.Put(bp)
	raw, err := proto.MarshalOptions{}.MarshalAppend((*bp)[:0], b)
	if err != nil {
		return fmt.Errorf("marshal batch: %w", err)
	}
	*bp = raw
	wctx, cancel := context.WithTimeout(ctx, c.g.cfg.WriteTimeout)
	defer cancel()
	if err := c.ws.Write(wctx, websocket.MessageBinary, raw); err != nil {
		return err
	}
	if m := c.g.cfg.Metrics; m != nil {
		m.Sent(len(raw))
	}
	return nil
}

// writeDisconnect sends a Disconnect on a tracked connection and counts it in the metrics.
func (g *Gateway) writeDisconnect(ctx context.Context, ws *websocket.Conn, reason pb.DisconnectReason) error {
	n, err := writeDisconnect(ctx, ws, reason, g.cfg.WriteTimeout)
	if err == nil && g.cfg.Metrics != nil {
		g.cfg.Metrics.Sent(n)
	}
	return err
}

// writeDisconnect sends a Disconnect and returns its size.
func writeDisconnect(ctx context.Context, ws *websocket.Conn, reason pb.DisconnectReason, timeout time.Duration) (int, error) {
	b := &pb.ServerBatch{Events: []*pb.ServerMessage{{Message: &pb.ServerMessage_Disconnect{Disconnect: &pb.Disconnect{Reason: reason}}}}}
	raw, err := proto.Marshal(b)
	if err != nil {
		return 0, fmt.Errorf("marshal disconnect: %w", err)
	}
	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := ws.Write(wctx, websocket.MessageBinary, raw); err != nil {
		return 0, err
	}
	return len(raw), nil
}

func closeStatus(r pb.DisconnectReason) websocket.StatusCode {
	switch r {
	case pb.DisconnectReason_DISCONNECT_REASON_SERVER_SHUTDOWN:
		return websocket.StatusGoingAway
	case pb.DisconnectReason_DISCONNECT_REASON_RATE_LIMITED, pb.DisconnectReason_DISCONNECT_REASON_KICKED:
		return websocket.StatusPolicyViolation
	default:
		return websocket.StatusNormalClosure
	}
}
