package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"log/slog"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

// Limits against cheap abuse of the API by unauthenticated clients or by one account
// (lote 16, docs/05 "Límites de la API").

// Defaults (docs/05-network-protocol.md, "API HTTP").
var (
	// DefaultTokenRateLimit: requests that look up a session token (authed routes,
	// logout, the pending OAuth identity) per client key, spent before the lookup, so a
	// flood of made-up tokens cannot starve the database pool.
	DefaultTokenRateLimit = RateLimit{Burst: 60, Every: 500 * time.Millisecond}
	// DefaultAccountRateLimit: authenticated requests per account, any route.
	DefaultAccountRateLimit = RateLimit{Burst: 60, Every: 500 * time.Millisecond}
	// DefaultAccountWriteRateLimit: POST /api/play and POST /api/characters per account
	// (each play token is a row of sessions until the hourly purge).
	DefaultAccountWriteRateLimit = RateLimit{Burst: 20, Every: 3 * time.Second}
	// DefaultAuthNetRateLimit: register, login and the other password and email routes
	// per network: IPv6 /48 or IPv4 /24 (one subscriber may own a whole /48: per-/64
	// keys alone are free to rotate).
	DefaultAuthNetRateLimit = RateLimit{Burst: 40, Every: 1500 * time.Millisecond}
)

const (
	// DefaultNetHashing is the number of password-hashing requests (login, register, reset, OAuth
	// confirm and link with a password) in flight at once per IPv6 /48 or IPv4 address.
	// The service has few hashing slots for everyone (auth.DefaultMaxConcurrentHashes):
	// one network may hold at most this many of them.
	DefaultNetHashing = 1
	// httpDBTimeout bounds the database work of the short authenticated routes (the
	// token lookup, characters, play, account, logout): a slow pool fails them fast
	// instead of piling requests up.
	httpDBTimeout = 3 * time.Second
	// healthCacheTTL: /healthz pings the database at most once per this long.
	healthCacheTTL = time.Second
	// logSampleEvery: a repeated log line is written once, then summarized at most once
	// per this long with how many times it happened.
	logSampleEvery = time.Minute
	// DeviceCookie marks a browser that logged into an account with its password
	// (deviceCookieTTL). Its failed logins do not spend that account's per-email budget,
	// so strangers' failures cannot lock its owner out.
	DeviceCookie    = "rpg_device"
	deviceCookieTTL = 90 * 24 * time.Hour
	devicePath      = "/api/auth"
)

// sharedIPScale applies the test harnesses' shared-IP mode: a per-IP burst raised over
// the default (-auth-rate-burst: e2e, bots and make play send everything from one
// address) raises the other per-client and per-network limits the same way and turns
// off the per-network hashing cap, unless the Config sets them.
func sharedIPScale(cfg *Config) {
	if cfg.AuthRateLimit.Burst <= DefaultAuthRateLimit.Burst {
		return
	}
	burst := cfg.AuthRateLimit.Burst
	if cfg.TokenRateLimit == (RateLimit{}) {
		cfg.TokenRateLimit = RateLimit{Burst: burst, Every: DefaultTokenRateLimit.Every}
	}
	if cfg.AuthNetRateLimit == (RateLimit{}) {
		cfg.AuthNetRateLimit = RateLimit{Burst: burst, Every: DefaultAuthNetRateLimit.Every}
	}
	if cfg.NetHashing == 0 {
		cfg.NetHashing = -1
	}
}

// clientAddr is the client's IP address (see clientKey); ok is false if it is not one.
func (a *api) clientAddr(r *http.Request) (netip.Addr, string, bool) {
	host := a.clientHost(r)
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, host, false
	}
	return addr.Unmap(), host, true
}

// netKey is the rate-limit key of the client's network: its IPv6 /48 or IPv4 /24, or
// with v4Exact its IPv4 address itself.
func (a *api) netKey(r *http.Request, v4Exact bool) string {
	addr, host, ok := a.clientAddr(r)
	if !ok {
		return host
	}
	bits := 24
	switch {
	case addr.Is6():
		bits = 48
	case v4Exact:
		return addr.String()
	}
	if p, err := addr.Prefix(bits); err == nil {
		return p.String()
	}
	return addr.String()
}

// inflight counts requests in flight per key, at most max each. Its map only holds
// keys with requests in flight, so it is bounded by the open requests.
type inflight struct {
	max int
	mu  sync.Mutex
	n   map[string]int
}

func newInflight(max int) *inflight { return &inflight{max: max, n: map[string]int{}} }

func (f *inflight) acquire(key string) bool {
	if f.max <= 0 {
		return true
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.n[key] >= f.max {
		return false
	}
	f.n[key]++
	return true
}

func (f *inflight) release(key string) {
	if f.max <= 0 {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.n[key] <= 1 {
		delete(f.n, key)
		return
	}
	f.n[key]--
}

// hashing lets at most NetHashing password-hashing requests of one network (IPv6 /48,
// IPv4 address) run at once; the others are answered 429 at once, without waiting for
// one of the service's few hashing slots.
func (a *api) hashing(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := a.netKey(r, true)
		if !a.netHashing.acquire(key) {
			a.tooMany(w, RateLimit{Burst: 1, Every: time.Second})
			return
		}
		defer a.netHashing.release(key)
		next(w, r)
	}
}

// tokenLimited spends the client's token-lookup budget before a handler that looks up
// a token without authed (logout, the pending OAuth identity), and bounds its database
// work by httpDBTimeout.
func (a *api) tokenLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if ok, _ := a.tokenLimiter.allow(a.clientKey(r)); !ok {
			a.tooMany(w, a.cfg.TokenRateLimit)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), httpDBTimeout)
		defer cancel()
		next(w, r.WithContext(ctx))
	}
}

// accountLimited spends the account's write budget (play, character creation).
func (a *api) accountLimited(next authedFunc) authedFunc {
	return func(w http.ResponseWriter, r *http.Request, accountID int64) {
		if ok, _ := a.writeLimiter.allow(strconv.FormatInt(accountID, 10)); !ok {
			a.tooMany(w, a.cfg.AccountWriteRateLimit)
			return
		}
		next(w, r, accountID)
	}
}

// shortDBRoute bounds the database work of a short authenticated route by httpDBTimeout.
func shortDBRoute(next authedFunc) authedFunc {
	return func(w http.ResponseWriter, r *http.Request, accountID int64) {
		ctx, cancel := context.WithTimeout(r.Context(), httpDBTimeout)
		defer cancel()
		next(w, r.WithContext(ctx), accountID)
	}
}

// ---- known devices ------------------------------------------------------------

// deviceValue is the cookie value binding this browser to email until exp: exp (8
// bytes) and the first 16 bytes of HMAC-SHA256(deviceKey, email, exp), base64url. It
// does not reveal the email.
func (a *api) deviceValue(email string, exp int64) string {
	var b [24]byte
	binary.BigEndian.PutUint64(b[:8], uint64(exp))
	m := hmac.New(sha256.New, a.deviceKey[:])
	m.Write([]byte("device\x00" + email + "\x00"))
	m.Write(b[:8])
	copy(b[8:], m.Sum(nil)[:16])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// knownDevice reports whether the request carries a valid device cookie for email.
func (a *api) knownDevice(r *http.Request, email string) bool {
	c, err := r.Cookie(DeviceCookie)
	if err != nil || len(c.Value) != 32 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil || len(raw) != 24 {
		return false
	}
	exp := int64(binary.BigEndian.Uint64(raw[:8]))
	if a.cfg.Clock.Now().Unix() >= exp {
		return false
	}
	return hmac.Equal([]byte(a.deviceValue(email, exp)), []byte(c.Value))
}

// setDevice marks this browser as a known device of email.
func (a *api) setDevice(w http.ResponseWriter, email string) {
	exp := a.cfg.Clock.Now().Add(deviceCookieTTL)
	http.SetCookie(w, &http.Cookie{
		Name: DeviceCookie, Value: a.deviceValue(email, exp.Unix()), Path: devicePath,
		MaxAge: int(deviceCookieTTL.Seconds()), HttpOnly: true, Secure: a.cfg.CookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
}

// ---- /healthz cache --------------------------------------------------------------

// healthCache runs Config.Health at most once per healthCacheTTL; concurrent requests
// wait for the one ping in flight instead of each taking a pool connection.
type healthCache struct {
	mu   sync.Mutex
	at   time.Time
	err  error
	done bool
}

func (a *api) health(ctx context.Context) error {
	c := &a.healthC
	c.mu.Lock()
	defer c.mu.Unlock()
	now := a.cfg.Clock.Now()
	if c.done && now.Sub(c.at) < healthCacheTTL && now.Sub(c.at) >= 0 {
		return c.err
	}
	// Not cancelled with this request: its result is shared with the others for a second.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), httpDBTimeout)
	defer cancel()
	c.err, c.at, c.done = a.cfg.Health(ctx), now, true
	return c.err
}

// ---- sampled logs ----------------------------------------------------------------

// logSampler writes the first occurrence of a log key and then at most one summary per
// logSampleEvery with the count since the last line, so an attacker who can trigger an
// error log at will cannot flood the logs. Keys are fixed strings of the code or error
// messages; maxLogKeys bounds them.
type logSampler struct {
	mu   sync.Mutex
	keys map[string]*sampled
}

// maxLogKeys bounds the sampler: when full it starts over (a burst of new keys at worst
// logs each once more).
const maxLogKeys = 256

type sampled struct {
	last       time.Time
	suppressed int
}

// allow reports whether to write the line of key now and how many were suppressed
// since the previous one.
func (s *logSampler) allow(key string, now time.Time) (bool, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.keys == nil || len(s.keys) >= maxLogKeys {
		s.keys = map[string]*sampled{}
	}
	e := s.keys[key]
	if e == nil {
		s.keys[key] = &sampled{last: now}
		return true, 0
	}
	if d := now.Sub(e.last); d >= 0 && d < logSampleEvery {
		e.suppressed++
		return false, 0
	}
	n := e.suppressed
	e.last, e.suppressed = now, 0
	return true, n
}

// sampledLog logs msg at level under the sampler (key: level and msg), adding
// "suppressed" with how many identical lines were dropped since the last one.
func (a *api) sampledLog(level slog.Level, msg string, args ...any) {
	ok, n := a.logs.allow(level.String()+"\x00"+msg, a.cfg.Clock.Now())
	if !ok {
		return
	}
	if n > 0 {
		args = append(args, "suppressed", n)
	}
	a.log.Log(context.Background(), level, msg, args...)
}
