// Package storetest opens a migrated, empty PostgreSQL schema for integration tests
// (build tag "integration"). Each caller gets its own schema, so test packages that run
// in parallel do not see each other's rows.
package storetest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// DefaultURL is the test database of cloud sessions and of `make db-up` locally.
const DefaultURL = "postgres://postgres:postgres@localhost:5432/rpg_test"

// URL returns TEST_DATABASE_URL or DefaultURL.
func URL() string {
	if u := os.Getenv("TEST_DATABASE_URL"); u != "" {
		return u
	}
	return DefaultURL
}

// Open recreates the schema named schema, connects with it as search_path and, if
// migrate is true, applies every migration. The store is closed when the test ends.
func Open(t testing.TB, schema string, migrate bool) *store.Store {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, URL())
	if err != nil {
		t.Fatalf("connect to %s (is Postgres running? make db-up): %v", URL(), err)
	}
	ident := pgx.Identifier{schema}.Sanitize()
	for _, q := range []string{"DROP SCHEMA IF EXISTS " + ident + " CASCADE", "CREATE SCHEMA " + ident} {
		if _, err := conn.Exec(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	_ = conn.Close(ctx)

	st, err := store.Open(ctx, schemaURL(t, schema))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if migrate {
		if err := st.Migrate(ctx); err != nil {
			t.Fatal(fmt.Errorf("migrate: %w", err))
		}
	}
	return st
}

// Conn opens a raw connection to schema (created by Open) for checks on the schema
// itself, such as constraints and triggers.
func Conn(t testing.TB, schema string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), schemaURL(t, schema))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func schemaURL(t testing.TB, schema string) string {
	t.Helper()
	u, err := url.Parse(URL())
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	qv := u.Query()
	qv.Set("search_path", schema)
	u.RawQuery = qv.Encode()
	return u.String()
}
