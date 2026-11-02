package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// PlayCharacter is what the game server loads to put a character in the world.
type PlayCharacter struct {
	ID         int64
	AccountID  int64
	Name       string
	Vocation   string
	Level      int
	Experience int64
	Health     int
	Mana       int
	// HasPos is false until the first save: the server then places the character at
	// its town's temple.
	HasPos bool
	X, Y   int
	Z      int
	Town   string
	// Skills are the saved skills; a skill without a row is at its base level.
	Skills []Skill
}

// Skill is one row of character_skills.
type Skill struct {
	ID    string
	Level int
	Tries int64
}

// CharacterState is the part of a character the game loop saves (logout and autosave).
type CharacterState struct {
	ID         int64
	Level      int
	Experience int64
	Health     int
	Mana       int
	X, Y, Z    int
	// Skills are upserted with the character row, in the same transaction.
	Skills  []Skill
	SavedAt time.Time
}

// CharacterBelongsTo reports whether characterID is a character of accountID.
func (s *Store) CharacterBelongsTo(ctx context.Context, accountID, characterID int64) (bool, error) {
	ok, err := s.q.CharacterBelongsToAccount(ctx, db.CharacterBelongsToAccountParams{ID: characterID, AccountID: accountID})
	if err != nil {
		return false, fmt.Errorf("character belongs to account: %w", err)
	}
	return ok, nil
}

// ConsumeSession deletes the session for tokenHash and returns it, if it had the given
// kind, had not expired at now and its account is not disabled. Otherwise it returns
// ErrNotFound. A token can be consumed only once.
func (s *Store) ConsumeSession(ctx context.Context, tokenHash []byte, kind SessionKind, now time.Time) (Session, error) {
	row, err := s.q.ConsumeSession(ctx, db.ConsumeSessionParams{TokenHash: tokenHash, Kind: string(kind), Now: ts(now)})
	if err != nil {
		return Session{}, fmt.Errorf("consume session: %w", notFound(err))
	}
	return Session{
		TokenHash:   tokenHash,
		AccountID:   row.AccountID,
		Kind:        kind,
		CharacterID: row.CharacterID.Int64,
		ExpiresAt:   row.ExpiresAt.Time,
	}, nil
}

// PlayCharacter loads character id of account accountID (ErrNotFound if it is not theirs)
// and records the login time.
func (s *Store) PlayCharacter(ctx context.Context, accountID, id int64, now time.Time) (PlayCharacter, error) {
	row, err := s.q.GetCharacterForPlay(ctx, db.GetCharacterForPlayParams{ID: id, AccountID: accountID})
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("play character: %w", notFound(err))
	}
	if err := s.q.TouchCharacterLogin(ctx, db.TouchCharacterLoginParams{ID: id, At: ts(now)}); err != nil {
		return PlayCharacter{}, fmt.Errorf("touch character login: %w", err)
	}
	rows, err := s.q.GetCharacterSkills(ctx, id)
	if err != nil {
		return PlayCharacter{}, fmt.Errorf("character skills: %w", err)
	}
	skills := make([]Skill, len(rows))
	for i, r := range rows {
		skills[i] = Skill{ID: r.Skill, Level: int(r.Level), Tries: r.Tries}
	}
	return PlayCharacter{
		Skills:     skills,
		ID:         row.ID,
		AccountID:  row.AccountID,
		Name:       row.Name,
		Vocation:   row.Vocation,
		Level:      int(row.Level),
		Experience: row.Experience,
		Health:     int(row.Health),
		Mana:       int(row.Mana),
		HasPos:     row.PosX.Valid,
		X:          int(row.PosX.Int32),
		Y:          int(row.PosY.Int32),
		Z:          int(row.PosZ.Int16),
		Town:       row.Town,
	}, nil
}

// SaveCharacterState writes a snapshot of the character. ErrNotFound means the
// character no longer exists (deleted while online); there is nothing to retry.
func (s *Store) SaveCharacterState(ctx context.Context, c CharacterState) error {
	return s.inTx(ctx, func(q *db.Queries) error { return saveCharacterState(ctx, q, c) })
}

func saveCharacterState(ctx context.Context, q *db.Queries, c CharacterState) error {
	n, err := q.SaveCharacterState(ctx, db.SaveCharacterStateParams{
		ID:         c.ID,
		Level:      int32(c.Level),
		Experience: c.Experience,
		Health:     int32(c.Health),
		Mana:       int32(c.Mana),
		PosX:       pgtype.Int4{Int32: int32(c.X), Valid: true},
		PosY:       pgtype.Int4{Int32: int32(c.Y), Valid: true},
		PosZ:       pgtype.Int2{Int16: int16(c.Z), Valid: true},
		SavedAt:    ts(c.SavedAt),
	})
	if err != nil {
		return fmt.Errorf("save character %d: %w", c.ID, err)
	}
	if n == 0 {
		return fmt.Errorf("save character %d: %w", c.ID, ErrNotFound)
	}
	if len(c.Skills) == 0 {
		return nil
	}
	p := db.SaveCharacterSkillsParams{CharacterID: c.ID, Skills: make([]string, len(c.Skills)),
		Levels: make([]int32, len(c.Skills)), Tries: make([]int64, len(c.Skills))}
	for i, sk := range c.Skills {
		p.Skills[i], p.Levels[i], p.Tries[i] = sk.ID, int32(sk.Level), sk.Tries
	}
	if err := q.SaveCharacterSkills(ctx, p); err != nil {
		return fmt.Errorf("save skills of character %d: %w", c.ID, err)
	}
	return nil
}
