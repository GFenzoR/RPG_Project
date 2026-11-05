package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// EconomyEntry is one row of the append-only economy_log (T4.1). Count and Amount are
// signed (positive created, negative destroyed); ItemID 0 is a money row. Zero ids and
// counts are stored as NULL; Ref goes to details.ref.
type EconomyEntry struct {
	At               time.Time
	Kind             string
	CharacterID      int64
	OtherCharacterID int64
	ItemID           int
	Count            int
	Amount           int64
	Ref              string
}

// economyCols are the columns AppendEconomy writes (staging table and economy_log).
var economyCols = []string{"at", "kind", "character_id", "other_character_id", "item_id", "count", "amount",
	"details", "batch_id", "batch_row"}

// AppendEconomy writes a batch of economy entries in one transaction: COPY into a temporary
// staging table, then INSERT … ON CONFLICT DO NOTHING on (batch_id, batch_row). Calling
// it again with the same batchID and entries (a retry after a timeout or a lost commit
// acknowledgement, when COPY may already have committed) writes nothing twice.
func (s *Store) AppendEconomy(ctx context.Context, batchID string, es []EconomyEntry) error {
	rows := make([][]any, len(es))
	for i, e := range es {
		details := []byte("{}")
		if e.Ref != "" {
			raw, err := json.Marshal(map[string]string{"ref": e.Ref})
			if err != nil {
				return fmt.Errorf("economy details: %w", err)
			}
			details = raw
		}
		rows[i] = []any{ts(e.At), e.Kind, optID(e.CharacterID), optID(e.OtherCharacterID),
			pgtype.Int4{Int32: int32(e.ItemID), Valid: e.ItemID != 0},
			pgtype.Int4{Int32: int32(e.Count), Valid: e.ItemID != 0},
			pgtype.Int8{Int64: e.Amount, Valid: e.ItemID == 0},
			details, batchID, int32(i)}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("append economy: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op after Commit
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE IF NOT EXISTS economy_staging (
		at TIMESTAMPTZ, kind TEXT, character_id BIGINT, other_character_id BIGINT, item_id INTEGER,
		count INTEGER, amount BIGINT, details JSONB, batch_id TEXT, batch_row INTEGER) ON COMMIT DELETE ROWS`); err != nil {
		return fmt.Errorf("append economy: staging: %w", err)
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"economy_staging"}, economyCols, pgx.CopyFromRows(rows)); err != nil {
		return fmt.Errorf("append economy: copy: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO economy_log (at, kind, character_id, other_character_id, item_id, count,
		amount, details, batch_id, batch_row)
		SELECT at, kind, character_id, other_character_id, item_id, count, amount, details, batch_id, batch_row
		FROM economy_staging ORDER BY batch_row
		ON CONFLICT (batch_id, batch_row) WHERE batch_id IS NOT NULL DO NOTHING`); err != nil {
		return fmt.Errorf("append economy: insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("append economy: commit: %w", err)
	}
	return nil
}

// ListEconomy returns the newest n entries of a character, newest first.
func (s *Store) ListEconomy(ctx context.Context, characterID int64, n int) ([]EconomyEntry, error) {
	rows, err := s.q.ListEconomy(ctx, db.ListEconomyParams{CharacterID: optID(characterID), MaxRows: int32(min(max(n, 1), 10000))})
	if err != nil {
		return nil, fmt.Errorf("list economy: %w", err)
	}
	out := make([]EconomyEntry, len(rows))
	for i, r := range rows {
		var d struct {
			Ref string `json:"ref"`
		}
		if err := json.Unmarshal(r.Details, &d); err != nil {
			return nil, fmt.Errorf("economy %d details: %w", r.ID, err)
		}
		out[i] = EconomyEntry{At: r.At.Time, Kind: r.Kind, CharacterID: r.CharacterID.Int64,
			OtherCharacterID: r.OtherCharacterID.Int64, ItemID: int(r.ItemID.Int32), Count: int(r.Count.Int32),
			Amount: r.Amount.Int64, Ref: d.Ref}
	}
	return out, nil
}
