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
	url  string
}

// DefaultStatementTimeout bounds every query of the pool, so a stuck query cannot hold
// an HTTP request (or shutdown) forever. Migrations run on their own connection without it.
const DefaultStatementTimeout = 10 * time.Second

// Open connects to PostgreSQL and checks the connection. Pool queries time out after
// DefaultStatementTimeout unless the URL sets its own statement_timeout.
func Open(ctx context.Context, url string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse postgres url: %w", err)
	}
	if _, ok := cfg.ConnConfig.RuntimeParams["statement_timeout"]; !ok {
		cfg.ConnConfig.RuntimeParams["statement_timeout"] = fmt.Sprint(DefaultStatementTimeout.Milliseconds())
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &Store{pool: pool, q: db.New(pool), url: url}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Ping checks the database is reachable (used by /healthz).
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Migrate applies every pending migration embedded in the binary.
func (s *Store) Migrate(ctx context.Context) error {
	return s.withGoose(func(p *goose.Provider) error {
		_, err := p.Up(ctx)
		return err
	})
}

// MigrateDownAll rolls back every migration. Only for tests.
func (s *Store) MigrateDownAll(ctx context.Context) error {
	return s.withGoose(func(p *goose.Provider) error {
		_, err := p.DownTo(ctx, 0)
		return err
	})
}

// migrationConfig is the connection config for migrations: the database URL without
// the pool_* options (pgxpool.ParseConfig strips them; Postgres would reject them as
// runtime parameters) and with statement_timeout disabled, even if the URL sets one, so
// long migrations (index builds) are not cut off.
func migrationConfig(url string) (*pgx.ConnConfig, error) {
	pcfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse postgres url: %w", err)
	}
	cfg := pcfg.ConnConfig.Copy()
	cfg.RuntimeParams["statement_timeout"] = "0"
	return cfg, nil
}

// withGoose runs fn on a separate connection configured by migrationConfig.
func (s *Store) withGoose(fn func(*goose.Provider) error) error {
	cfg, err := migrationConfig(s.url)
	if err != nil {
		return err
	}
	sqlDB := stdlib.OpenDB(*cfg)
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

// StatementTimeout returns the statement_timeout in effect on pool connections.
func (s *Store) StatementTimeout(ctx context.Context) (string, error) {
	var v string
	if err := s.pool.QueryRow(ctx, "SHOW statement_timeout").Scan(&v); err != nil {
		return "", fmt.Errorf("show statement_timeout: %w", err)
	}
	return v, nil
}
