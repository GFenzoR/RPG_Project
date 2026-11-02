//go:build integration

package store_test

import (
	"context"
	"net/url"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// TestPoolStatementTimeout: pool queries get DefaultStatementTimeout unless the URL sets
// its own value.
func TestPoolStatementTimeout(t *testing.T) {
	ctx := context.Background()
	st := storetest.Open(t, "it_store_timeout", false)
	if got, err := st.StatementTimeout(ctx); err != nil || got != "10s" {
		t.Fatalf("pool statement_timeout = %q, %v; want 10s", got, err)
	}
	st2 := storetest.OpenParams(t, "it_store_timeout_url", false, url.Values{"statement_timeout": {"3000"}})
	if got, err := st2.StatementTimeout(ctx); err != nil || got != "3s" {
		t.Fatalf("URL statement_timeout = %q, %v; want 3s", got, err)
	}
}

// TestMigrateWithPoolOptionsAndTinyTimeout: migrations work with pool_* options in the
// URL and are not bound by a statement_timeout set in it (1 ms would cut them off).
func TestMigrateWithPoolOptionsAndTinyTimeout(t *testing.T) {
	ctx := context.Background()
	params := url.Values{"pool_max_conns": {"4"}, "statement_timeout": {"1"}}
	st := storetest.OpenParams(t, "it_store_migrate_opts", false, params)
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := st.MigrateDownAll(ctx); err != nil {
		t.Fatalf("down: %v", err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
}
