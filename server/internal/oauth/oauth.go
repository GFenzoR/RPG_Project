// Package oauth talks to the OAuth 2.0 providers of T2.1: Google (OpenID Connect) and
// Discord. It builds the authorization URL (Authorization Code with PKCE S256, plus a
// nonce for Google), exchanges the code and returns the identity the provider vouches
// for. Google's identity comes from the id_token, whose signature is checked against
// Google's JWKS along with issuer, audience, expiry and nonce; Discord's from
// GET /users/@me. Accounts and sessions are auth's business, not this package's.
//
// Client secrets and tokens are never logged or put in errors.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Provider names (account_identities.provider).
const (
	Google  = "google"
	Discord = "discord"
)

// Errors of the provider round trip. None carries a token or a secret.
var (
	// ErrDenied: the user refused, or the provider answered the redirect with an error.
	ErrDenied = errors.New("oauth: denied at the provider")
	// ErrProvider: the provider could not be reached or answered something unexpected.
	ErrProvider = errors.New("oauth: provider error")
	// ErrInvalidToken: the id_token failed a check (signature, issuer, audience, expiry,
	// nonce).
	ErrInvalidToken = errors.New("oauth: invalid id_token")
)

// Identity is who the provider says the user is.
type Identity struct {
	Subject       string
	Email         string // may be empty (Discord without the email scope granted)
	EmailVerified bool   // the provider says the user owns Email
}

// Config configures a provider. Empty URLs take the provider's real endpoints; tests
// point them at a fake provider.
type Config struct {
	ClientID     string
	ClientSecret string
	AuthURL      string
	TokenURL     string
	// Google: JWKSURL and Issuer (the id_token's iss must match; the real Google also
	// accepts "accounts.google.com").
	JWKSURL string
	Issuer  string
	// Discord: the API base (GET <APIURL>/users/@me).
	APIURL string
	// HTTP is the client for the token, JWKS and user requests (default: 10 s timeout).
	HTTP *http.Client
}

// Provider is one configured provider. Safe for concurrent use.
type Provider struct {
	name   string
	cfg    Config
	scopes string
	keys   *jwks // Google only
}

// New builds a provider. name is Google or Discord.
func New(name string, cfg Config) (*Provider, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, fmt.Errorf("oauth: %s needs a client id and secret", name)
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 10 * time.Second}
	}
	p := &Provider{name: name, cfg: cfg}
	switch name {
	case Google:
		def(&p.cfg.AuthURL, "https://accounts.google.com/o/oauth2/v2/auth")
		def(&p.cfg.TokenURL, "https://oauth2.googleapis.com/token")
		def(&p.cfg.JWKSURL, "https://www.googleapis.com/oauth2/v3/certs")
		def(&p.cfg.Issuer, "https://accounts.google.com")
		p.scopes = "openid email"
		p.keys = &jwks{url: p.cfg.JWKSURL, client: p.cfg.HTTP}
	case Discord:
		def(&p.cfg.AuthURL, "https://discord.com/oauth2/authorize")
		def(&p.cfg.TokenURL, "https://discord.com/api/oauth2/token")
		def(&p.cfg.APIURL, "https://discord.com/api")
		p.scopes = "identify email"
	default:
		return nil, fmt.Errorf("oauth: unknown provider %q", name)
	}
	return p, nil
}

func def(s *string, v string) {
	if *s == "" {
		*s = v
	}
}

// Name returns the provider's name.
func (p *Provider) Name() string { return p.name }

// OIDC reports whether the provider uses a nonce (OpenID Connect).
func (p *Provider) OIDC() bool { return p.name == Google }

// RandomString returns n random bytes as base64url (state, verifier, nonce, cookies).
func RandomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("oauth: random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Challenge is the PKCE S256 challenge of a verifier.
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// AuthURL is where the browser goes to log in at the provider.
func (p *Provider) AuthURL(redirectURI, state, verifier, nonce string) string {
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {p.cfg.ClientID},
		"redirect_uri":          {redirectURI},
		"scope":                 {p.scopes},
		"state":                 {state},
		"code_challenge":        {Challenge(verifier)},
		"code_challenge_method": {"S256"},
	}
	if p.OIDC() {
		q.Set("nonce", nonce)
	}
	if p.name == Discord {
		q.Set("prompt", "consent")
	}
	sep := "?"
	if strings.Contains(p.cfg.AuthURL, "?") {
		sep = "&"
	}
	return p.cfg.AuthURL + sep + q.Encode()
}

const maxBody = 1 << 20

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	IDToken     string `json:"id_token"`
}

// Identity exchanges the code (with the PKCE verifier) and returns the identity. For
// Google the id_token must carry nonce.
func (p *Provider) Identity(ctx context.Context, code, verifier, redirectURI, nonce string, now time.Time) (Identity, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
		"client_id":     {p.cfg.ClientID},
		"client_secret": {p.cfg.ClientSecret},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Identity{}, fmt.Errorf("%w: token request", ErrProvider)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	var tok tokenResponse
	if err := p.doJSON(req, &tok); err != nil {
		return Identity{}, fmt.Errorf("token: %w", err)
	}
	if p.OIDC() {
		if tok.IDToken == "" {
			return Identity{}, fmt.Errorf("%w: no id_token", ErrProvider)
		}
		return p.verifyIDToken(ctx, tok.IDToken, nonce, now)
	}
	if tok.AccessToken == "" {
		return Identity{}, fmt.Errorf("%w: no access_token", ErrProvider)
	}
	return p.discordUser(ctx, tok.AccessToken)
}

// doJSON runs req and decodes a 2xx JSON answer into dst (at most maxBody bytes). The
// status goes in the error, never the body (it may echo a code or a token).
func (p *Provider) doJSON(req *http.Request, dst any) error {
	res, err := p.cfg.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %s unreachable", ErrProvider, p.name)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxBody))
		return fmt.Errorf("%w: %s answered %d", ErrProvider, p.name, res.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxBody)).Decode(dst); err != nil {
		return fmt.Errorf("%w: %s sent invalid JSON", ErrProvider, p.name)
	}
	return nil
}

type discordUser struct {
	ID       string  `json:"id"`
	Email    *string `json:"email"`
	Verified bool    `json:"verified"`
}

func (p *Provider) discordUser(ctx context.Context, accessToken string) (Identity, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(p.cfg.APIURL, "/")+"/users/@me", nil)
	if err != nil {
		return Identity{}, fmt.Errorf("%w: user request", ErrProvider)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	var u discordUser
	if err := p.doJSON(req, &u); err != nil {
		return Identity{}, fmt.Errorf("user: %w", err)
	}
	if u.ID == "" || len(u.ID) > 64 {
		return Identity{}, fmt.Errorf("%w: discord user without id", ErrProvider)
	}
	id := Identity{Subject: u.ID}
	if u.Email != nil {
		id.Email, id.EmailVerified = *u.Email, u.Verified
	}
	return id, nil
}
