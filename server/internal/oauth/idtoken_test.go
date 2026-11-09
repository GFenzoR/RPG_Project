package oauth

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/oauth/oauthtest"
)

// A token signed with a key the JWKS does not have (a forger's) never passes, whatever
// its claims say.
func TestIDTokenSignedByAnotherKey(t *testing.T) {
	real, forger := oauthtest.New(), oauthtest.New()
	srv := httptest.NewServer(real)
	defer srv.Close()
	real.Base = srv.URL
	p, err := New(Google, Config{ClientID: oauthtest.ClientID, ClientSecret: "x", JWKSURL: srv.URL + "/google/jwks", Issuer: real.Issuer()})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now() //nolint:forbidigo // wall clock only for the claims of this test
	claims := map[string]any{"iss": real.Issuer(), "aud": oauthtest.ClientID, "sub": "x", "nonce": "n",
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
	if _, err := p.verifyIDToken(context.Background(), real.Sign(claims), "n", now); err != nil {
		t.Fatalf("genuine token: %v", err)
	}
	if _, err := p.verifyIDToken(context.Background(), forger.Sign(claims), "n", now); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("forged token: %v", err)
	}
	if _, err := p.verifyIDToken(context.Background(), "e30.e30.", "n", now); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("alg none: %v", err)
	}
}

func TestIDTokenHeaderKidAndAudience(t *testing.T) {
	f := oauthtest.New()
	srv := httptest.NewServer(f)
	defer srv.Close()
	f.Base = srv.URL
	p, _ := New(Google, Config{ClientID: oauthtest.ClientID, ClientSecret: "x", JWKSURL: srv.URL + "/google/jwks", Issuer: f.Issuer()})
	now := time.Now() //nolint:forbidigo // wall clock only for the claims of this test
	claims := map[string]any{"iss": f.Issuer(), "aud": []string{"other", oauthtest.ClientID}, "sub": "x", "nonce": "n",
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
	good := f.Sign(claims)
	if _, err := p.verifyIDToken(context.Background(), good, "n", now); err != nil {
		t.Fatalf("aud as an array: %v", err)
	}
	parts := strings.Split(good, ".")
	enc := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for name, hdr := range map[string]string{
		"none":        `{"alg":"none","kid":"fake-1"}`,
		"HS256":       `{"alg":"HS256","kid":"fake-1"}`,
		"unknown kid": `{"alg":"RS256","kid":"nope"}`,
	} {
		tok := enc(hdr) + "." + parts[1] + "." + parts[2]
		if _, err := p.verifyIDToken(context.Background(), tok, "n", now); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}
