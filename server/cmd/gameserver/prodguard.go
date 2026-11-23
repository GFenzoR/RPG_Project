package main

import (
	crand "crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"

	"github.com/GFenzoR/RPG_Project/server/internal/payments"
)

// Switches that exist only for tests and local harnesses (lote 16, docs/09 "Interruptores
// solo de prueba"). A production server (RPG_ENV production, empty or unknown, as
// payments.ParseEnv reads it) refuses to start with any of them, so a stray variable or
// flag can never point the OAuth login at another server or lift the per-IP auth limit.

// oauthOverrideSuffixes are the endpoint overrides of providersFromEnv, per provider
// prefix (GOOGLE_, DISCORD_): only the fake IdP of the E2E suite (cmd/fakeoauth) uses them.
var oauthOverrideSuffixes = []string{"_AUTH_URL", "_TOKEN_URL", "_JWKS_URL", "_ISSUER", "_API_URL"}

// errTestOnlyInProduction is returned for a test-only switch on a production server.
var errTestOnlyInProduction = errors.New("test-only setting refused in production")

// devEnv reports whether env allows the test-only switches.
func devEnv(env payments.Env) bool {
	return env == payments.EnvDevelopment || env == payments.EnvTest
}

// oauthOverrides lists the OAuth endpoint override variables that are set.
func oauthOverrides(getenv func(string) string) []string {
	var set []string
	for _, prefix := range []string{"GOOGLE", "DISCORD"} {
		for _, s := range oauthOverrideSuffixes {
			if strings.TrimSpace(getenv(prefix+s)) != "" {
				set = append(set, prefix+s)
			}
		}
	}
	return set
}

// checkProductionFlags refuses the test-only flags in production (-auth-rate-burst) and
// warns about the ones a home server may legitimately need (-cookie-secure=false for
// friends on plain http://<LAN IP>, docs/13). Development and test accept them silently.
func checkProductionFlags(logger *slog.Logger, env payments.Env, o options) error {
	if devEnv(env) {
		return nil
	}
	if o.authRateBurst != 0 {
		return fmt.Errorf("%w: -auth-rate-burst=%d (only for test harnesses; set RPG_ENV=development or test on a server only you reach)",
			errTestOnlyInProduction, o.authRateBurst)
	}
	if !o.cookieSecure {
		logger.Warn("INSECURE: -cookie-secure=false in production: the session cookie travels over plain HTTP "+
			"and anyone on the network path can steal it. Only for friends on a LAN or Tailscale IP (docs/13); "+
			"never behind a public domain", "env", string(env))
	}
	return nil
}

// newSeeds returns the two words of the game loop's PCG source. An explicit -seed (not
// 0) gives (seed, seed), the old and replayable behaviour; otherwise both words come
// independently from crypto/rand, so the loop's rolls cannot be predicted from one
// leaked 64-bit value.
func newSeeds(flagSeed uint64, random io.Reader) (lo, hi uint64, err error) {
	if flagSeed != 0 {
		return flagSeed, flagSeed, nil
	}
	var b [16]byte
	if _, err := io.ReadFull(random, b[:]); err != nil {
		return 0, 0, fmt.Errorf("seed: %w", err)
	}
	lo, hi = binary.LittleEndian.Uint64(b[:8]), binary.LittleEndian.Uint64(b[8:])
	if lo == 0 { // 0 means "random" to app.Config and to -seed
		lo = 1
	}
	if hi == 0 {
		hi = 1
	}
	return lo, hi, nil
}

// seedLogAttrs is what the startup log says about the seed: the value only when the
// operator chose it (-seed) or in development/test, where replaying matters; a random
// production seed is never written anywhere (seed_source=random).
func seedLogAttrs(explicit bool, env payments.Env, lo, hi uint64) []any {
	switch {
	case explicit:
		return []any{"seed", lo, "seed_source", "flag"}
	case devEnv(env):
		return []any{"seed", lo, "seed_hi", hi, "seed_source", "random"}
	default:
		return []any{"seed_source", "random"}
	}
}

// cryptoRand is crypto/rand's reader (a variable so tests can make it fail).
var cryptoRand io.Reader = crand.Reader
