package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Account is the login view of an account row.
type Account struct {
	ID           int64
	Email        string
	PasswordHash string // empty if the account has no password (OAuth only)
	Disabled     bool
}

// SessionKind distinguishes HTTP API tokens from WebSocket play tokens.
type SessionKind string

// Session kinds (sessions.kind).
const (
	SessionAccount SessionKind = "account"
	SessionPlay    SessionKind = "play"
)

// Session is a stored session token. Only the SHA-256 of the token is kept.
type Session struct {
	TokenHash   []byte
	AccountID   int64
	Kind        SessionKind
	CharacterID int64 // 0 unless Kind is SessionPlay
	CreatedAt   time.Time
	ExpiresAt   time.Time
}

// Character is the summary shown in the character list.
type Character struct {
	ID       int64
	Name     string
	Vocation string
	Level    int
}

// NewCharacter is the input to CreateCharacter. Values are already validated.
type NewCharacter struct {
	AccountID int64
	Name      string
	Vocation  string
	Health    int
	Mana      int
}

// CreateAccount inserts an account. email must already be normalized (lowercase).
func (s *Store) CreateAccount(ctx context.Context, email, passwordHash string) (int64, error) {
	row, err := s.q.CreateAccount(ctx, db.CreateAccountParams{
		Email:        email,
		PasswordHash: pgtype.Text{String: passwordHash, Valid: passwordHash != ""},
	})
	if uniqueViolation(err, accountsEmailKey) {
		return 0, ErrEmailTaken
	}
	if err != nil {
		return 0, fmt.Errorf("create account: %w", err)
	}
	return row.ID, nil
}

// AccountByEmail returns ErrNotFound if no account has that (normalized) email.
func (s *Store) AccountByEmail(ctx context.Context, email string) (Account, error) {
	row, err := s.q.GetAccountByEmail(ctx, email)
	if err != nil {
		return Account{}, fmt.Errorf("account by email: %w", notFound(err))
	}
	return Account{
		ID:           row.ID,
		Email:        row.Email,
		PasswordHash: row.PasswordHash.String,
		Disabled:     row.DisabledAt.Valid,
	}, nil
}

// TouchLogin records a successful login.
func (s *Store) TouchLogin(ctx context.Context, accountID int64, at time.Time) error {
	if err := s.q.TouchAccountLogin(ctx, db.TouchAccountLoginParams{ID: accountID, At: ts(at)}); err != nil {
		return fmt.Errorf("touch login: %w", err)
	}
	return nil
}

// CreateSession stores a session token hash.
func (s *Store) CreateSession(ctx context.Context, sess Session) error {
	err := s.q.CreateSession(ctx, db.CreateSessionParams{
		TokenHash:   sess.TokenHash,
		AccountID:   sess.AccountID,
		Kind:        string(sess.Kind),
		CharacterID: pgtype.Int8{Int64: sess.CharacterID, Valid: sess.CharacterID != 0},
		CreatedAt:   ts(sess.CreatedAt),
		ExpiresAt:   ts(sess.ExpiresAt),
	})
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	return nil
}

// ActiveSession returns the session for tokenHash if it has the given kind, has not
// expired at now and its account is not disabled. Otherwise it returns ErrNotFound.
func (s *Store) ActiveSession(ctx context.Context, tokenHash []byte, kind SessionKind, now time.Time) (Session, error) {
	row, err := s.q.GetActiveSession(ctx, db.GetActiveSessionParams{
		TokenHash: tokenHash,
		Kind:      string(kind),
		Now:       ts(now),
	})
	if err != nil {
		return Session{}, fmt.Errorf("active session: %w", notFound(err))
	}
	return Session{
		TokenHash:   tokenHash,
		AccountID:   row.AccountID,
		Kind:        kind,
		CharacterID: row.CharacterID.Int64,
		ExpiresAt:   row.ExpiresAt.Time,
	}, nil
}

// DeleteSession revokes a session. Deleting a missing session is not an error.
func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) error {
	if err := s.q.DeleteSession(ctx, tokenHash); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// DeleteExpiredSessions removes sessions expired at now and returns how many.
func (s *Store) DeleteExpiredSessions(ctx context.Context, now time.Time) (int64, error) {
	n, err := s.q.DeleteExpiredSessions(ctx, ts(now))
	if err != nil {
		return 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	return n, nil
}

// ListCharacters returns the account's characters ordered by creation.
func (s *Store) ListCharacters(ctx context.Context, accountID int64) ([]Character, error) {
	rows, err := s.q.ListCharactersByAccount(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("list characters: %w", err)
	}
	out := make([]Character, len(rows))
	for i, r := range rows {
		out[i] = Character{ID: r.ID, Name: r.Name, Vocation: r.Vocation, Level: int(r.Level)}
	}
	return out, nil
}

// CreateCharacter inserts a character unless the account already has maxPerAccount
// characters (ErrCharacterLimit) or the name is taken ignoring case (ErrNameTaken).
// The account row is locked so concurrent creations cannot exceed the limit.
func (s *Store) CreateCharacter(ctx context.Context, c NewCharacter, maxPerAccount int) (Character, error) {
	var out Character
	err := s.inTx(ctx, func(q *db.Queries) error {
		if _, err := q.LockAccount(ctx, c.AccountID); err != nil {
			return fmt.Errorf("lock account: %w", notFound(err))
		}
		n, err := q.CountCharactersByAccount(ctx, c.AccountID)
		if err != nil {
			return fmt.Errorf("count characters: %w", err)
		}
		if n >= int64(maxPerAccount) {
			return ErrCharacterLimit
		}
		row, err := q.CreateCharacter(ctx, db.CreateCharacterParams{
			AccountID: c.AccountID,
			Name:      c.Name,
			Vocation:  c.Vocation,
			Health:    int32(c.Health),
			Mana:      int32(c.Mana),
		})
		if uniqueViolation(err, charactersNameKey) {
			return ErrNameTaken
		}
		if err != nil {
			return fmt.Errorf("insert character: %w", err)
		}
		out = Character{ID: row.ID, Name: row.Name, Vocation: row.Vocation, Level: int(row.Level)}
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrCharacterLimit) || errors.Is(err, ErrNameTaken) {
			return Character{}, err
		}
		return Character{}, fmt.Errorf("create character: %w", err)
	}
	return out, nil
}
