package gateway

import (
	"net/http"
	"sync"
	"time"
)

// Limits bounds what one client and everyone together can hold of /ws (docs/05
// "Límites"; audit lote 16). For every field 0 means its default and a negative value
// means no limit (load tests and test harnesses only).
//
// A client is a key of clientip.Key (an IPv4 address or an IPv6 /64, behind -trust-proxy
// the last X-Forwarded-For entry). The per-client limits and the handshake bucket are
// checked before the WebSocket upgrade and answered with HTTP 429; the global ones with
// HTTP 503. MaxPlayers is checked after the Hello and answered with SERVER_FULL.
type Limits struct {
	// MaxConnsPerClient caps the open connections of one client, logged in or not.
	MaxConnsPerClient int
	// MaxPendingPerClient caps the connections of one client still in the handshake
	// (before the Hello was checked and the character loaded).
	MaxPendingPerClient int
	// HandshakeBurst and HandshakeEvery are the token bucket of new connections of one
	// client: HandshakeBurst at once, then one every HandshakeEvery.
	HandshakeBurst int
	HandshakeEvery time.Duration
	// MaxUnauthenticated caps the connections of everyone still in the handshake.
	MaxUnauthenticated int
	// MaxHandshakes caps the handshakes reading the database at once (the play token's
	// redeem and the character's load). When all are busy new connections get 503.
	MaxHandshakes int
	// MaxPlayers caps the logged-in connections (and the logins in progress).
	MaxPlayers int
	// MaxQueuedPerConn caps the commands of one connection waiting in the game loop's
	// queue (game.Quota); more are dropped.
	MaxQueuedPerConn int
}

// DefaultLimits are the production limits.
var DefaultLimits = Limits{
	MaxConnsPerClient:   8,
	MaxPendingPerClient: 4,
	HandshakeBurst:      5,
	HandshakeEvery:      2 * time.Second,
	MaxUnauthenticated:  1000,
	MaxHandshakes:       32,
	MaxPlayers:          500,
	MaxQueuedPerConn:    16,
}

// withDefaults fills the zero fields from DefaultLimits.
func (l Limits) withDefaults() Limits {
	d := DefaultLimits
	pick := func(v *int, def int) {
		if *v == 0 {
			*v = def
		}
	}
	pick(&l.MaxConnsPerClient, d.MaxConnsPerClient)
	pick(&l.MaxPendingPerClient, d.MaxPendingPerClient)
	pick(&l.HandshakeBurst, d.HandshakeBurst)
	pick(&l.MaxUnauthenticated, d.MaxUnauthenticated)
	pick(&l.MaxHandshakes, d.MaxHandshakes)
	pick(&l.MaxPlayers, d.MaxPlayers)
	pick(&l.MaxQueuedPerConn, d.MaxQueuedPerConn)
	if l.HandshakeEvery == 0 {
		l.HandshakeEvery = d.HandshakeEvery
	}
	return l
}

// over reports whether n reached limit (a negative limit never does).
func over(n, limit int) bool { return limit >= 0 && n >= limit }

// clientState is what the gateway counts of one client key.
type clientState struct {
	open    int
	pending int
	tokens  float64 // handshake bucket
	last    time.Time
}

// refill brings the bucket up to now.
func (s *clientState) refill(l Limits, now time.Time) {
	if l.HandshakeEvery <= 0 {
		s.tokens = float64(l.HandshakeBurst)
		return
	}
	if dt := now.Sub(s.last); dt > 0 {
		s.tokens = min(s.tokens+float64(dt)/float64(l.HandshakeEvery), float64(l.HandshakeBurst))
		s.last = now
	}
}

// admission is the gateway's count of connections by client and in total. Its methods
// are safe for concurrent use.
type admission struct {
	lim Limits

	mu       sync.Mutex
	clients  map[string]*clientState
	unauth   int
	players  int
	admitted uint64 // admits since the start, to sweep clients now and then
	// sem holds a token per handshake reading the database (nil: no limit).
	sem chan struct{}
}

func newAdmission(lim Limits) *admission {
	a := &admission{lim: lim, clients: map[string]*clientState{}}
	if lim.MaxHandshakes > 0 {
		a.sem = make(chan struct{}, lim.MaxHandshakes)
	}
	return a
}

// ticket is one admitted connection. Its methods are called from that connection's
// goroutines, in order: authenticated (at most once), then close (once).
type ticket struct {
	a       *admission
	key     string
	exempt  bool // loopback in development: per-client limits not applied
	pending bool // still counted in pending/unauth
	player  bool // holds a MaxPlayers slot
}

// admit decides whether a new connection of key may be upgraded. It returns the ticket,
// or 0 and the HTTP status to refuse it with.
func (a *admission) admit(key string, exempt bool, now time.Time) (*ticket, int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.admitted++
	if a.admitted%1024 == 0 {
		a.sweep(now)
	}
	if over(a.unauth, a.lim.MaxUnauthenticated) {
		return nil, http.StatusServiceUnavailable
	}
	if a.sem != nil && len(a.sem) == cap(a.sem) {
		// Every database slot is busy: the server is behind on logins already.
		return nil, http.StatusServiceUnavailable
	}
	s := a.clients[key]
	if s == nil {
		s = &clientState{tokens: float64(a.lim.HandshakeBurst), last: now}
	}
	if !exempt {
		if over(s.open, a.lim.MaxConnsPerClient) || over(s.pending, a.lim.MaxPendingPerClient) {
			return nil, http.StatusTooManyRequests
		}
		if a.lim.HandshakeBurst >= 0 {
			s.refill(a.lim, now)
			if s.tokens < 1 {
				a.clients[key] = s // remember the empty bucket
				return nil, http.StatusTooManyRequests
			}
			s.tokens--
		}
	}
	a.clients[key] = s
	s.open++
	s.pending++
	a.unauth++
	return &ticket{a: a, key: key, exempt: exempt, pending: true}, 0
}

// sweep forgets the clients without connections whose bucket is full again.
func (a *admission) sweep(now time.Time) {
	for k, s := range a.clients {
		if s.open == 0 {
			s.refill(a.lim, now)
			if s.tokens >= float64(a.lim.HandshakeBurst) {
				delete(a.clients, k)
			}
		}
	}
}

// reservePlayer takes a MaxPlayers slot for the login in progress.
func (t *ticket) reservePlayer() bool {
	a := t.a
	a.mu.Lock()
	defer a.mu.Unlock()
	if t.player {
		return true
	}
	if over(a.players, a.lim.MaxPlayers) {
		return false
	}
	a.players++
	t.player = true
	return true
}

// authenticated ends the handshake part of the ticket (pending and unauth counts).
func (t *ticket) authenticated() {
	a := t.a
	a.mu.Lock()
	defer a.mu.Unlock()
	t.endPending()
}

func (t *ticket) endPending() {
	if !t.pending {
		return
	}
	t.pending = false
	a := t.a
	a.unauth--
	if s := a.clients[t.key]; s != nil {
		s.pending--
	}
}

// close gives back everything the connection held.
func (t *ticket) close() {
	a := t.a
	a.mu.Lock()
	defer a.mu.Unlock()
	t.endPending()
	if t.player {
		t.player = false
		a.players--
	}
	if s := a.clients[t.key]; s != nil {
		s.open--
		if s.open == 0 && s.tokens >= float64(a.lim.HandshakeBurst) {
			delete(a.clients, t.key)
		}
	}
}

// acquireDB waits for a database slot of the handshake until done is closed; false if
// it was closed first. release gives the slot back.
func (a *admission) acquireDB(done <-chan struct{}) bool {
	if a.sem == nil {
		return true
	}
	select {
	case a.sem <- struct{}{}:
		return true
	case <-done:
		return false
	}
}

func (a *admission) releaseDB() {
	if a.sem != nil {
		<-a.sem
	}
}

// counts returns the connections in the handshake, the MaxPlayers slots in use and the
// clients remembered (tests).
func (a *admission) counts() (unauth, players, clients int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.unauth, a.players, len(a.clients)
}

// validToken reports whether s has the shape of a play token: 32 random bytes in
// unpadded base64url, 43 characters (auth newToken). Anything else is refused before it
// costs a database query.
func validToken(s string) bool {
	if len(s) != 43 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// logEvery throttles a repeated log record: the first event is reported, then at most
// one record per interval with how many happened since the last one.
type logEvery struct {
	mu       sync.Mutex
	interval time.Duration
	next     time.Time
	n        int
}

// DefaultLogEvery is the interval of the throttled gateway logs.
const DefaultLogEvery = 10 * time.Second

// hit counts one event and returns how many to report now (0: stay quiet).
func (l *logEvery) hit(now time.Time) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.n++
	if now.Before(l.next) {
		return 0
	}
	n := l.n
	l.n = 0
	l.next = now.Add(l.interval)
	return n
}

// flush returns the events not reported yet and forgets them.
func (l *logEvery) flush() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := l.n
	l.n = 0
	return n
}
