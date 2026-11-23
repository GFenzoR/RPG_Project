package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
)

// OAuth login with Google and Discord and linked identities (T2.1 2/2, docs/05 "OAuth").
// The browser starts with a JSON POST (no cross-site form can start a login in someone
// else's browser), goes to the provider and comes back to the GET callback, which answers
// with a redirect to a fixed page of the site: never to a URL the request names.

// Cookies of the OAuth flows. Both are HttpOnly and only sent to /api/auth/oauth.
const (
	// OAuthCookie binds a state to the browser that started it. SameSite=Lax: it must
	// come back on the provider's top-level redirect to the callback.
	OAuthCookie = "rpg_oauth"
	// PendingCookie names the identity waiting on /oauth/confirm. SameSite=Strict: only
	// the site's own pages use it.
	PendingCookie = "rpg_oauth_pending"
	oauthPath     = "/api/auth/oauth"
)

type oauthStartRequest struct {
	Return string `json:"return,omitempty"`
}

type oauthLinkRequest struct {
	Password string `json:"password,omitempty"`
}

type pendingConfirmRequest struct {
	Password string `json:"password"`
}

type pendingCreateRequest struct {
	Email string `json:"email"`
}

type unlinkRequest struct {
	Provider string `json:"provider"`
	// Password re-authenticates an account that has one (like oauthLinkRequest).
	Password string `json:"password,omitempty"`
}

type identityJSON struct {
	Provider string    `json:"provider"`
	Email    string    `json:"email"`
	LinkedAt time.Time `json:"linked_at"`
}

func (a *api) oauthRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/oauth/{provider}/start", a.rateLimited(a.oauthStart))
	mux.HandleFunc("POST /api/auth/oauth/{provider}/link", a.rateLimited(a.hashing(a.oauthLink)))
	mux.HandleFunc("GET /api/auth/oauth/{provider}/callback", a.rateLimited(a.oauthCallback))
	mux.HandleFunc("GET /api/auth/oauth/pending", a.tokenLimited(a.oauthPending))
	mux.HandleFunc("POST /api/auth/oauth/pending/confirm", a.rateLimited(a.hashing(a.pendingConfirm)))
	mux.HandleFunc("POST /api/auth/oauth/pending/create", a.rateLimited(a.pendingCreate))
	mux.HandleFunc("POST /api/account/unlink", a.rateLimited(a.hashing(a.unlink)))
}

func (a *api) oauthCookie(name, value string, maxAge int, same http.SameSite) *http.Cookie {
	return &http.Cookie{
		Name: name, Value: value, Path: oauthPath, MaxAge: maxAge,
		HttpOnly: true, Secure: a.cfg.CookieSecure, SameSite: same,
	}
}

func (a *api) clearOAuthCookie(w http.ResponseWriter, name string, same http.SameSite) {
	http.SetCookie(w, a.oauthCookie(name, "", -1, same))
}

func (a *api) writeStart(w http.ResponseWriter, st auth.OAuthStart) {
	http.SetCookie(w, a.oauthCookie(OAuthCookie, st.Binding, int(auth.OAuthStateTTL.Seconds()), http.SameSiteLaxMode))
	writeJSON(w, http.StatusOK, map[string]string{"url": st.URL})
}

func (a *api) oauthStart(w http.ResponseWriter, r *http.Request) {
	var in oauthStartRequest
	if !a.decode(w, r, &in) {
		return
	}
	st, err := a.cfg.Auth.StartLogin(r.Context(), r.PathValue("provider"), in.Return)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.writeStart(w, st)
}

func (a *api) oauthLink(w http.ResponseWriter, r *http.Request) {
	var in oauthLinkRequest
	if !a.decode(w, r, &in) {
		return
	}
	var st auth.OAuthStart
	if a.reauthed(w, r, in.Password, func(token string) error {
		var err error
		st, err = a.cfg.Auth.StartLink(r.Context(), token, r.PathValue("provider"), in.Password)
		return err
	}) {
		a.writeStart(w, st)
	}
}

// reauthed runs do (an action of the service that re-authenticates: StartLink, Unlink)
// with the request's session token. With a password it is a password check: under the
// same failed-login limits as /api/auth/login, keyed by the account's email (a stolen
// session cookie cannot guess the password faster). On false the response was written.
func (a *api) reauthed(w http.ResponseWriter, r *http.Request, password string, do func(token string) error) bool {
	token := requestToken(r)
	if password == "" {
		if err := do(token); err != nil {
			a.fail(w, r, err)
			return false
		}
		return true
	}
	// The lookups before the password check are short: bounded like the authed routes.
	ctx, cancel := context.WithTimeout(r.Context(), httpDBTimeout)
	defer cancel()
	id, err := a.cfg.Auth.Authenticate(ctx, token)
	if err != nil {
		a.fail(w, r, err)
		return false
	}
	p, err := a.cfg.Auth.Profile(ctx, id)
	if err != nil {
		a.fail(w, r, err)
		return false
	}
	_, ok := a.limitedLogin(w, r, p.Email, func() (auth.Token, error) {
		return auth.Token{}, do(token)
	})
	return ok
}

// oauthErrorCodes are the codes /oauth/error shows (site.oauth.error.<code>).
var oauthErrorCodes = []struct {
	err  error
	code string
}{
	{auth.ErrOAuthState, "state"},
	{auth.ErrOAuthDenied, "denied"},
	{auth.ErrOAuthProvider, "provider"},
	{auth.ErrNoEmail, "no_email"},
	{auth.ErrIdentityTaken, "identity_taken"},
	{auth.ErrProviderLinked, "provider_linked"},
	{auth.ErrUnknownProvider, "unknown_provider"},
	{auth.ErrAccountDisabled, "account_disabled"},
	{auth.ErrAccountBanned, "account_banned"},
	{auth.ErrEmailTaken, "email_taken"},
	{auth.ErrBusy, "busy"},
}

// oauthCallback ends at a page of the site whatever happens: the return path of the
// login (allowlisted when the login started), /account, /oauth/confirm or /oauth/error.
func (a *api) oauthCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	binding := ""
	if c, err := r.Cookie(OAuthCookie); err == nil {
		binding = c.Value
	}
	a.clearOAuthCookie(w, OAuthCookie, http.SameSiteLaxMode)
	provider := r.PathValue("provider")
	res, err := a.cfg.Auth.FinishOAuth(r.Context(), provider, q.Get("state"), q.Get("code"), q.Get("error"), binding)
	if err != nil {
		code := "internal"
		for _, e := range oauthErrorCodes {
			if errors.Is(err, e.err) {
				code = e.code
				break
			}
		}
		if code == "internal" || code == "provider" {
			// The error names the provider and the failed check, never a code or token.
			a.log.Warn("oauth callback failed", "provider", provider, "err", err)
		}
		redirect(w, "/oauth/error?code="+url.QueryEscape(code))
		return
	}
	switch res.Kind {
	case "login":
		http.SetCookie(w, a.cookie(res.Token.Token))
		redirect(w, auth.SafeReturn(res.ReturnTo))
	case "linked":
		redirect(w, "/account?linked="+url.QueryEscape(provider))
	default: // pending
		http.SetCookie(w, a.oauthCookie(PendingCookie, res.Pending, int(auth.OAuthPendingTTL.Seconds()), http.SameSiteStrictMode))
		redirect(w, "/oauth/confirm")
	}
}

// redirect answers 303 to a path of the site (always a constant or an allowlisted path).
func redirect(w http.ResponseWriter, path string) {
	w.Header().Set("Location", path)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusSeeOther)
}

func pendingToken(r *http.Request) string {
	if c, err := r.Cookie(PendingCookie); err == nil {
		return c.Value
	}
	return ""
}

func (a *api) oauthPending(w http.ResponseWriter, r *http.Request) {
	p, err := a.cfg.Auth.Pending(r.Context(), pendingToken(r))
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"provider": p.Provider, "email": p.Email, "has_password": p.HasPassword})
}

// pendingConfirm checks the password of the existing account under the same failed-login
// limits as /api/auth/login, then links and logs in.
func (a *api) pendingConfirm(w http.ResponseWriter, r *http.Request) {
	var in pendingConfirmRequest
	if !a.decode(w, r, &in) {
		return
	}
	token := pendingToken(r)
	p, err := a.cfg.Auth.Pending(r.Context(), token)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if !auth.ValidPassword(in.Password) {
		a.fail(w, r, auth.ErrInvalidCredentials)
		return
	}
	var ret string
	tok, ok := a.limitedLogin(w, r, p.Email, func() (auth.Token, error) {
		t, rt, err := a.cfg.Auth.ConfirmPending(r.Context(), token, in.Password)
		ret = rt
		return t, err
	})
	if !ok {
		return
	}
	a.finishPending(w, tok, ret)
}

func (a *api) pendingCreate(w http.ResponseWriter, r *http.Request) {
	var in pendingCreateRequest
	if !a.decode(w, r, &in) {
		return
	}
	tok, ret, err := a.cfg.Auth.CreateFromPending(r.Context(), pendingToken(r), in.Email)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	a.finishPending(w, tok, ret)
}

func (a *api) finishPending(w http.ResponseWriter, tok auth.Token, ret string) {
	a.clearOAuthCookie(w, PendingCookie, http.SameSiteStrictMode)
	http.SetCookie(w, a.cookie(tok.Token))
	writeJSON(w, http.StatusOK, map[string]string{"return": auth.SafeReturn(ret)})
}

// unlink needs the same re-authentication as a link (password, or a recent login for an
// account without one): 403 reauth_required otherwise.
func (a *api) unlink(w http.ResponseWriter, r *http.Request) {
	var in unlinkRequest
	if !a.decode(w, r, &in) {
		return
	}
	if a.reauthed(w, r, in.Password, func(token string) error {
		return a.cfg.Auth.Unlink(r.Context(), token, in.Provider, in.Password)
	}) {
		w.WriteHeader(http.StatusNoContent)
	}
}

// identitiesOf lists the account's identities for GET /api/account.
func (a *api) identitiesOf(ctx context.Context, accountID int64) ([]identityJSON, error) {
	ids, err := a.cfg.Auth.Identities(ctx, accountID)
	if err != nil {
		return nil, err
	}
	out := make([]identityJSON, len(ids))
	for i, id := range ids {
		out[i] = identityJSON{Provider: id.Provider, Email: id.Email, LinkedAt: id.CreatedAt.UTC()}
	}
	return out, nil
}
