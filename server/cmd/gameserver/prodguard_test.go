package main

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/payments"
)

var allEnvs = []string{"production", "", "staging", "development", "test"}

// The endpoint overrides of the fake OAuth provider (E2E suite) are refused in production,
// even for a provider that is off; development and test keep them (oauth.spec).
func TestProvidersFromEnvRefusesOverridesInProduction(t *testing.T) {
	for _, suffix := range oauthOverrideSuffixes {
		for _, prefix := range []string{"GOOGLE", "DISCORD"} {
			vars := map[string]string{
				"GOOGLE_CLIENT_ID": "id", "GOOGLE_CLIENT_SECRET": "s",
				prefix + suffix: "http://127.0.0.1:9/fake",
			}
			getenv := func(k string) string { return vars[k] }
			for _, raw := range allEnvs {
				env := payments.ParseEnv(raw)
				ps, _, err := providersFromEnv(getenv, env)
				if env == payments.EnvProduction {
					if !errors.Is(err, errTestOnlyInProduction) || !strings.Contains(err.Error(), prefix+suffix) || ps != nil {
						t.Errorf("RPG_ENV=%q %s: %v", raw, prefix+suffix, err)
					}
					continue
				}
				if err != nil || len(ps) != 1 {
					t.Errorf("RPG_ENV=%q %s: %v", raw, prefix+suffix, err)
				}
			}
		}
	}
}

func TestCheckProductionFlags(t *testing.T) {
	for _, raw := range allEnvs {
		env := payments.ParseEnv(raw)
		prod := env == payments.EnvProduction

		var logs bytes.Buffer
		logger := slog.New(slog.NewTextHandler(&logs, nil))
		err := checkProductionFlags(logger, env, options{cookieSecure: true, authRateBurst: 1000})
		if prod != errors.Is(err, errTestOnlyInProduction) {
			t.Errorf("RPG_ENV=%q -auth-rate-burst: %v", raw, err)
		}
		if err := checkProductionFlags(logger, env, options{cookieSecure: true}); err != nil || logs.Len() != 0 {
			t.Errorf("RPG_ENV=%q defaults: %v %s", raw, err, logs.String())
		}
		// -cookie-secure=false: the home stack's LAN mode needs it (docs/13), so it only warns.
		if err := checkProductionFlags(logger, env, options{}); err != nil {
			t.Errorf("RPG_ENV=%q -cookie-secure=false: %v", raw, err)
		}
		if prod != strings.Contains(logs.String(), "INSECURE: -cookie-secure=false") {
			t.Errorf("RPG_ENV=%q cookie warning: %q", raw, logs.String())
		}
	}
}

func TestNewSeeds(t *testing.T) {
	lo, hi, err := newSeeds(42, failingReader{})
	if err != nil || lo != 42 || hi != 42 {
		t.Fatalf("-seed 42: %d %d %v (must not read crypto/rand)", lo, hi, err)
	}
	src := bytes.NewReader([]byte{1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0})
	if lo, hi, err := newSeeds(0, src); err != nil || lo != 1 || hi != 2 {
		t.Fatalf("random: %d %d %v, want two independent words", lo, hi, err)
	}
	if lo, hi, err := newSeeds(0, bytes.NewReader(make([]byte, 16))); err != nil || lo == 0 || hi == 0 {
		t.Fatalf("zero bytes: %d %d %v", lo, hi, err)
	}
	if _, _, err := newSeeds(0, bytes.NewReader(make([]byte, 8))); err == nil {
		t.Fatal("a short read gave a seed")
	}
	a1, b1, _ := newSeeds(0, cryptoRand)
	a2, b2, _ := newSeeds(0, cryptoRand)
	if a1 == a2 || b1 == b2 || a1 == b1 {
		t.Fatalf("crypto seeds repeat: %d %d %d %d", a1, b1, a2, b2)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

// The seed is logged only when the operator chose it or outside production.
func TestSeedLogAttrs(t *testing.T) {
	render := func(attrs []any) string {
		var b bytes.Buffer
		slog.New(slog.NewTextHandler(&b, nil)).Info("seed", attrs...)
		return b.String()
	}
	if got := render(seedLogAttrs(false, payments.EnvProduction, 123456789, 987654321)); strings.Contains(got, "123456789") ||
		strings.Contains(got, "987654321") || !strings.Contains(got, "seed_source=random") {
		t.Errorf("production random seed leaked: %s", got)
	}
	if got := render(seedLogAttrs(true, payments.EnvProduction, 7, 7)); !strings.Contains(got, "seed=7") || !strings.Contains(got, "seed_source=flag") {
		t.Errorf("explicit seed: %s", got)
	}
	for _, env := range []payments.Env{payments.EnvDevelopment, payments.EnvTest} {
		if got := render(seedLogAttrs(false, env, 5, 6)); !strings.Contains(got, "seed=5") || !strings.Contains(got, "seed_hi=6") {
			t.Errorf("%s: %s", env, got)
		}
	}
}
