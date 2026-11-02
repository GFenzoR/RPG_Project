// Package store is the PostgreSQL persistence layer: connection pool, goose migrations
// and repositories over the sqlc-generated queries in internal/store/db.
//
// Store methods never run inside the game loop: callers are HTTP handlers and the
// persistence goroutine (docs/01-architecture.md).
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
	"github.com/GFenzoR/RPG_Project/server/migrations"
)

// Errors returned by Store. Callers match them with errors.Is.
var (
	ErrNotFound       = errors.New("store: not found")
	ErrEmailTaken     = errors.New("store: email already registered")
	ErrNameTaken      = errors.New("store: character name taken")
	ErrCharacterLimit = errors.New("store: character limit reached")
)

// Unique index names from migrations/, used to map unique violations to errors.
const (
	accountsEmailKey  = "accounts_email_key"
	charactersNameKey = "characters_name_key"
	pgUniqueViolation = "23505"
)

// Store wraps a pgx pool and the generated queries.
type Store struct {
	pool *pgxpool.Pool
	q    *db.Queries
}

// Open connects to PostgreSQL and checks the connection.
func Open(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &Store{pool: pool, q: db.New(pool)}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Ping checks the database is reachable (used by /healthz).
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Migrate applies every pending migration embedded in the binary.
func (s *Store) Migrate(ctx context.Context) error {
	return withGoose(s.pool, func(p *goose.Provider) error {
		_, err := p.Up(ctx)
		return err
	})
}

// MigrateDownAll rolls back every migration. Only for tests and `make migrate-reset`.
func (s *Store) MigrateDownAll(ctx context.Context) error {
	return withGoose(s.pool, func(p *goose.Provider) error {
		_, err := p.DownTo(ctx, 0)
		return err
	})
}

func withGoose(pool *pgxpool.Pool, fn func(*goose.Provider) error) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }()
	p, err := newProvider(sqlDB)
	if err != nil {
		return err
	}
	if err := fn(p); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

func newProvider(sqlDB *sql.DB) (*goose.Provider, error) {
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS)
	if err != nil {
		return nil, fmt.Errorf("goose provider: %w", err)
	}
	return p, nil
}

// inTx runs fn inside a transaction, committing if fn returns nil.
func (s *Store) inTx(ctx context.Context, fn func(*db.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op after Commit
	if err := fn(s.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func uniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation && pgErr.ConstraintName == constraint
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func ts(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }
