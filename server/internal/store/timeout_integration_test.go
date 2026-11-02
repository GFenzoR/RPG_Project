//go:build integration

package store_test

import (
	"context"
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
)

// TestPoolStatementTimeout: pool queries are bounded by DefaultStatementTimeout, while
// migrations (own connection) are not.
func TestPoolStatementTimeout(t *testing.T) {
	ctx := context.Background()
	const schema = "it_store_timeout"
	st := storetest.Open(t, schema, true)
	conn := storetest.Conn(t, schema)

	got, err := st.StatementTimeout(ctx)
	if err != nil || got != "10s" {
		t.Fatalf("pool statement_timeout = %q, %v; want 10s", got, err)
	}
	var raw string
	if err := conn.QueryRow(ctx, "SHOW statement_timeout").Scan(&raw); err != nil || raw != "0" {
		t.Fatalf("plain connection statement_timeout = %q, %v; want 0 (unchanged)", raw, err)
	}
}
