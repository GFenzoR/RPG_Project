package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/auth/authtest"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

var testVocations = content.Vocations{
	"guardian": {ID: "guardian", Start: content.VocationStats{Health: 150, Mana: 30}},
	"arcanist": {ID: "arcanist", Start: content.VocationStats{Health: 150, Mana: 60}},
	"ranger":   {ID: "ranger", Start: content.VocationStats{Health: 150, Mana: 45}},
}

func newService(t *testing.T) (*auth.Service, *authtest.Repo, *clock.Fake) {
	t.Helper()
	repo := authtest.NewRepo()
	clk := clock.NewFake(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	svc, err := auth.New(auth.Config{
		Repo:              repo,
		Clock:             clk,
		Vocations:         testVocations,
		PlayableVocations: []string{"guardian", "arcanist"},
		AccountTokenTTL:   time.Hour,
		MaxCharacters:     2,
		Hash:              auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	return svc, repo, clk
}

func TestRegisterLoginAuthenticateLogout(t *testing.T) {
	ctx := context.Background()
	svc, repo, clk := newService(t)

	id, err := svc.Register(ctx, " Ana@Example.org", "secreto123")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Register(ctx, "ana@example.org", "otherpass1"); !errors.Is(err, auth.ErrEmailTaken) {
		t.Fatalf("duplicate register: %v", err)
	}

	tok, err := svc.Login(ctx, "ANA@example.org", "secreto123")
	if err != nil {
		t.Fatal(err)
	}
	if tok.AccountID != id || !tok.ExpiresAt.Equal(clk.Now().Add(time.Hour)) {
		t.Fatalf("token %+v", tok)
	}
	got, err := svc.Authenticate(ctx, tok.Token)
	if err != nil || got != id {
		t.Fatalf("Authenticate = %d, %v", got, err)
	}

	if err := svc.Logout(ctx, tok.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, tok.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("after logout: %v", err)
	}
	if repo.SessionCount() != 0 {
		t.Fatal("session not deleted")
	}
}

func TestLoginFailures(t *testing.T) {
	ctx := context.Background()
	svc, repo, _ := newService(t)
	id, _ := svc.Register(ctx, "ana@example.org", "secreto123")

	for _, c := range []struct{ email, pw string }{
		{"ana@example.org", "wrongpass"},
		{"nobody@example.org", "secreto123"},
		{"not-an-email", "secreto123"},
	} {
		if _, err := svc.Login(ctx, c.email, c.pw); !errors.Is(err, auth.ErrInvalidCredentials) {
			t.Errorf("Login(%q,%q) = %v, want ErrInvalidCredentials", c.email, c.pw, err)
		}
	}
	repo.Disable(id)
	if _, err := svc.Login(ctx, "ana@example.org", "secreto123"); !errors.Is(err, auth.ErrAccountDisabled) {
		t.Fatalf("disabled: %v", err)
	}
}

// A banned account cannot log in while the ban lasts (T2.6), and a wrong password still
// answers invalid_credentials, so the ban is not revealed without the password.
func TestLoginBanned(t *testing.T) {
	ctx := context.Background()
	svc, repo, clk := newService(t)
	id, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	repo.SetBan(id, store.Ban{ID: 1, Reason: "spam", ExpiresAt: clk.Now().Add(time.Hour)})
	if _, err := svc.Login(ctx, "ana@example.org", "secreto123"); !errors.Is(err, auth.ErrAccountBanned) {
		t.Fatalf("banned: %v", err)
	}
	if _, err := svc.Login(ctx, "ana@example.org", "wrongpass"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("banned, wrong password: %v", err)
	}
	clk.Advance(time.Hour)
	if _, err := svc.Login(ctx, "ana@example.org", "secreto123"); err != nil {
		t.Fatalf("after the ban: %v", err)
	}
	repo.SetBan(id, store.Ban{ID: 2, Reason: "cheating"}) // permanent
	clk.Advance(1000 * time.Hour)
	if _, err := svc.Login(ctx, "ana@example.org", "secreto123"); !errors.Is(err, auth.ErrAccountBanned) {
		t.Fatalf("permanent ban: %v", err)
	}
}

func TestRegisterValidation(t *testing.T) {
	svc, _, _ := newService(t)
	ctx := context.Background()
	if _, err := svc.Register(ctx, "bad", "secreto123"); !errors.Is(err, auth.ErrInvalidEmail) {
		t.Errorf("bad email: %v", err)
	}
	if _, err := svc.Register(ctx, "ana@example.org", "short"); !errors.Is(err, auth.ErrInvalidPassword) {
		t.Errorf("short password: %v", err)
	}
}

func TestTokenExpiryUsesInjectedClock(t *testing.T) {
	ctx := context.Background()
	svc, repo, clk := newService(t)
	_, _ = svc.Register(ctx, "ana@example.org", "secreto123")
	tok, _ := svc.Login(ctx, "ana@example.org", "secreto123")

	clk.Advance(59 * time.Minute)
	if _, err := svc.Authenticate(ctx, tok.Token); err != nil {
		t.Fatalf("before expiry: %v", err)
	}
	clk.Advance(time.Minute)
	if _, err := svc.Authenticate(ctx, tok.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("at expiry: %v", err)
	}
	if n, err := svc.PurgeExpiredSessions(ctx); err != nil || n != 1 || repo.SessionCount() != 0 {
		t.Fatalf("purge = %d, %v", n, err)
	}
	for _, bad := range []string{"", "nope", string(make([]byte, 200))} {
		if _, err := svc.Authenticate(ctx, bad); !errors.Is(err, auth.ErrUnauthorized) {
			t.Errorf("Authenticate(%q): %v", bad, err)
		}
	}
}

func TestCreateCharacter(t *testing.T) {
	ctx := context.Background()
	svc, _, _ := newService(t)
	acc, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	other, _ := svc.Register(ctx, "bob@example.org", "secreto123")

	c, err := svc.CreateCharacter(ctx, acc, "Mira", "arcanist")
	if err != nil {
		t.Fatal(err)
	}
	if c.Name != "Mira" || c.Vocation != "arcanist" || c.Level != 1 {
		t.Fatalf("character %+v", c)
	}
	checks := []struct {
		account        int64
		name, vocation string
		want           error
	}{
		{acc, "mira", "guardian", auth.ErrInvalidName},
		{acc, "Tom", "ranger", auth.ErrInvalidVocation}, // loaded but not playable yet
		{acc, "Tom", "", auth.ErrInvalidVocation},
		{other, "MIRA", "guardian", auth.ErrInvalidName},
		{other, "Mira", "guardian", auth.ErrNameTaken},
	}
	for _, ch := range checks {
		if _, err := svc.CreateCharacter(ctx, ch.account, ch.name, ch.vocation); !errors.Is(err, ch.want) {
			t.Errorf("CreateCharacter(%q,%q) = %v, want %v", ch.name, ch.vocation, err, ch.want)
		}
	}
	if _, err := svc.CreateCharacter(ctx, acc, "Old Tom", "guardian"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateCharacter(ctx, acc, "Third", "guardian"); !errors.Is(err, auth.ErrCharacterLimit) {
		t.Fatalf("limit: %v", err)
	}
	list, err := svc.Characters(ctx, acc)
	if err != nil || len(list) != 2 || list[0].Name != "Mira" || list[1].Name != "Old Tom" {
		t.Fatalf("Characters = %+v, %v", list, err)
	}
}

func TestNewRejectsUnknownPlayableVocation(t *testing.T) {
	_, err := auth.New(auth.Config{
		Repo: authtest.NewRepo(), Clock: clock.NewFake(time.Unix(0, 0)),
		Vocations: testVocations, PlayableVocations: []string{"druid"},
	})
	if err == nil {
		t.Fatal("expected error")
	}
}
