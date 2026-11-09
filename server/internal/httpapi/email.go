package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
)

// Email verification and password reset (T2.1, docs/05 "Verificación de email y reset
// de contraseña"). The tokens arrive in POST bodies, never in a URL the server sees.

// Defaults of the email rate limits (docs/05).
var (
	// DefaultVerifyResendRateLimit: verification emails per account.
	DefaultVerifyResendRateLimit = RateLimit{Burst: 3, Every: 10 * time.Minute}
	// DefaultResetEmailRateLimit: reset emails per address, whoever asks. Over it the
	// request is answered like any other and nothing is sent.
	DefaultResetEmailRateLimit = RateLimit{Burst: 3, Every: 20 * time.Minute}
)

// maxPendingResets bounds the reset requests handled in the background at once; more
// are answered the same way and dropped.
const maxPendingResets = 8

// resetTimeout bounds one background reset request (lookups and queueing the email).
const resetTimeout = 10 * time.Second

// resetDoneHook is told when a background reset request finished (tests only).
var resetDoneHook func()

type tokenRequest struct {
	Token string `json:"token"`
}

type resendRequest struct {
	Lang string `json:"lang,omitempty"`
}

type forgotRequest struct {
	Email string `json:"email"`
	Lang  string `json:"lang,omitempty"`
}

type resetRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

type accountJSON struct {
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	// EmailEnabled: the server sends emails, so verifying is possible (and asked for).
	EmailEnabled bool `json:"email_enabled"`
	// HasPassword: the account can log in with a password (T2.1 2/2).
	HasPassword bool           `json:"has_password"`
	Identities  []identityJSON `json:"identities"`
}

func (a *api) emailRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/config", a.publicLimited(a.authConfig))
	mux.HandleFunc("GET /api/account", a.authed(a.account))
	mux.HandleFunc("POST /api/auth/verify", a.rateLimited(a.verifyEmail))
	mux.HandleFunc("POST /api/auth/verify/resend", a.authed(a.resendVerification))
	mux.HandleFunc("POST /api/auth/password/forgot", a.rateLimited(a.forgotPassword))
	mux.HandleFunc("POST /api/auth/password/reset", a.rateLimited(a.resetPassword))
}

// authConfig tells the website and the game which account features this server has,
// so they never offer what cannot work (a reset email without SMTP).
// Providers lists the OAuth providers with keys; their secrets never leave the server.
func (a *api) authConfig(w http.ResponseWriter, _ *http.Request) {
	providers := a.cfg.Auth.Providers()
	if providers == nil {
		providers = []string{}
	}
	writeJSON(w, http.StatusOK, struct {
		Email     bool     `json:"email"`
		Providers []string `json:"providers"`
	}{a.cfg.Auth.EmailEnabled(), providers})
}

func (a *api) account(w http.ResponseWriter, r *http.Request, accountID int64) {
	p, err := a.cfg.Auth.Profile(r.Context(), accountID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	ids, err := a.identitiesOf(r.Context(), accountID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, accountJSON{
		Email: p.Email, EmailVerified: p.EmailVerified, EmailEnabled: a.cfg.Auth.EmailEnabled(),
		HasPassword: p.HasPassword, Identities: ids,
	})
}

func (a *api) verifyEmail(w http.ResponseWriter, r *http.Request) {
	var in tokenRequest
	if !a.decode(w, r, &in) {
		return
	}
	if err := a.cfg.Auth.VerifyEmail(r.Context(), in.Token); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) resendVerification(w http.ResponseWriter, r *http.Request, accountID int64) {
	var in resendRequest
	if !a.decode(w, r, &in) {
		return
	}
	if !a.cfg.Auth.EmailEnabled() {
		a.fail(w, r, auth.ErrEmailDisabled)
		return
	}
	if ok, _ := a.verifyLimiter.allow(strconv.FormatInt(accountID, 10)); !ok {
		a.tooMany(w, a.cfg.VerifyResendRateLimit)
		return
	}
	if err := a.cfg.Auth.SendVerification(r.Context(), accountID, in.Lang); err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// forgotPassword answers 202 whatever the address: existing or not, verified or not,
// over its limit or not. The lookup and the email run in the background, so not even
// the response time depends on the account.
func (a *api) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var in forgotRequest
	if !a.decode(w, r, &in) {
		return
	}
	if !a.cfg.Auth.EmailEnabled() {
		a.fail(w, r, auth.ErrEmailDisabled)
		return
	}
	email, ok := auth.NormalizeEmail(in.Email)
	if !ok {
		a.fail(w, r, auth.ErrInvalidEmail) // says nothing about accounts
		return
	}
	if ok, _ := a.resetLimiter.allow(email); ok {
		select {
		case a.resetSlots <- struct{}{}:
			go a.requestReset(email, in.Lang)
		default:
			a.log.Warn("password reset: too many pending requests, one dropped")
		}
	}
	w.WriteHeader(http.StatusAccepted)
}

func (a *api) requestReset(email, lang string) {
	defer func() { <-a.resetSlots }()
	defer func() {
		if v := recover(); v != nil {
			a.log.Error("password reset: panic", "panic", v)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), resetTimeout)
	defer cancel()
	// The error never names the address (it is not logged either).
	if err := a.cfg.Auth.RequestPasswordReset(ctx, email, lang); err != nil {
		a.log.Error("password reset request failed", "err", err)
	}
	if h := resetDoneHook; h != nil {
		h()
	}
}

func (a *api) resetPassword(w http.ResponseWriter, r *http.Request) {
	var in resetRequest
	if !a.decode(w, r, &in) {
		return
	}
	if err := a.cfg.Auth.ResetPassword(r.Context(), in.Token, in.Password); err != nil {
		a.fail(w, r, err)
		return
	}
	// Every session of the account is gone, this browser's included.
	c := a.cookie("", time.Unix(0, 0))
	c.MaxAge = -1
	http.SetCookie(w, c)
	w.WriteHeader(http.StatusNoContent)
}

// sendVerificationAfterRegister emails the first verification link. A failure (full
// queue) does not undo the registration: the player can ask again.
func (a *api) sendVerificationAfterRegister(ctx context.Context, accountID int64, lang string) {
	if !a.cfg.Auth.EmailEnabled() {
		return
	}
	// The account was just created: this cannot be the resend limit's abuse, but it
	// spends one of its tokens so a new account cannot get more emails than the limit.
	a.verifyLimiter.allow(strconv.FormatInt(accountID, 10))
	if err := a.cfg.Auth.SendVerification(ctx, accountID, lang); err != nil && !errors.Is(err, context.Canceled) {
		a.log.Error("register: verification email not sent", "err", err)
	}
}
