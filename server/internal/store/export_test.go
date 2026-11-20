package store

import (
	"context"

	"github.com/pressly/goose/v3"
)

// SetTransferHook makes SaveTransfer call f inside its transaction after each step (0:
// after the snapshots, i: after market change i); an error aborts it. Tests only.
func SetTransferHook(f func(step int) error) { transferHook = f }

// MigrateUpTo applies the pending migrations up to version (tests of a migration only).
func (s *Store) MigrateUpTo(ctx context.Context, version int64) error {
	return s.withGoose(func(p *goose.Provider) error {
		_, err := p.UpTo(ctx, version)
		return err
	})
}

// MigrateDownTo rolls back the migrations above version (tests of a migration only).
func (s *Store) MigrateDownTo(ctx context.Context, version int64) error {
	return s.withGoose(func(p *goose.Provider) error {
		_, err := p.DownTo(ctx, version)
		return err
	})
}
