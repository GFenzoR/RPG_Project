//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

func TestOAuthStoreWithPostgres(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_oauth", true)
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

	// States are single-use and expire.
	s := store.OAuthState{StateHash: hash("s1"), BindingHash: hash("b1"), Provider: "google", Verifier: "v",
		Nonce: "n", Mode: "login", ReturnTo: "/play/", ExpiresAt: now.Add(10 * time.Minute)}
	if err := st.CreateOAuthState(ctx, s); err != nil {
		t.Fatal(err)
	}
	got, err := st.ConsumeOAuthState(ctx, hash("s1"), now)
	if err != nil || string(got.BindingHash) != string(hash("b1")) || got.Nonce != "n" || got.Mode != "login" {
		t.Fatalf("%+v %v", got, err)
	}
	if _, err := st.ConsumeOAuthState(ctx, hash("s1"), now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second use: %v", err)
	}

	// An OAuth-only account with its identity; email verified only when asked.
	g := store.ExternalIdentity{Provider: "google", Subject: "g-1", Email: "ana@example.org", EmailVerified: true}
	ana, err := st.CreateOAuthAccount(ctx, "ana@example.org", true, g, now)
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := st.AccountProfile(ctx, ana); !p.EmailVerified || p.HasPassword {
		t.Fatalf("profile %+v", p)
	}
	if _, err := st.CreateOAuthAccount(ctx, "ana@example.org", false, store.ExternalIdentity{Provider: "discord", Subject: "d"}, now); !errors.Is(err, store.ErrEmailTaken) {
		t.Fatalf("email taken: %v", err)
	}
	if id, err := st.IdentityAccount(ctx, "google", "g-1"); err != nil || id != ana {
		t.Fatalf("identity %d %v", id, err)
	}
	bob, _ := st.CreateAccount(ctx, "bob@example.org", "$argon2id$x")
	if err := st.LinkIdentity(ctx, bob, g, now); !errors.Is(err, store.ErrIdentityTaken) {
		t.Fatalf("taken: %v", err)
	}
	if err := st.LinkIdentity(ctx, ana, store.ExternalIdentity{Provider: "google", Subject: "g-2"}, now); !errors.Is(err, store.ErrProviderLinked) {
		t.Fatalf("second google: %v", err)
	}
	if err := st.UnlinkIdentity(ctx, ana, "google", now); !errors.Is(err, store.ErrLastLoginMethod) {
		t.Fatalf("last method: %v", err)
	}
	if err := st.LinkIdentity(ctx, bob, store.ExternalIdentity{Provider: "discord", Subject: "d-1", Email: "b@x.org"}, now); err != nil {
		t.Fatal(err)
	}
	if err := st.UnlinkIdentity(ctx, bob, "discord", now); err != nil {
		t.Fatalf("bob has a password: %v", err)
	}
	if err := st.UnlinkIdentity(ctx, bob, "discord", now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unlink twice: %v", err)
	}
	if ids, _ := st.Identities(ctx, ana); len(ids) != 1 || ids[0].Email != "ana@example.org" {
		t.Fatalf("identities %+v", ids)
	}

	// Pending identities, then the purge.
	pend := store.OAuthPending{Identity: store.ExternalIdentity{Provider: "discord", Subject: "d-9", Email: "ana@example.org"}, ReturnTo: "/account"}
	if err := st.CreateOAuthPending(ctx, hash("p1"), pend, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if p, err := st.OAuthPendingByToken(ctx, hash("p1"), now); err != nil || p.Identity.Subject != "d-9" || p.ReturnTo != "/account" {
		t.Fatalf("%+v %v", p, err)
	}
	_ = st.CreateOAuthState(ctx, store.OAuthState{StateHash: hash("s2"), BindingHash: hash("b"), Provider: "discord",
		Verifier: "v", Mode: "link", AccountID: bob, ReturnTo: "/account", ExpiresAt: now.Add(time.Minute)})
	if n, err := st.DeleteExpiredOAuth(ctx, now.Add(time.Hour)); err != nil || n != 2 {
		t.Fatalf("purged %d %v", n, err)
	}

	// A password reset drops identities that never proved the account's email.
	zed, _ := st.CreateAccount(ctx, "zed@example.org", "$argon2id$x")
	_ = st.LinkIdentity(ctx, zed, store.ExternalIdentity{Provider: "discord", Subject: "squat", Email: "zed@example.org"}, now)
	_ = st.LinkIdentity(ctx, zed, store.ExternalIdentity{Provider: "google", Subject: "own", Email: "zed@example.org", EmailVerified: true}, now)
	if err := st.ReplaceAccountToken(ctx, store.AccountToken{TokenHash: hash("reset-zed"), AccountID: zed,
		Purpose: store.TokenResetPassword, Email: "zed@example.org", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ResetPassword(ctx, hash("reset-zed"), "$argon2id$y", now); err != nil {
		t.Fatal(err)
	}
	if ids, _ := st.Identities(ctx, zed); len(ids) != 1 || ids[0].Provider != "google" {
		t.Fatalf("after reset %+v", ids)
	}

	// Audit: created, linked, unlinked; never the email.
	audit, _ := st.ListAudit(ctx, 10)
	var actions []string
	for _, e := range audit {
		actions = append(actions, e.Action)
		if e.TargetName != "" || (e.Args["provider"] == "" && e.Action != store.AuditPasswordReset) {
			t.Fatalf("audit %+v", e)
		}
	}
	actions = actions[3:] // zed: reset, linked, linked
	if len(actions) != 3 || actions[0] != store.AuditIdentityUnlinked || actions[2] != store.AuditOAuthAccount {
		t.Fatalf("audit %v", actions)
	}
}
