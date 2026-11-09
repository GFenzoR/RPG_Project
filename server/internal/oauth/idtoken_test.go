package oauth

import (
	"context"
	"errors"
	"net/http/httptest"
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
