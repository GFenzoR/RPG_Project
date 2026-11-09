package oauth

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Accepted clock difference with the provider for exp and iat.
const clockSkew = 2 * time.Minute

// JWKS cache: keys are refetched after jwksMaxAge, or when an unknown kid shows up (at
// most once per jwksMinRefetch, so forged kids cannot hammer the provider).
const (
	jwksMaxAge     = time.Hour
	jwksMinRefetch = time.Minute
	// jwksFetchTimeout bounds the shared fetch (it ignores the cancellation of the login
	// that started it).
	jwksFetchTimeout = 10 * time.Second
)

type jwks struct {
	url    string
	client *http.Client

	// mu guards the fields below; it is never held during the HTTP fetch, so a slow
	// provider does not block logins whose key is cached.
	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time // last successful fetch
	tried   time.Time // last attempt, failed or not
	// call is the fetch in flight (nil = none): concurrent misses wait for it instead of
	// starting their own.
	call *jwksCall
}

// jwksCall is one fetch in flight; done is closed when err is set.
type jwksCall struct {
	done chan struct{}
	err  error
}

type jwkSet struct {
	Keys []struct {
		Kty string `json:"kty"`
		Kid string `json:"kid"`
		Alg string `json:"alg"`
		Use string `json:"use"`
		N   string `json:"n"`
		E   string `json:"e"`
	} `json:"keys"`
}

// key returns the RSA key kid, fetching the set when it is stale or lacks kid.
func (j *jwks) key(ctx context.Context, kid string, now time.Time) (*rsa.PublicKey, error) {
	j.mu.Lock()
	k, ok := j.keys[kid]
	stale := j.keys == nil || now.Sub(j.fetched) > jwksMaxAge
	if ok && !stale {
		j.mu.Unlock()
		return k, nil
	}
	c := j.call
	switch {
	case c != nil && ok: // stale but known, and someone is fetching: use it meanwhile
		j.mu.Unlock()
		return k, nil
	case c != nil: // someone is fetching: wait for that fetch
		j.mu.Unlock()
		select {
		case <-c.done:
		case <-ctx.Done():
			if ok {
				return k, nil
			}
			return nil, fmt.Errorf("%w: jwks: %w", ErrProvider, ctx.Err())
		}
	case !j.tried.IsZero() && now.Sub(j.tried) < jwksMinRefetch:
		j.mu.Unlock()
		if ok { // stale but known: keep it until the next allowed fetch
			return k, nil
		}
		return nil, fmt.Errorf("%w: unknown key", ErrInvalidToken)
	default: // fetch without the lock
		c = &jwksCall{done: make(chan struct{})}
		j.tried, j.call = now, c
		j.mu.Unlock()
		// Shared by every waiter: the starter's cancellation must not fail them all, so
		// the fetch has its own deadline instead.
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), jwksFetchTimeout)
		keys, err := j.fetch(fctx)
		cancel()
		j.mu.Lock()
		if err == nil {
			j.keys, j.fetched = keys, now
		}
		c.err, j.call = err, nil
		j.mu.Unlock()
		close(c.done)
	}
	if c.err != nil {
		if ok { // keep using a known key while the provider is unreachable
			return k, nil
		}
		return nil, c.err
	}
	j.mu.Lock()
	k, ok = j.keys[kid]
	j.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("%w: unknown key", ErrInvalidToken)
	}
	return k, nil
}

func (j *jwks) fetch(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, j.url, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: jwks request", ErrProvider)
	}
	var set jwkSet
	p := &Provider{name: "jwks", cfg: Config{HTTP: j.client}}
	if err := p.doJSON(req, &set); err != nil {
		return nil, fmt.Errorf("jwks: %w", err)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" || k.Kid == "" || (k.Alg != "" && k.Alg != "RS256") || (k.Use != "" && k.Use != "sig") {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(k.N)
		e, errE := base64.RawURLEncoding.DecodeString(k.E)
		if errN != nil || errE != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		pub := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
		if pub.N.BitLen() < 2048 {
			continue
		}
		keys[k.Kid] = pub
	}
	return keys, nil
}

type idClaims struct {
	Iss           string          `json:"iss"`
	Sub           string          `json:"sub"`
	Aud           json.RawMessage `json:"aud"`
	Exp           int64           `json:"exp"`
	Iat           int64           `json:"iat"`
	Nonce         string          `json:"nonce"`
	Email         string          `json:"email"`
	EmailVerified json.RawMessage `json:"email_verified"`
}

// verifyIDToken checks an RS256 id_token: signature (JWKS), issuer, audience (our client
// id), expiry, issue time and nonce. Only then is its subject trusted.
func (p *Provider) verifyIDToken(ctx context.Context, raw, nonce string, now time.Time) (Identity, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return Identity{}, fmt.Errorf("%w: malformed", ErrInvalidToken)
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := decodeSegment(parts[0], &hdr); err != nil || hdr.Alg != "RS256" {
		return Identity{}, fmt.Errorf("%w: header", ErrInvalidToken)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Identity{}, fmt.Errorf("%w: signature encoding", ErrInvalidToken)
	}
	key, err := p.keys.key(ctx, hdr.Kid, now)
	if err != nil {
		return Identity{}, err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig); err != nil {
		return Identity{}, fmt.Errorf("%w: signature", ErrInvalidToken)
	}
	var c idClaims
	if err := decodeSegment(parts[1], &c); err != nil {
		return Identity{}, fmt.Errorf("%w: claims", ErrInvalidToken)
	}
	issuers := []string{p.cfg.Issuer}
	if p.cfg.Issuer == "https://accounts.google.com" {
		issuers = append(issuers, "accounts.google.com")
	}
	switch {
	case !contains(issuers, c.Iss):
		return Identity{}, fmt.Errorf("%w: issuer", ErrInvalidToken)
	case !audienceHas(c.Aud, p.cfg.ClientID):
		return Identity{}, fmt.Errorf("%w: audience", ErrInvalidToken)
	case c.Exp == 0 || now.After(time.Unix(c.Exp, 0).Add(clockSkew)):
		return Identity{}, fmt.Errorf("%w: expired", ErrInvalidToken)
	case c.Iat != 0 && time.Unix(c.Iat, 0).After(now.Add(clockSkew)):
		return Identity{}, fmt.Errorf("%w: issued in the future", ErrInvalidToken)
	case nonce == "" || c.Nonce != nonce:
		return Identity{}, fmt.Errorf("%w: nonce", ErrInvalidToken)
	case c.Sub == "" || len(c.Sub) > 255:
		return Identity{}, fmt.Errorf("%w: subject", ErrInvalidToken)
	}
	verified := string(c.EmailVerified) == "true" || string(c.EmailVerified) == `"true"`
	return Identity{Subject: c.Sub, Email: c.Email, EmailVerified: verified && c.Email != ""}, nil
}

func decodeSegment(seg string, dst any) error {
	b, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// audienceHas accepts aud as a string or an array of strings.
func audienceHas(raw json.RawMessage, clientID string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == clientID
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		return contains(many, clientID)
	}
	return false
}
