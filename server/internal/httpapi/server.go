// Package httpapi serves the HTTP API: account registration and login, the account's
// characters and health checks (docs/05-network-protocol.md, "API HTTP").
//
// Errors are JSON {"error":{"code":"..."}} with a stable code; the client turns the code
// into an i18n text, so no player-visible string is produced here.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// SessionCookie holds the account token for web clients (HttpOnly, SameSite=Strict).
const SessionCookie = "rpg_session"

const maxBodyBytes = 4 << 10

// Config configures the API.
type Config struct {
	Auth   *auth.Service
	Clock  clock.Clock
	Logger *slog.Logger
	// Health reports whether dependencies (Postgres) are reachable. Optional.
	Health func(context.Context) error
	// CookieSecure sets the Secure flag on the session cookie. Browsers accept Secure
	// cookies on http://localhost, so it only needs to be false for other plain-HTTP hosts.
	CookieSecure bool
	// TrustProxy takes the client IP from the last X-Forwarded-For entry (set by Caddy)
	// instead of the TCP peer. Only enable it behind a trusted reverse proxy.
	TrustProxy          bool
	AuthRateLimit       RateLimit // per IP; default DefaultAuthRateLimit
	LoginPairRateLimit  RateLimit // failed logins per (email, IP); default DefaultLoginPairRateLimit
	LoginEmailRateLimit RateLimit // failed logins per email; default DefaultLoginEmailRateLimit
}

type api struct {
	cfg          Config
	log          *slog.Logger
	limiter      *limiter
	pairLimiter  *limiter
	emailLimiter *limiter
}

func orDefault(rl, def RateLimit) RateLimit {
	if rl.Burst <= 0 || rl.Every <= 0 {
		return def
	}
	return rl
}

// New returns the API handler.
func New(cfg Config) (http.Handler, error) {
	if cfg.Auth == nil || cfg.Clock == nil {
		return nil, errors.New("httpapi: Auth and Clock are required")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	cfg.AuthRateLimit = orDefault(cfg.AuthRateLimit, DefaultAuthRateLimit)
	cfg.LoginPairRateLimit = orDefault(cfg.LoginPairRateLimit, DefaultLoginPairRateLimit)
	cfg.LoginEmailRateLimit = orDefault(cfg.LoginEmailRateLimit, DefaultLoginEmailRateLimit)
	a := &api{cfg: cfg, log: cfg.Logger}
	for _, l := range []struct {
		dst    **limiter
		rl     RateLimit
		policy collisionPolicy
	}{
		{&a.limiter, cfg.AuthRateLimit, failOpen},
		{&a.pairLimiter, cfg.LoginPairRateLimit, failClosed},
		{&a.emailLimiter, cfg.LoginEmailRateLimit, failClosed},
	} {
		lim, err := newLimiter(l.rl, l.policy, cfg.Clock)
		if err != nil {
			return nil, err
		}
		*l.dst = lim
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.healthz)
	mux.HandleFunc("POST /api/auth/register", a.rateLimited(a.register))
	mux.HandleFunc("POST /api/auth/login", a.rateLimited(a.login))
	mux.HandleFunc("POST /api/auth/logout", a.logout)
	mux.HandleFunc("GET /api/characters", a.authed(a.listCharacters))
	mux.HandleFunc("POST /api/characters", a.authed(a.createCharacter))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not_found")
	})
	return a.recoverer(mux), nil
}

// ---- handlers ----------------------------------------------------------------

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (a *api) register(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !a.decode(w, r, &in) {
		return
	}
	id, err := a.cfg.Auth.Register(r.Context(), in.Email, in.Password)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int64{"account_id": id})
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	// TokenInBody asks for the token in the JSON body (desktop client, bots, tools).
	// Web clients leave it false and only get the HttpOnly cookie, so script injected
	// in the page cannot read the token from the login response.
	TokenInBody bool `json:"token_in_body"`
}

type loginResponse struct {
	Token     string    `json:"token,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (a *api) login(w http.ResponseWriter, r *http.Request) {
	var in loginRequest
	if !a.decode(w, r, &in) {
		return
	}
	// Failed logins are limited per (email, client) pair (strict) and per email (loose).
	// A token of each is reserved before the password check, so concurrent requests
	// cannot all slip through on one token, and refunded unless the password was wrong:
	// only failures count (trade-off documented in docs/05).
	email, emailOK := auth.NormalizeEmail(in.Email)
	pairKey := email + "\x00" + a.clientKey(r) // NUL cannot appear in either part
	if emailOK {
		if !a.pairLimiter.allow(pairKey) {
			a.tooMany(w, a.cfg.LoginPairRateLimit)
			return
		}
		if !a.emailLimiter.allow(email) {
			a.pairLimiter.refund(pairKey)
			a.tooMany(w, a.cfg.LoginEmailRateLimit)
			return
		}
	}
	tok, err := a.cfg.Auth.Login(r.Context(), in.Email, in.Password)
	if emailOK && !errors.Is(err, auth.ErrInvalidCredentials) {
		a.pairLimiter.refund(pairKey)
		a.emailLimiter.refund(email)
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	http.SetCookie(w, a.cookie(tok.Token, tok.ExpiresAt))
	resp := loginResponse{ExpiresAt: tok.ExpiresAt.UTC()}
	if in.TokenInBody {
		resp.Token = tok.Token
	}
	writeJSON(w, http.StatusOK, resp)
}

func (a *api) logout(w http.ResponseWriter, r *http.Request) {
	if err := a.cfg.Auth.Logout(r.Context(), requestToken(r)); err != nil {
		a.fail(w, r, err)
		return
	}
	c := a.cookie("", time.Unix(0, 0))
	c.MaxAge = -1
	http.SetCookie(w, c)
	w.WriteHeader(http.StatusNoContent)
}

type characterJSON struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Vocation string `json:"vocation"`
	Level    int    `json:"level"`
}

func toJSON(c store.Character) characterJSON {
	return characterJSON{ID: c.ID, Name: c.Name, Vocation: c.Vocation, Level: c.Level}
}

func (a *api) listCharacters(w http.ResponseWriter, r *http.Request, accountID int64) {
	cs, err := a.cfg.Auth.Characters(r.Context(), accountID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	out := make([]characterJSON, len(cs))
	for i, c := range cs {
		out[i] = toJSON(c)
	}
	writeJSON(w, http.StatusOK, map[string][]characterJSON{"characters": out})
}

type createCharacterRequest struct {
	Name     string `json:"name"`
	Vocation string `json:"vocation"`
}

func (a *api) createCharacter(w http.ResponseWriter, r *http.Request, accountID int64) {
	var in createCharacterRequest
	if !a.decode(w, r, &in) {
		return
	}
	c, err := a.cfg.Auth.CreateCharacter(r.Context(), accountID, in.Name, in.Vocation)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]characterJSON{"character": toJSON(c)})
}

func (a *api) healthz(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Health != nil {
		if err := a.cfg.Health(r.Context()); err != nil {
			a.log.Warn("healthz: dependency down", "err", err)
			writeError(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ---- middleware ----------------------------------------------------------------

func (a *api) rateLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.limiter.allow(a.clientKey(r)) {
			a.tooMany(w, a.cfg.AuthRateLimit)
			return
		}
		next(w, r)
	}
}

func (a *api) tooMany(w http.ResponseWriter, rl RateLimit) {
	secs := int(rl.Every.Seconds() + 0.999)
	w.Header().Set("Retry-After", strconv.Itoa(max(secs, 1)))
	writeError(w, http.StatusTooManyRequests, "rate_limited")
}

func (a *api) authed(next func(http.ResponseWriter, *http.Request, int64)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := a.cfg.Auth.Authenticate(r.Context(), requestToken(r))
		if err != nil {
			a.fail(w, r, err)
			return
		}
		next(w, r, id)
	}
}

// requestToken reads "Authorization: Bearer <token>" (desktop client, tools; the scheme
// is case-insensitive) or, if there is no Bearer credential, the session cookie (web
// client). Other schemes, such as Basic from a password-protected staging site, are
// ignored instead of hiding the cookie.
func requestToken(r *http.Request) string {
	if scheme, tok, ok := strings.Cut(r.Header.Get("Authorization"), " "); ok && strings.EqualFold(scheme, "Bearer") {
		return strings.TrimSpace(tok)
	}
	if c, err := r.Cookie(SessionCookie); err == nil {
		return c.Value
	}
	return ""
}

// trackingWriter records whether the response has started.
type trackingWriter struct {
	http.ResponseWriter
	started bool
}

func (t *trackingWriter) WriteHeader(code int) { t.started = true; t.ResponseWriter.WriteHeader(code) }
func (t *trackingWriter) Write(b []byte) (int, error) {
	t.started = true
	return t.ResponseWriter.Write(b)
}

// Flush keeps streaming working through the wrapper.
func (t *trackingWriter) Flush() {
	if f, ok := t.ResponseWriter.(http.Flusher); ok {
		t.started = true
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (t *trackingWriter) Unwrap() http.ResponseWriter { return t.ResponseWriter }

// recoverer turns a handler panic into a logged 500 with the standard error body. If the
// response had already started, a 500 can no longer be sent: it aborts the response
// (net/http closes the connection) so a half-written body never looks complete.
func (a *api) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tw := &trackingWriter{ResponseWriter: w}
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			abort := false
			if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				abort = true // deliberate abort: not an error, just propagate it
			} else {
				a.log.Error("http api: panic", "method", r.Method, "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
				abort = tw.started
			}
			if abort {
				panic(http.ErrAbortHandler) //nolint:forbidigo // net/http's documented way to abort a response
			}
			writeError(w, http.StatusInternalServerError, "internal")
		}()
		next.ServeHTTP(tw, r)
	})
}

// clientKey is the rate-limit key of the client: its IPv4 address or its IPv6 /64
// (one subscriber usually owns a whole /64, so per-address keys would be free to rotate).
func (a *api) clientKey(r *http.Request) string {
	host := ""
	if a.cfg.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			host = strings.TrimSpace(parts[len(parts)-1])
		}
	}
	if host == "" {
		h, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			h = r.RemoteAddr
		}
		host = h
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	addr = addr.Unmap()
	if addr.Is6() {
		if p, err := addr.Prefix(64); err == nil {
			return p.String()
		}
	}
	return addr.String()
}

func (a *api) cookie(value string, expires time.Time) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookie,
		Value:    value,
		Path:     "/api",
		Expires:  expires,
		HttpOnly: true,
		Secure:   a.cfg.CookieSecure,
		SameSite: http.SameSiteStrictMode,
	}
}

// ---- encoding ------------------------------------------------------------------

// decode reads a single JSON object from a body of at most maxBodyBytes. Requiring the
// JSON content type also blocks cross-site HTML form posts.
func (a *api) decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request")
		return false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "bad_request")
		return false
	}
	return true
}

// errorStatus maps service errors to HTTP status and API error code.
var errorStatus = []struct {
	err    error
	status int
	code   string
}{
	{auth.ErrInvalidEmail, http.StatusBadRequest, "invalid_email"},
	{auth.ErrInvalidPassword, http.StatusBadRequest, "invalid_password"},
	{auth.ErrEmailTaken, http.StatusConflict, "email_taken"},
	{auth.ErrInvalidCredentials, http.StatusUnauthorized, "invalid_credentials"},
	{auth.ErrAccountDisabled, http.StatusForbidden, "account_disabled"},
	{auth.ErrUnauthorized, http.StatusUnauthorized, "unauthorized"},
	{auth.ErrInvalidName, http.StatusBadRequest, "invalid_name"},
	{auth.ErrNameTaken, http.StatusConflict, "name_taken"},
	{auth.ErrInvalidVocation, http.StatusBadRequest, "invalid_vocation"},
	{auth.ErrCharacterLimit, http.StatusConflict, "character_limit"},
	{auth.ErrBusy, http.StatusServiceUnavailable, "busy"},
}

func (a *api) fail(w http.ResponseWriter, r *http.Request, err error) {
	for _, e := range errorStatus {
		if errors.Is(err, e.err) {
			writeError(w, e.status, e.code)
			return
		}
	}
	if errors.Is(err, context.Canceled) {
		return // client went away
	}
	a.log.Error("http api", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal")
}

type errorBody struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code string) {
	var b errorBody
	b.Error.Code = code
	writeJSON(w, status, b)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
