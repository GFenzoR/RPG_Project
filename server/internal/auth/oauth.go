package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/oauth"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// OAuth login with Google and Discord, and linked identities (T2.1 2/2,
// docs/01-architecture.md "Cuentas", docs/05 "OAuth").
//
// Account takeover rules:
//   - an identity already linked logs into its account;
//   - an identity that is not linked but reports the email of an existing account is
//     never linked on its own: its user must prove that account's password, or create
//     another account (with another email);
//   - otherwise a new account is created, and its email is verified only if the provider
//     says the user owns it;
//   - linking from "My account" needs a recent re-authentication, and the last way to log
//     in (password or identity) cannot be unlinked.

// Errors of the OAuth flows.
var (
	ErrUnknownProvider = errors.New("auth: provider not configured")
	// ErrOAuthState: unknown, expired or reused state, or a state started in another
	// browser (its cookie does not match).
	ErrOAuthState = errors.New("auth: invalid oauth state")
	// ErrOAuthDenied: the user refused at the provider.
	ErrOAuthDenied = errors.New("auth: denied at the provider")
	// ErrOAuthProvider: the provider failed or sent something that did not check out.
	ErrOAuthProvider = errors.New("auth: provider error")
	// ErrNoEmail: the provider gave no usable email for a new account.
	ErrNoEmail = errors.New("auth: the provider gave no email")
	// ErrIdentityTaken: the identity is linked to another account.
	ErrIdentityTaken = errors.New("auth: identity linked to another account")
	// ErrProviderLinked: the account already has an identity of that provider.
	ErrProviderLinked = errors.New("auth: provider already linked")
	// ErrLastLoginMethod: unlinking would leave the account without a way in.
	ErrLastLoginMethod = errors.New("auth: last login method")
	// ErrReauthRequired: linking needs the password, or a login of the last few minutes.
	ErrReauthRequired = errors.New("auth: recent login required")
	// ErrNotLinked: the account has no identity of that provider.
	ErrNotLinked = errors.New("auth: provider not linked")
	// ErrPendingExpired: the pending identity is gone (used, expired or never existed).
	ErrPendingExpired = errors.New("auth: pending identity expired")
)

// Lifetimes of the OAuth flows (docs/05).
const (
	OAuthStateTTL   = 10 * time.Minute
	OAuthPendingTTL = 15 * time.Minute
	// ReauthWindow: an account without a password may link a provider this long after
	// logging in (accounts with a password type it again instead).
	ReauthWindow = 10 * time.Minute
)

// returnPaths are the only places a login may send the browser back to (no open
// redirect). DefaultReturn is used for anything else.
var returnPaths = map[string]bool{
	"/": true, "/play/": true, "/account": true, "/maps/submit": true, "/maps/mine": true,
}

// DefaultReturn is where a login without a valid return path lands.
const DefaultReturn = "/play/"

// SafeReturn returns path if it is an allowed return path, else DefaultReturn.
func SafeReturn(path string) string {
	if returnPaths[path] {
		return path
	}
	return DefaultReturn
}

// OAuthRepo is the persistence of the OAuth flows. *store.Store implements it.
type OAuthRepo interface {
	CreateOAuthState(ctx context.Context, st store.OAuthState) error
	ConsumeOAuthState(ctx context.Context, stateHash []byte, now time.Time) (store.OAuthState, error)
	IdentityAccount(ctx context.Context, provider, subject string) (int64, error)
	LinkIdentity(ctx context.Context, accountID int64, id store.ExternalIdentity, at time.Time) error
	CreateOAuthAccount(ctx context.Context, email string, verified bool, id store.ExternalIdentity, at time.Time) (int64, error)
	Identities(ctx context.Context, accountID int64) ([]store.Identity, error)
	UnlinkIdentity(ctx context.Context, accountID int64, provider string, at time.Time) error
	CreateOAuthPending(ctx context.Context, tokenHash []byte, p store.OAuthPending, expires time.Time) error
	OAuthPendingByToken(ctx context.Context, tokenHash []byte, now time.Time) (store.OAuthPending, error)
	DeleteOAuthPending(ctx context.Context, tokenHash []byte) error
	DeleteExpiredOAuth(ctx context.Context, now time.Time) (int64, error)
}

// Providers returns the configured providers' names, sorted.
func (s *Service) Providers() []string {
	out := make([]string, 0, len(s.providers))
	for name := range s.providers {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func (s *Service) callbackURL(provider string) string {
	return s.publicURL + "/api/auth/oauth/" + provider + "/callback"
}

// OAuthStart is where to send the browser and the value of its binding cookie.
type OAuthStart struct {
	URL     string
	Binding string
}

// StartLogin begins a login with provider; the browser lands on returnTo (allowlisted)
// afterwards.
func (s *Service) StartLogin(ctx context.Context, provider, returnTo string) (OAuthStart, error) {
	return s.start(ctx, provider, "login", 0, SafeReturn(returnTo))
}

// StartLink begins linking provider to the account of the session token. It needs a
// recent re-authentication: the account's password, or, for an account without one, a
// session created less than ReauthWindow ago.
func (s *Service) StartLink(ctx context.Context, token, provider, password string) (OAuthStart, error) {
	if _, ok := s.providers[provider]; !ok {
		return OAuthStart{}, ErrUnknownProvider
	}
	if token == "" || len(token) > 128 {
		return OAuthStart{}, ErrUnauthorized
	}
	now := s.clock.Now()
	sess, err := s.repo.ActiveSession(ctx, hashToken(token), store.SessionAccount, now)
	if errors.Is(err, store.ErrNotFound) {
		return OAuthStart{}, ErrUnauthorized
	}
	if err != nil {
		return OAuthStart{}, fmt.Errorf("start link: %w", err)
	}
	p, err := s.Profile(ctx, sess.AccountID)
	if err != nil {
		return OAuthStart{}, err
	}
	if p.HasPassword {
		if err := s.checkPassword(ctx, p.Email, password); err != nil {
			return OAuthStart{}, err
		}
	} else if now.Sub(sess.CreatedAt) > ReauthWindow {
		return OAuthStart{}, ErrReauthRequired
	}
	return s.start(ctx, provider, "link", sess.AccountID, "/account")
}

// checkPassword verifies the password of the account with email: ErrReauthRequired if it
// is missing, ErrInvalidCredentials if it does not match (the HTTP API counts those under
// the failed-login limits, like a login).
func (s *Service) checkPassword(ctx context.Context, email, password string) error {
	if password == "" {
		return ErrReauthRequired
	}
	if !ValidPassword(password) {
		return ErrInvalidCredentials
	}
	acc, err := s.repo.AccountByEmail(ctx, email)
	if err != nil {
		return fmt.Errorf("check password: %w", err)
	}
	var match bool
	err = s.withHashSlot(ctx, func() error {
		var err error
		match, err = verifyPassword(password, acc.PasswordHash)
		return err
	})
	if err != nil {
		return err
	}
	if !match {
		return ErrInvalidCredentials
	}
	return nil
}

func (s *Service) start(ctx context.Context, provider, mode string, accountID int64, returnTo string) (OAuthStart, error) {
	p, ok := s.providers[provider]
	if !ok {
		return OAuthStart{}, ErrUnknownProvider
	}
	var vals [4]string
	for i := range vals {
		v, err := oauth.RandomString(32)
		if err != nil {
			return OAuthStart{}, err
		}
		vals[i] = v
	}
	state, binding, verifier, nonce := vals[0], vals[1], vals[2], vals[3]
	if !p.OIDC() {
		nonce = ""
	}
	if err := s.oauthRepo.CreateOAuthState(ctx, store.OAuthState{
		StateHash: hashToken(state), BindingHash: hashToken(binding), Provider: provider,
		Verifier: verifier, Nonce: nonce, Mode: mode, AccountID: accountID, ReturnTo: returnTo,
		ExpiresAt: s.clock.Now().Add(OAuthStateTTL),
	}); err != nil {
		return OAuthStart{}, fmt.Errorf("start oauth: %w", err)
	}
	return OAuthStart{URL: p.AuthURL(s.callbackURL(provider), state, verifier, nonce), Binding: binding}, nil
}

// OAuthResult is how a callback ended.
type OAuthResult struct {
	// Kind: "login" (Token is a new account session), "linked" (the identity was linked
	// to the account that started) or "pending" (Pending is the token of the choice
	// between proving the existing account's password and creating another account).
	Kind     string
	Token    Token
	Pending  string
	ReturnTo string
}

// FinishOAuth handles the provider's redirect. The state is consumed first, so it works
// once whatever happens next. providerError is the redirect's error parameter.
func (s *Service) FinishOAuth(ctx context.Context, provider, state, code, providerError, binding string) (OAuthResult, error) {
	if len(state) > 128 || len(binding) > 128 || len(code) > 2048 {
		return OAuthResult{}, ErrOAuthState
	}
	now := s.clock.Now()
	st, err := s.oauthRepo.ConsumeOAuthState(ctx, hashToken(state), now)
	if errors.Is(err, store.ErrNotFound) {
		return OAuthResult{}, ErrOAuthState
	}
	if err != nil {
		return OAuthResult{}, fmt.Errorf("oauth callback: %w", err)
	}
	if binding == "" || subtle.ConstantTimeCompare(hashToken(binding), st.BindingHash) != 1 || st.Provider != provider {
		return OAuthResult{}, ErrOAuthState
	}
	if providerError != "" {
		return OAuthResult{}, ErrOAuthDenied
	}
	p, ok := s.providers[provider]
	if !ok {
		return OAuthResult{}, ErrUnknownProvider
	}
	if code == "" {
		return OAuthResult{}, ErrOAuthProvider
	}
	ident, err := p.Identity(ctx, code, st.Verifier, s.callbackURL(provider), st.Nonce, now)
	if err != nil {
		// Logged by the caller; the error names no token.
		return OAuthResult{}, fmt.Errorf("%w: %w", ErrOAuthProvider, err)
	}
	ext := store.ExternalIdentity{Provider: provider, Subject: ident.Subject, EmailVerified: ident.EmailVerified}
	if e, ok := NormalizeEmail(ident.Email); ok {
		ext.Email = e
	} else {
		ext.EmailVerified = false
	}
	if st.Mode == "link" {
		return s.finishLink(ctx, st, ext)
	}
	return s.finishLogin(ctx, ext, st.ReturnTo)
}

func (s *Service) finishLink(ctx context.Context, st store.OAuthState, ext store.ExternalIdentity) (OAuthResult, error) {
	res := OAuthResult{Kind: "linked", ReturnTo: st.ReturnTo}
	switch owner, err := s.oauthRepo.IdentityAccount(ctx, ext.Provider, ext.Subject); {
	case err == nil && owner == st.AccountID:
		return res, nil // already linked: nothing to do
	case err == nil:
		return OAuthResult{}, ErrIdentityTaken
	case !errors.Is(err, store.ErrNotFound):
		return OAuthResult{}, fmt.Errorf("link: %w", err)
	}
	p, err := s.Profile(ctx, st.AccountID)
	if err != nil {
		return OAuthResult{}, err
	}
	if p.Disabled {
		return OAuthResult{}, ErrAccountDisabled
	}
	if err := s.oauthRepo.LinkIdentity(ctx, st.AccountID, ext, s.clock.Now()); err != nil {
		return OAuthResult{}, identityErr(err)
	}
	return res, nil
}

func identityErr(err error) error {
	switch {
	case errors.Is(err, store.ErrIdentityTaken):
		return ErrIdentityTaken
	case errors.Is(err, store.ErrProviderLinked):
		return ErrProviderLinked
	case errors.Is(err, store.ErrEmailTaken):
		return ErrEmailTaken
	}
	return err
}

func (s *Service) finishLogin(ctx context.Context, ext store.ExternalIdentity, returnTo string) (OAuthResult, error) {
	owner, err := s.oauthRepo.IdentityAccount(ctx, ext.Provider, ext.Subject)
	if err == nil {
		tok, err := s.loginAccount(ctx, owner)
		if err != nil {
			return OAuthResult{}, err
		}
		return OAuthResult{Kind: "login", Token: tok, ReturnTo: returnTo}, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return OAuthResult{}, fmt.Errorf("oauth login: %w", err)
	}
	if ext.Email == "" {
		return OAuthResult{}, ErrNoEmail
	}
	switch _, err := s.repo.AccountByEmail(ctx, ext.Email); {
	case err == nil:
		// Never linked on its own: whoever controls this provider account may not own
		// the game account with the same email.
		token, hash, err := newToken()
		if err != nil {
			return OAuthResult{}, err
		}
		if err := s.oauthRepo.CreateOAuthPending(ctx, hash, store.OAuthPending{Identity: ext, ReturnTo: returnTo},
			s.clock.Now().Add(OAuthPendingTTL)); err != nil {
			return OAuthResult{}, fmt.Errorf("oauth pending: %w", err)
		}
		return OAuthResult{Kind: "pending", Pending: token, ReturnTo: returnTo}, nil
	case !errors.Is(err, store.ErrNotFound):
		return OAuthResult{}, fmt.Errorf("oauth login: %w", err)
	}
	id, err := s.oauthRepo.CreateOAuthAccount(ctx, ext.Email, ext.EmailVerified, ext, s.clock.Now())
	if err != nil {
		return OAuthResult{}, identityErr(err)
	}
	tok, err := s.loginAccount(ctx, id)
	if err != nil {
		return OAuthResult{}, err
	}
	return OAuthResult{Kind: "login", Token: tok, ReturnTo: returnTo}, nil
}

// PendingIdentity is what the confirmation page shows.
type PendingIdentity struct {
	Provider string
	Email    string
	// HasPassword: the existing account has a password to prove. Without one (an
	// OAuth-only account) its owner links the new provider from "My account" instead.
	HasPassword bool
}

func (s *Service) pending(ctx context.Context, token string) (store.OAuthPending, []byte, error) {
	if token == "" || len(token) > 128 {
		return store.OAuthPending{}, nil, ErrPendingExpired
	}
	hash := hashToken(token)
	p, err := s.oauthRepo.OAuthPendingByToken(ctx, hash, s.clock.Now())
	if errors.Is(err, store.ErrNotFound) {
		return store.OAuthPending{}, nil, ErrPendingExpired
	}
	if err != nil {
		return store.OAuthPending{}, nil, fmt.Errorf("oauth pending: %w", err)
	}
	return p, hash, nil
}

// Pending returns the pending identity of token (the confirmation page).
func (s *Service) Pending(ctx context.Context, token string) (PendingIdentity, error) {
	p, _, err := s.pending(ctx, token)
	if err != nil {
		return PendingIdentity{}, err
	}
	acc, err := s.repo.AccountByEmail(ctx, p.Identity.Email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return PendingIdentity{}, fmt.Errorf("oauth pending: %w", err)
	}
	return PendingIdentity{Provider: p.Identity.Provider, Email: p.Identity.Email, HasPassword: acc.PasswordHash != ""}, nil
}

// ConfirmPending links the pending identity to the existing account with its email,
// after checking that account's password like a login does (same errors, same rate
// limits in the HTTP API), and logs in.
func (s *Service) ConfirmPending(ctx context.Context, token, password string) (Token, string, error) {
	p, hash, err := s.pending(ctx, token)
	if err != nil {
		return Token{}, "", err
	}
	tok, err := s.Login(ctx, p.Identity.Email, password)
	if err != nil {
		return Token{}, "", err
	}
	if err := s.oauthRepo.LinkIdentity(ctx, tok.AccountID, p.Identity, s.clock.Now()); err != nil {
		_ = s.Logout(ctx, tok.Token)
		return Token{}, "", identityErr(err)
	}
	if err := s.oauthRepo.DeleteOAuthPending(ctx, hash); err != nil {
		return Token{}, "", err
	}
	return tok, p.ReturnTo, nil
}

// CreateFromPending creates a new account for the pending identity with another email
// (the provider's belongs to an existing account), unverified, and logs in.
func (s *Service) CreateFromPending(ctx context.Context, token, email string) (Token, string, error) {
	p, hash, err := s.pending(ctx, token)
	if err != nil {
		return Token{}, "", err
	}
	email, ok := NormalizeEmail(email)
	if !ok {
		return Token{}, "", ErrInvalidEmail
	}
	id, err := s.oauthRepo.CreateOAuthAccount(ctx, email, false, p.Identity, s.clock.Now())
	if err != nil {
		return Token{}, "", identityErr(err)
	}
	if err := s.oauthRepo.DeleteOAuthPending(ctx, hash); err != nil {
		return Token{}, "", err
	}
	tok, err := s.loginAccount(ctx, id)
	if err != nil {
		return Token{}, "", err
	}
	return tok, p.ReturnTo, nil
}

// Identities lists the account's linked identities.
func (s *Service) Identities(ctx context.Context, accountID int64) ([]store.Identity, error) {
	if s.oauthRepo == nil {
		return nil, nil
	}
	ids, err := s.oauthRepo.Identities(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("identities: %w", err)
	}
	return ids, nil
}

// Unlink removes the account's identity of provider unless it is the last way in.
func (s *Service) Unlink(ctx context.Context, accountID int64, provider string) error {
	if s.oauthRepo == nil {
		return ErrNotLinked
	}
	err := s.oauthRepo.UnlinkIdentity(ctx, accountID, provider, s.clock.Now())
	switch {
	case errors.Is(err, store.ErrLastLoginMethod):
		return ErrLastLoginMethod
	case errors.Is(err, store.ErrNotFound):
		return ErrNotLinked
	case err != nil:
		return fmt.Errorf("unlink: %w", err)
	}
	return nil
}
