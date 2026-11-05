package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

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

// AppendEconomy writes a batch of economy entries with COPY (one round trip).
func (s *Store) AppendEconomy(ctx context.Context, es []EconomyEntry) error {
	rows := make([]db.InsertEconomyParams, len(es))
	for i, e := range es {
		details := []byte("{}")
		if e.Ref != "" {
			raw, err := json.Marshal(map[string]string{"ref": e.Ref})
			if err != nil {
				return fmt.Errorf("economy details: %w", err)
			}
			details = raw
		}
		rows[i] = db.InsertEconomyParams{
			At:               ts(e.At),
			Kind:             e.Kind,
			CharacterID:      optID(e.CharacterID),
			OtherCharacterID: optID(e.OtherCharacterID),
			ItemID:           pgtype.Int4{Int32: int32(e.ItemID), Valid: e.ItemID != 0},
			Count:            pgtype.Int4{Int32: int32(e.Count), Valid: e.ItemID != 0},
			Amount:           pgtype.Int8{Int64: e.Amount, Valid: e.ItemID == 0},
			Details:          details,
		}
	}
	if _, err := s.q.InsertEconomy(ctx, rows); err != nil {
		return fmt.Errorf("append economy: %w", err)
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
