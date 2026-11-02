package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
)

// cheapHash keeps unit tests fast; production uses DefaultHashParams.
var cheapHash = HashParams{MemoryKiB: 64, Time: 1, Threads: 1}

func TestHashAndVerify(t *testing.T) {
	h, err := hashPassword("correct horse", cheapHash)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=64,t=1,p=1$") {
		t.Fatalf("unexpected encoding %q", h)
	}
	h2, _ := hashPassword("correct horse", cheapHash)
	if h == h2 {
		t.Fatal("two hashes of the same password must differ (random salt)")
	}
	for pw, want := range map[string]bool{"correct horse": true, "correct hors": false, "": false} {
		got, err := verifyPassword(pw, h)
		if err != nil || got != want {
			t.Errorf("verify(%q) = %v, %v; want %v", pw, got, err, want)
		}
	}
}

func TestVerifyUsesStoredParams(t *testing.T) {
	h, _ := hashPassword("pw-123456", HashParams{MemoryKiB: 128, Time: 2, Threads: 2})
	if ok, err := verifyPassword("pw-123456", h); !ok || err != nil {
		t.Fatalf("verify with other params: %v %v", ok, err)
	}
}

func TestVerifyMalformed(t *testing.T) {
	for _, h := range []string{
		"", "plain", "$argon2i$v=19$m=64,t=1,p=1$AAAA$AAAA",
		"$argon2id$v=18$m=64,t=1,p=1$AAAA$AAAA",
		"$argon2id$v=19$m=0,t=1,p=1$AAAA$AAAA",
		"$argon2id$v=19$m=99999999,t=1,p=1$AAAA$AAAA",
		"$argon2id$v=19$m=64,t=1,p=1$!!$AAAA",
		"$argon2id$v=19$m=64,t=1,p=1$AAAA$",
	} {
		if _, err := verifyPassword("x", h); err == nil {
			t.Errorf("verify(%q): expected error", h)
		}
	}
}

func TestToken(t *testing.T) {
	a, ha, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _, _ := newToken()
	if len(a) != 43 || a == b {
		t.Fatalf("tokens %q %q", a, b)
	}
	if string(ha) != string(hashToken(a)) || len(ha) != 32 {
		t.Fatal("hash mismatch")
	}
}

func TestHashSlotWaitTimesOut(t *testing.T) {
	clk := clock.NewFake(time.Unix(0, 0))
	svc, err := New(Config{
		Repo: authtest.NewRepo(), Clock: clk, Hash: cheapHash,
		Vocations:           content.Vocations{"a": {ID: "a", Start: content.VocationStats{Health: 1}}},
		MaxConcurrentHashes: 1, HashWait: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.hashSlots <- struct{}{} // the only slot is taken
	done := make(chan error, 1)
	go func() { _, err := svc.Register(context.Background(), "ana@example.org", "secreto123"); done <- err }()
	clk.BlockUntil(1)
	clk.Advance(time.Second)
	if err := <-done; !errors.Is(err, ErrBusy) {
		t.Fatalf("Register = %v, want ErrBusy", err)
	}
	<-svc.hashSlots
	if _, err := svc.Register(context.Background(), "ana@example.org", "secreto123"); err != nil {
		t.Fatalf("with a free slot: %v", err)
	}
}
