package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// The living world's trail wear (migration 00027, livingworld/README.md "Desgaste de
// senderos"): one row with the encoded wear (livingworld/server/trail Snapshot.Encode).
// The game loop owns the wear; app reads the row once before the loop starts and writes
// copies from its own goroutine.

// LoadTrailWear returns the saved wear and when it was saved; ok is false when nothing
// was ever saved.
func (s *Store) LoadTrailWear(ctx context.Context) (data []byte, savedAt time.Time, ok bool, err error) {
	row, err := s.q.LoadTrailWear(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, time.Time{}, false, nil
	}
	if err != nil {
		return nil, time.Time{}, false, fmt.Errorf("load trail wear: %w", err)
	}
	return row.Data, row.SavedAt.Time, true, nil
}

// SaveTrailWear replaces the saved wear.
func (s *Store) SaveTrailWear(ctx context.Context, data []byte, savedAt time.Time) error {
	if data == nil {
		data = []byte{}
	}
	if err := s.q.SaveTrailWear(ctx, db.SaveTrailWearParams{Data: data, SavedAt: ts(savedAt)}); err != nil {
		return fmt.Errorf("save trail wear: %w", err)
	}
	return nil
}
