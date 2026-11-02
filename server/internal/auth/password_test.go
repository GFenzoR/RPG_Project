package auth

import (
	"strings"
	"testing"
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
