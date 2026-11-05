// Package httpapi serves the HTTP API: account registration and login, the account's
// characters, health checks and the public website data (highscores, status; T4.3) (docs/05-network-protocol.md, "API HTTP").
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
	Auth   Accounts
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

	// Public website endpoints (T4.3). Without Highscores, /api/highscores answers 404.
	Highscores Highscores
	// Skills maps every rankable skill id to its base level (data/balance.yaml).
	Skills map[string]int
	// Vocations are the vocation ids the ranking can filter by.
	Vocations []string
	// Status reports whether the game loop runs and how many players are online.
	Status func() Status
	// Version is the server build version shown by /api/status.
	Version           string
	PublicRateLimit   RateLimit     // per IP; default DefaultPublicRateLimit
	HighscoreCacheTTL time.Duration // default DefaultHighscoreCacheTTL
}

// Accounts is the account service the API calls. *auth.Service implements it; tests
// can use fakes to reach every error path.
type Accounts interface {
	Register(ctx context.Context, email, password string) (int64, error)
	Login(ctx context.Context, email, password string) (auth.Token, error)
	Authenticate(ctx context.Context, token string) (int64, error)
	Logout(ctx context.Context, token string) error
	Characters(ctx context.Context, accountID int64) ([]store.Character, error)
	CreateCharacter(ctx context.Context, accountID int64, name, vocation string) (store.Character, error)
	IssuePlayToken(ctx context.Context, accountID, characterID int64) (auth.Token, error)
}

var _ Accounts = (*auth.Service)(nil)

type api struct {
	cfg          Config
	log          *slog.Logger
	limiter      *limiter
	pairLimiter  *limiter
	emailLimiter *limiter

	publicLimiter *limiter
	cache         *pageCache
	querySlots    chan struct{} // semaphore of ranking queries
	vocations     map[string]bool
}

func orDefault(rl, def RateLimit) RateLimit {
	if rl.Burst <= 0 || rl.Every <= 0 {
		return def
	}
	return rl
}

// New returns the API handler.
func New(cfg Config) (http.Handler, error) {
	a, err := newAPI(cfg)
	if err != nil {
		return nil, err
	}
	return a.recoverer(a.routes()), nil
}

// newAPI validates cfg, applies defaults and builds the limiters.
func newAPI(cfg Config) (*api, error) {
	if cfg.Auth == nil || cfg.Clock == nil {
		return nil, errors.New("httpapi: Auth and Clock are required")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	cfg.AuthRateLimit = orDefault(cfg.AuthRateLimit, DefaultAuthRateLimit)
	cfg.LoginPairRateLimit = orDefault(cfg.LoginPairRateLimit, DefaultLoginPairRateLimit)
	cfg.LoginEmailRateLimit = orDefault(cfg.LoginEmailRateLimit, DefaultLoginEmailRateLimit)
	cfg.PublicRateLimit = orDefault(cfg.PublicRateLimit, DefaultPublicRateLimit)
	if cfg.HighscoreCacheTTL <= 0 {
		cfg.HighscoreCacheTTL = DefaultHighscoreCacheTTL
	}
	// One entry per valid key at most: (level + skills) × (all + vocations) × pages.
	keys := (len(cfg.Skills) + 1) * (len(cfg.Vocations) + 1) * HighscoreMaxPages
	a := &api{
		cfg: cfg, log: cfg.Logger, vocations: make(map[string]bool),
		cache:      newPageCache(cfg.HighscoreCacheTTL, keys, cfg.Clock),
		querySlots: make(chan struct{}, maxHighscoreQueries),
	}
	for _, v := range cfg.Vocations {
		a.vocations[v] = true
	}
	for _, l := range []struct {
		dst    **limiter
		rl     RateLimit
		policy collisionPolicy
	}{
		{&a.limiter, cfg.AuthRateLimit, failOpen},
		{&a.pairLimiter, cfg.LoginPairRateLimit, failClosed},
		{&a.emailLimiter, cfg.LoginEmailRateLimit, failClosed},
		{&a.publicLimiter, cfg.PublicRateLimit, failOpen},
	} {
		lim, err := newLimiter(l.rl, l.policy, cfg.Clock)
		if err != nil {
			return nil, err
		}
		*l.dst = lim
	}

	return a, nil
}

func (a *api) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.healthz)
	mux.HandleFunc("POST /api/auth/register", a.rateLimited(a.register))
	mux.HandleFunc("POST /api/auth/login", a.rateLimited(a.login))
	mux.HandleFunc("POST /api/auth/logout", a.logout)
	mux.HandleFunc("GET /api/characters", a.authed(a.listCharacters))
	mux.HandleFunc("POST /api/characters", a.authed(a.createCharacter))
	mux.HandleFunc("POST /api/play", a.authed(a.play))
	mux.HandleFunc("GET /api/status", a.publicLimited(a.status))
	if a.cfg.Highscores != nil {
		mux.HandleFunc("GET /api/highscores", a.publicLimited(a.highscores))
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not_found")
	})
	return mux
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
	//
	// A malformed email or a password that registration could never have accepted cannot
	// match any account: answer at once, without a password check and without spending
	// login budget, so such cheap requests cannot be used to fill the limiter tables.
	email, emailOK := auth.NormalizeEmail(in.Email)
	if !emailOK || !auth.ValidPassword(in.Password) {
		a.fail(w, r, auth.ErrInvalidCredentials)
		return
	}
	pairKey := email + "\x00" + a.clientKey(r) // NUL cannot appear in either part
	ok, pairRes := a.pairLimiter.allow(pairKey)
	if !ok {
		a.tooMany(w, a.cfg.LoginPairRateLimit)
		return
	}
	ok, emailRes := a.emailLimiter.allow(email)
	if !ok {
		a.pairLimiter.refund(pairRes)
		a.tooMany(w, a.cfg.LoginEmailRateLimit)
		return
	}
	spent := false
	defer func() { // also runs if Login panics
		if !spent {
			a.pairLimiter.refund(pairRes)
			a.emailLimiter.refund(emailRes)
		}
	}()
	tok, err := a.cfg.Auth.Login(r.Context(), in.Email, in.Password)
	spent = errors.Is(err, auth.ErrInvalidCredentials)
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

type playRequest struct {
	CharacterID int64 `json:"character_id"`
}

type playResponse struct {
	SessionToken string    `json:"session_token"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// play issues the single-use play token (60 s) the client sends in the WebSocket Hello.
func (a *api) play(w http.ResponseWriter, r *http.Request, accountID int64) {
	var in playRequest
	if !a.decode(w, r, &in) {
		return
	}
	tok, err := a.cfg.Auth.IssuePlayToken(r.Context(), accountID, in.CharacterID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, playResponse{SessionToken: tok.Token, ExpiresAt: tok.ExpiresAt.UTC()})
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
		if ok, _ := a.limiter.allow(a.clientKey(r)); !ok {
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
	{auth.ErrAccountBanned, http.StatusForbidden, "account_banned"},
	{auth.ErrUnauthorized, http.StatusUnauthorized, "unauthorized"},
	{auth.ErrInvalidName, http.StatusBadRequest, "invalid_name"},
	{auth.ErrNameTaken, http.StatusConflict, "name_taken"},
	{auth.ErrInvalidVocation, http.StatusBadRequest, "invalid_vocation"},
	{auth.ErrCharacterLimit, http.StatusConflict, "character_limit"},
	{auth.ErrUnknownCharacter, http.StatusNotFound, "character_not_found"},
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
