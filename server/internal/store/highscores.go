package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// HighscoreQuery selects one page of a ranking (T4.3).
type HighscoreQuery struct {
	// Skill ranks by that skill; empty ranks by level.
	Skill string
	// BaseLevel is the skill's level for characters without a row (data/balance.yaml).
	BaseLevel int
	// Vocation filters by vocation id; empty means every vocation.
	Vocation string
	Offset   int
	Limit    int
	// Now decides which bans are active.
	Now time.Time
}

// HighscoreRow is one ranked character: only public data.
type HighscoreRow struct {
	Name     string
	Vocation string
	Value    int64
}

// Highscores returns one page of the ranking. Staff, disabled and banned accounts are
// never ranked (queries/highscores.sql).
func (s *Store) Highscores(ctx context.Context, q HighscoreQuery) ([]HighscoreRow, error) {
	voc := pgtype.Text{String: q.Vocation, Valid: q.Vocation != ""}
	if q.Skill == "" {
		rows, err := s.q.HighscoresByLevel(ctx, db.HighscoresByLevelParams{
			Vocation: voc, Now: ts(q.Now), RowOffset: int32(q.Offset), RowLimit: int32(q.Limit),
		})
		if err != nil {
			return nil, fmt.Errorf("highscores by level: %w", err)
		}
		out := make([]HighscoreRow, len(rows))
		for i, r := range rows {
			out[i] = HighscoreRow{Name: r.Name, Vocation: r.Vocation, Value: r.Value}
		}
		return out, nil
	}
	// Part 1: characters with a row for the skill (index order). Asking for offset + limit
	// rows tells how many of them come before the page, so part 2 starts at the right row.
	rows, err := s.q.HighscoresBySkillRows(ctx, db.HighscoresBySkillRowsParams{
		Skill: q.Skill, Vocation: voc, Now: ts(q.Now),
		RowOffset: 0, RowLimit: int32(q.Offset + q.Limit),
	})
	if err != nil {
		return nil, fmt.Errorf("highscores by %s: %w", q.Skill, err)
	}
	out := make([]HighscoreRow, 0, q.Limit)
	for _, r := range rows[min(q.Offset, len(rows)):] {
		out = append(out, HighscoreRow{Name: r.Name, Vocation: r.Vocation, Value: r.Value})
	}
	if len(out) == q.Limit {
		return out, nil
	}
	// Part 2: characters still at the base level, after every character with a row.
	base, err := s.q.HighscoresBySkillBase(ctx, db.HighscoresBySkillBaseParams{
		Skill: q.Skill, Vocation: voc, Now: ts(q.Now),
		RowOffset: int32(max(q.Offset-len(rows), 0)), RowLimit: int32(q.Limit - len(out)),
	})
	if err != nil {
		return nil, fmt.Errorf("highscores by %s (base level): %w", q.Skill, err)
	}
	for _, r := range base {
		out = append(out, HighscoreRow{Name: r.Name, Vocation: r.Vocation, Value: int64(q.BaseLevel)})
	}
	return out, nil
}
