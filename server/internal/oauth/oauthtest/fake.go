// Package oauthtest is a fake OAuth provider for tests and the E2E suite (T2.1): one
// HTTP handler that plays Google (OpenID Connect, signed id_token, JWKS) under /google
// and Discord (/users/@me) under /discord. It checks what a real provider checks: client
// credentials, redirect_uri, PKCE S256, single-use codes. Who logs in next is set with
// SetNext (or POST /test/next from the E2E). Never used in production.
package oauthtest

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// User is the identity the fake answers with on the next authorization.
type User struct {
	Subject  string `json:"sub"`
	Email    string `json:"email"`
	Verified bool   `json:"verified"`
	// Deny makes the authorization answer error=access_denied.
	Deny bool `json:"deny"`
}

// Credentials of the fake's single client.
const (
	ClientID     = "fake-client-id"
	ClientSecret = "fake-client-secret"
)

type grant struct {
	provider, redirectURI, challenge, nonce string
	user                                    User
}

// Fake is the provider. Base must be set to its public URL (the issuer of id_tokens).
type Fake struct {
	Base string
	key  *rsa.PrivateKey

	mu     sync.Mutex
	next   map[string]User // per provider
	codes  map[string]grant
	tokens map[string]User
	// Now is the time of issued id_tokens (default time.Now). Tests can pin it.
	Now func() time.Time
	// Tamper, if set, edits the id_token claims before signing (tests of the checks).
	Tamper func(claims map[string]any)
}

// New returns a fake with a fresh 2048-bit signing key.
func New() *Fake {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err) //nolint:forbidigo // test helper: no key, no fake
	}
	return &Fake{key: k, next: map[string]User{}, codes: map[string]grant{}, tokens: map[string]User{},
		Now: time.Now} //nolint:forbidigo // id_tokens of the fake carry real time by default
}

// SetNext sets who logs in on the next authorization of provider.
func (f *Fake) SetNext(provider string, u User) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next[provider] = u
}

// Issuer is the iss of the fake Google id_tokens.
func (f *Fake) Issuer() string { return f.Base + "/google" }

// ServeHTTP implements http.Handler.
func (f *Fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case r.Method == http.MethodPost && path == "/test/next":
		var in struct {
			Provider string `json:"provider"`
			User
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		f.SetNext(in.Provider, in.User)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodGet && (path == "/google/authorize" || path == "/discord/authorize"):
		f.authorize(w, r, strings.Split(path, "/")[1])
	case r.Method == http.MethodPost && (path == "/google/token" || path == "/discord/token"):
		f.token(w, r, strings.Split(path, "/")[1])
	case r.Method == http.MethodGet && path == "/google/jwks":
		f.jwks(w)
	case r.Method == http.MethodGet && path == "/discord/api/users/@me":
		f.me(w, r)
	case path == "/":
		w.WriteHeader(http.StatusOK)
	default:
		http.NotFound(w, r)
	}
}

func random() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (f *Fake) authorize(w http.ResponseWriter, r *http.Request, provider string) {
	q := r.URL.Query()
	redirect := q.Get("redirect_uri")
	if q.Get("client_id") != ClientID || redirect == "" || q.Get("response_type") != "code" ||
		q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("state") == "" ||
		(provider == "google" && q.Get("nonce") == "") {
		http.Error(w, "invalid authorization request", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	u, ok := f.next[provider]
	f.mu.Unlock()
	back, _ := url.Parse(redirect)
	v := back.Query()
	v.Set("state", q.Get("state"))
	if !ok || u.Deny {
		v.Set("error", "access_denied")
	} else {
		code := random()
		f.mu.Lock()
		f.codes[code] = grant{provider: provider, redirectURI: redirect, challenge: q.Get("code_challenge"), nonce: q.Get("nonce"), user: u}
		f.mu.Unlock()
		v.Set("code", code)
	}
	back.RawQuery = v.Encode()
	http.Redirect(w, r, back.String(), http.StatusFound)
}

func (f *Fake) token(w http.ResponseWriter, r *http.Request, provider string) {
	if r.ParseForm() != nil || r.PostForm.Get("client_id") != ClientID || r.PostForm.Get("client_secret") != ClientSecret ||
		r.PostForm.Get("grant_type") != "authorization_code" {
		http.Error(w, `{"error":"invalid_client"}`, http.StatusUnauthorized)
		return
	}
	code := r.PostForm.Get("code")
	f.mu.Lock()
	g, ok := f.codes[code]
	delete(f.codes, code) // single use
	f.mu.Unlock()
	sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	if !ok || g.provider != provider || g.redirectURI != r.PostForm.Get("redirect_uri") ||
		base64.RawURLEncoding.EncodeToString(sum[:]) != g.challenge {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
		return
	}
	access := random()
	f.mu.Lock()
	f.tokens[access] = g.user
	f.mu.Unlock()
	out := map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": 3600}
	if provider == "google" {
		now := f.Now()
		claims := map[string]any{
			"iss": f.Issuer(), "sub": g.user.Subject, "aud": ClientID, "nonce": g.nonce,
			"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
			"email": g.user.Email, "email_verified": g.user.Verified,
		}
		if f.Tamper != nil {
			f.Tamper(claims)
		}
		out["id_token"] = f.Sign(claims)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// Sign returns an RS256 JWT of claims signed with the fake's key (kid "fake-1").
func (f *Fake) Sign(claims map[string]any) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	signing := enc(map[string]string{"alg": "RS256", "kid": "fake-1", "typ": "JWT"}) + "." + enc(claims)
	digest := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, digest[:])
	if err != nil {
		panic(err) //nolint:forbidigo // test helper
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func (f *Fake) jwks(w http.ResponseWriter) {
	pub := f.key.PublicKey
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "kid": "fake-1", "alg": "RS256", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}}})
}

func (f *Fake) me(w http.ResponseWriter, r *http.Request) {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	f.mu.Lock()
	u, known := f.tokens[tok]
	f.mu.Unlock()
	if !ok || !known {
		http.Error(w, `{"message":"401: Unauthorized"}`, http.StatusUnauthorized)
		return
	}
	var email any
	if u.Email != "" {
		email = u.Email
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"id": u.Subject, "username": "fake", "email": email, "verified": u.Verified})
}

// Endpoints returns the env-style URL overrides that point a server at this fake.
func (f *Fake) Endpoints() map[string]string {
	return map[string]string{
		"GOOGLE_AUTH_URL": f.Base + "/google/authorize", "GOOGLE_TOKEN_URL": f.Base + "/google/token",
		"GOOGLE_JWKS_URL": f.Base + "/google/jwks", "GOOGLE_ISSUER": f.Issuer(),
		"DISCORD_AUTH_URL": f.Base + "/discord/authorize", "DISCORD_TOKEN_URL": f.Base + "/discord/token",
		"DISCORD_API_URL": f.Base + "/discord/api",
	}
}
