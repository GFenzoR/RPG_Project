package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
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
	// DefaultTokenNetRateLimit: token lookups per network (IPv6 /48 or IPv4 /24), spent
	// with the per-client one: a /48 holds 65 536 /64s, enough to fill the per-client
	// table and slip past it.
	DefaultTokenNetRateLimit = RateLimit{Burst: 300, Every: 100 * time.Millisecond}
	// DefaultDeviceLoginRateLimit: failed logins per known-device cookie. Past it the
	// cookie stops exempting from the per-email limit, so one copied cookie cannot carry
	// a guessing run across many addresses.
	DefaultDeviceLoginRateLimit = RateLimit{Burst: 10, Every: 6 * time.Minute}
)

const (
	// DefaultNetHashing is the number of password-hashing requests (login, register, reset, OAuth
	// confirm and link with a password) in flight at once per IPv6 /48 or IPv4 address.
	// The service has few hashing slots for everyone (auth.DefaultMaxConcurrentHashes):
	// one network may hold at most this many of them. Two, not one: two people behind
	// one NAT or CGNAT address often log in at the same time.
	DefaultNetHashing = 2
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
	if cfg.TokenNetRateLimit == (RateLimit{}) {
		cfg.TokenNetRateLimit = RateLimit{Burst: max(burst, DefaultTokenNetRateLimit.Burst), Every: DefaultTokenNetRateLimit.Every}
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
		if !a.allowTokenLookup(w, r) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), httpDBTimeout)
		defer cancel()
		next(w, r.WithContext(ctx))
	}
}

// allowTokenLookup spends the client's token-lookup budget and its network's (IPv6
// /48, IPv4 /24; failClosed); on false it answered 429.
func (a *api) allowTokenLookup(w http.ResponseWriter, r *http.Request) bool {
	ok, res := a.tokenLimiter.allow(a.clientKey(r))
	if !ok {
		a.tooMany(w, a.cfg.TokenRateLimit)
		return false
	}
	if ok, _ := a.tokenNetLimiter.allow(a.netKey(r, false)); !ok {
		a.tokenLimiter.refund(res)
		a.tooMany(w, a.cfg.TokenNetRateLimit)
		return false
	}
	return true
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

// deviceValue is the cookie value binding this browser to email and its account's
// current password (stamp, Accounts.LoginStamp) until exp: exp (8 bytes) and the first
// 16 bytes of HMAC-SHA256(deviceKey, email, stamp, exp), base64url. It does not reveal
// the email, and a password change (a reset) voids every cookie signed before it.
func (a *api) deviceValue(email, stamp string, exp int64) string {
	var b [24]byte
	binary.BigEndian.PutUint64(b[:8], uint64(exp))
	m := hmac.New(sha256.New, a.deviceKey[:])
	m.Write([]byte("device"))
	for _, part := range []string{email, stamp} {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(part)))
		m.Write(n[:])
		m.Write([]byte(part))
	}
	m.Write(b[:8])
	copy(b[8:], m.Sum(nil)[:16])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// knownDevice returns the request's device cookie if it is valid for email and the
// account's current password ("" otherwise). The stamp is only looked up for a cookie
// that is well formed and unexpired.
func (a *api) knownDevice(r *http.Request, email string) string {
	c, err := r.Cookie(DeviceCookie)
	if err != nil || len(c.Value) != 32 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil || len(raw) != 24 {
		return ""
	}
	exp := int64(binary.BigEndian.Uint64(raw[:8]))
	if a.cfg.Clock.Now().Unix() >= exp {
		return ""
	}
	stamp, err := a.cfg.Auth.LoginStamp(r.Context(), email)
	if err != nil || stamp == "" {
		return ""
	}
	if !hmac.Equal([]byte(a.deviceValue(email, stamp, exp)), []byte(c.Value)) {
		return ""
	}
	return c.Value
}

// setDevice marks this browser as a known device of email, signed with the account's
// current password stamp. Only on the routes the cookie is sent to (devicePath): a
// login check elsewhere (unlink) could never use it.
func (a *api) setDevice(w http.ResponseWriter, r *http.Request, email string) {
	if !strings.HasPrefix(r.URL.Path, devicePath+"/") {
		return
	}
	stamp, err := a.cfg.Auth.LoginStamp(r.Context(), email)
	if err != nil || stamp == "" {
		return // no cookie: the login itself worked
	}
	exp := a.cfg.Clock.Now().Add(deviceCookieTTL)
	http.SetCookie(w, &http.Cookie{
		Name: DeviceCookie, Value: a.deviceValue(email, stamp, exp.Unix()), Path: devicePath,
		MaxAge: int(deviceCookieTTL.Seconds()), HttpOnly: true, Secure: a.cfg.CookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
}

// ---- /healthz cache --------------------------------------------------------------

// healthCache runs Config.Health at most once per healthCacheTTL, counted from the end
// of the ping (a slow database must not leave the result stale on arrival); requests
// that come while a ping is in flight wait for its result instead of each pinging.
type healthCache struct {
	mu   sync.Mutex
	at   time.Time
	err  error
	done bool
	wait chan struct{} // closed when the ping in flight ends; nil if none
}

func (a *api) health(ctx context.Context) error {
	c := &a.healthC
	c.mu.Lock()
	now := a.cfg.Clock.Now()
	if c.done && now.Sub(c.at) < healthCacheTTL && now.Sub(c.at) >= 0 {
		err := c.err
		c.mu.Unlock()
		return err
	}
	if w := c.wait; w != nil {
		c.mu.Unlock()
		select {
		case <-w:
		case <-ctx.Done():
			return ctx.Err()
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.err
	}
	w := make(chan struct{})
	c.wait = w
	c.mu.Unlock()
	err := errors.New("httpapi: health check panicked")
	defer func() { // also if Health panics: waiters must not hang
		c.mu.Lock()
		c.err, c.at, c.done, c.wait = err, a.cfg.Clock.Now(), true, nil
		c.mu.Unlock()
		close(w)
	}()
	// Not cancelled with this request: its result is shared with the others for a second.
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), httpDBTimeout)
	defer cancel()
	err = a.cfg.Health(pctx)
	return err
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

// maxLogKeys bounds the sampler. When it is full, keys idle for logSampleEvery are
// dropped, and a new key that still finds it full is sampled under one shared overflow
// key: errors with endless distinct texts cannot defeat the sampling.
const maxLogKeys = 256

// logOverflowKey is the shared key of the keys that found the sampler full.
const logOverflowKey = "|overflow|"

type sampled struct {
	last       time.Time
	suppressed int
}

// allow reports whether to write the line of key now and how many were suppressed
// since the previous one.
func (s *logSampler) allow(key string, now time.Time) (bool, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.keys == nil {
		s.keys = map[string]*sampled{}
	}
	if _, known := s.keys[key]; !known && len(s.keys) >= maxLogKeys {
		for k, e := range s.keys {
			if d := now.Sub(e.last); d >= logSampleEvery || d < 0 {
				delete(s.keys, k)
			}
		}
		if len(s.keys) >= maxLogKeys {
			key = logOverflowKey
		}
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
