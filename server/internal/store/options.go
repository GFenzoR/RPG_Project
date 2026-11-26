package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// AccountOptions returns the interface options document of an account (account_options,
// migration 00029), nil if it never saved one. The document is the canonical JSON the
// options package wrote: this layer does not interpret it.
func (s *Store) AccountOptions(ctx context.Context, accountID int64) ([]byte, error) {
	doc, err := s.q.GetAccountOptions(ctx, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("account options: %w", err)
	}
	return doc, nil
}

// SaveAccountOptions replaces the interface options document of an account. doc must be
// the validated, canonical document (the HTTP API builds it; the table caps its size).
func (s *Store) SaveAccountOptions(ctx context.Context, accountID int64, doc []byte, now time.Time) error {
	if err := s.q.SaveAccountOptions(ctx, db.SaveAccountOptionsParams{AccountID: accountID, Doc: doc, UpdatedAt: ts(now)}); err != nil {
		return fmt.Errorf("save account options: %w", err)
	}
	return nil
}
