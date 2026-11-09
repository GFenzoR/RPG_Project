package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

type fakeAdminStore struct {
	email, role string
	audit       store.AuditEntry
	closed      bool
	token       store.AccountToken
}

func (f *fakeAdminStore) SetRole(_ context.Context, email, role string, a store.AuditEntry) (int64, string, error) {
	if email != "gm@example.org" {
		return 0, "", store.ErrNotFound
	}
	f.email, f.role, f.audit = email, role, a
	return 7, "player", nil
}

func (f *fakeAdminStore) ListAudit(context.Context, int) ([]store.AuditEntry, error) {
	return []store.AuditEntry{{Source: "cli", ActorName: "cli:ops", Action: "set_role", Result: "ok"}}, nil
}

func (f *fakeAdminStore) OpenReports(context.Context, int) ([]store.Report, error) {
	return []store.Report{{ID: 3, ReporterName: "Ana", TargetName: "Bob", Reason: "bot", Context: []byte(`{"target_level":4}`)}}, nil
}

func (f *fakeAdminStore) Close() { f.closed = true }

func (f *fakeAdminStore) AccountProfileByEmail(_ context.Context, email string) (store.Profile, error) {
	if email != "gm@example.org" {
		return store.Profile{}, store.ErrNotFound
	}
	return store.Profile{ID: 7, Email: email, Locale: "en"}, nil
}

func (f *fakeAdminStore) ReplaceAccountToken(_ context.Context, t store.AccountToken) error {
	f.token = t
	return nil
}

func (f *fakeAdminStore) AppendAudit(_ context.Context, e store.AuditEntry) error {
	f.audit = e
	return nil
}

func TestAdminResetLink(t *testing.T) {
	var out bytes.Buffer
	f := &fakeAdminStore{}
	open := func() (adminStore, error) { return f, nil }
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	err := adminCommand(context.Background(), []string{"reset-link", "-email", "GM@example.org", "-public-url", "https://game.example/"},
		open, &out, "cli:ops", func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(out.String())
	const prefix = "https://game.example/reset-password?lang=en#token="
	idx := strings.Index(line, prefix)
	if idx < 0 {
		t.Fatalf("no link in %q", line)
	}
	token := strings.Fields(line[idx+len(prefix):])[0]
	if len(token) != 43 || f.token.Purpose != store.TokenResetPassword || f.token.AccountID != 7 ||
		!f.token.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("token %q stored %+v", token, f.token)
	}
	if strings.Contains(string(f.token.TokenHash), token) || len(f.token.TokenHash) != 32 {
		t.Fatal("the plain token was stored")
	}
	if f.audit.Action != store.AuditResetLinkIssue || f.audit.Source != store.AuditCLI || f.audit.TargetAccountID != 7 {
		t.Fatalf("audit %+v", f.audit)
	}
	if strings.Contains(fmt.Sprint(f.audit.Args), token) {
		t.Fatal("token in the audit log")
	}
	for _, args := range [][]string{
		{"reset-link", "-email", "gm@example.org", "-public-url", "ftp://x"},
		{"reset-link", "-public-url", "https://x"},
	} {
		if err := adminCommand(context.Background(), args, open, &out, "cli:ops", func() time.Time { return now }); !errors.Is(err, errUsage) {
			t.Errorf("%v: err %v, want usage", args, err)
		}
	}
	err = adminCommand(context.Background(), []string{"reset-link", "-email", "nobody@example.org", "-public-url", "https://x.example"},
		open, &out, "cli:ops", func() time.Time { return now })
	if err == nil || !strings.Contains(err.Error(), "no account") {
		t.Fatalf("unknown email: %v", err)
	}
}

func TestAdminReports(t *testing.T) {
	var out bytes.Buffer
	f := &fakeAdminStore{}
	now := func() time.Time { return time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC) }
	err := adminCommand(context.Background(), []string{"reports", "-n", "5"}, func() (adminStore, error) { return f, nil }, &out, "cli:ops", now)
	if err != nil || !strings.Contains(out.String(), `#3`) || !strings.Contains(out.String(), `Ana reported Bob: "bot"`) ||
		!strings.Contains(out.String(), `"target_level":4`) || !f.closed {
		t.Fatalf("reports: %v %q", err, out.String())
	}
	if err := adminCommand(context.Background(), []string{"reports", "x"}, nil, &out, "", now); !errors.Is(err, errUsage) {
		t.Fatalf("extra argument: %v", err)
	}
}

func TestAdminSetRole(t *testing.T) {
	now := time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)
	run := func(args ...string) (*fakeAdminStore, string, error) {
		f := &fakeAdminStore{}
		var out bytes.Buffer
		err := adminCommand(context.Background(), args, func() (adminStore, error) { return f, nil }, &out, "cli:ops", func() time.Time { return now })
		return f, out.String(), err
	}
	f, out, err := run("set-role", "-email", " GM@Example.org ", "-role", "gm", "-note", "new moderator")
	if err != nil || f.email != "gm@example.org" || f.role != "gm" || !f.closed {
		t.Fatalf("set-role: %+v %v", f, err)
	}
	if a := f.audit; a.Source != store.AuditCLI || a.ActorName != "cli:ops" || !a.At.Equal(now) || a.Args["note"] != "new moderator" {
		t.Fatalf("audit %+v", a)
	}
	if !strings.Contains(out, "role player -> gm") || !strings.Contains(out, "next login") {
		t.Fatalf("output %q", out)
	}
	for _, args := range [][]string{
		{"set-role", "-email", "gm@example.org", "-role", "god", "-note", "x"},
		{"set-role", "-email", "gm@example.org", "-role", "gm"}, // no note
		{"set-role", "-email", "nope", "-role", "gm", "-note", "x"},
		{"set-role", "extra"},
		{"grant-everything"},
	} {
		if _, _, err := run(args...); !errors.Is(err, errUsage) {
			t.Errorf("%v: %v, want a usage error", args, err)
		}
	}
	if _, _, err := run("set-role", "-email", "other@example.org", "-role", "gm", "-note", "x"); err == nil || errors.Is(err, errUsage) {
		t.Fatalf("unknown account: %v", err)
	}
	if _, out, err := run("audit", "-n", "5"); err != nil || !strings.Contains(out, "set_role") {
		t.Fatalf("audit: %q %v", out, err)
	}
}
