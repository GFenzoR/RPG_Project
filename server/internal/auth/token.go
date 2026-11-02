package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

const tokenBytes = 32

// newToken returns a random opaque token (base64url, 43 chars) and its SHA-256, which is
// what the database stores.
func newToken() (token string, hash []byte, err error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", nil, fmt.Errorf("token: %w", err)
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, hashToken(token), nil
}

// hashToken returns the SHA-256 of a token. A fast hash is fine: tokens have 256 bits
// of entropy, so they cannot be brute-forced like passwords.
func hashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
