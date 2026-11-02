package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// HashParams are the argon2id cost parameters.
type HashParams struct {
	MemoryKiB uint32
	Time      uint32
	Threads   uint8
}

// DefaultHashParams follow the OWASP baseline for argon2id (19 MiB, 2 passes, 1 lane),
// which keeps a burst of logins affordable on a small instance.
var DefaultHashParams = HashParams{MemoryKiB: 19 * 1024, Time: 2, Threads: 1}

const (
	saltLen = 16
	keyLen  = 32
)

var errBadHash = errors.New("auth: malformed password hash")

// hashPassword returns an argon2id PHC string: $argon2id$v=19$m=..,t=..,p=..$salt$key.
func hashPassword(password string, p HashParams) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, p.Time, p.MemoryKiB, p.Threads, keyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.MemoryKiB, p.Time, p.Threads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// verifyPassword checks password against a PHC string produced by hashPassword. The
// parameters stored in the hash are used, so changing DefaultHashParams keeps old
// hashes valid.
func verifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return false, errBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errBadHash
	}
	var p HashParams
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.MemoryKiB, &p.Time, &p.Threads); err != nil {
		return false, errBadHash
	}
	if p.MemoryKiB == 0 || p.Time == 0 || p.Threads == 0 || p.MemoryKiB > 1<<20 || p.Time > 16 {
		return false, errBadHash
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, errBadHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) == 0 || len(want) > 128 {
		return false, errBadHash
	}
	got := argon2.IDKey([]byte(password), salt, p.Time, p.MemoryKiB, p.Threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
