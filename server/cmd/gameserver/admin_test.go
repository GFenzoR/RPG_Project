package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

type fakeAdminStore struct {
	email, role string
	audit       store.AuditEntry
	closed      bool
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

func (f *fakeAdminStore) Close() { f.closed = true }

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
	if !strings.Contains(out, "role player -> gm") {
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
