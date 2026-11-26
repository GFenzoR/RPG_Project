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

// UpdateAccountOptions replaces the document of an account with merge(stored) in one
// transaction, stored being the document as AccountOptions returns it (nil: never saved).
// The account's row is locked meanwhile, so two saves of one account (the computer and
// the phone) never interleave between the read and the write, whichever server process
// each reaches; a save that waits for the other gives up with its context. An error of
// merge comes back as it is and nothing is written.
func (s *Store) UpdateAccountOptions(ctx context.Context, accountID int64, now time.Time, merge func(stored []byte) ([]byte, error)) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		if _, err := q.LockAccountForOptions(ctx, accountID); err != nil {
			return fmt.Errorf("account options: lock: %w", err)
		}
		stored, err := q.GetAccountOptions(ctx, accountID)
		if errors.Is(err, pgx.ErrNoRows) {
			stored = nil
		} else if err != nil {
			return fmt.Errorf("account options: %w", err)
		}
		doc, err := merge(stored)
		if err != nil {
			return err
		}
		if err := q.SaveAccountOptions(ctx, db.SaveAccountOptionsParams{AccountID: accountID, Doc: doc, UpdatedAt: ts(now)}); err != nil {
			return fmt.Errorf("save account options: %w", err)
		}
		return nil
	})
}
