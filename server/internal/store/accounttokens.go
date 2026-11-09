package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// TokenPurpose is what an emailed account token is for (account_tokens.purpose, T2.1).
type TokenPurpose string

// Account token purposes.
const (
	TokenVerifyEmail   TokenPurpose = "verify_email"
	TokenResetPassword TokenPurpose = "reset_password"
)

// AccountToken is an emailed single-use token. Only the SHA-256 of the token is kept.
type AccountToken struct {
	TokenHash []byte
	AccountID int64
	Purpose   TokenPurpose
	// Email is the address the link was sent to.
	Email     string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// Profile is an account as the account itself sees it.
type Profile struct {
	ID            int64
	Email         string
	HasPassword   bool
	EmailVerified bool
	Locale        string
	Disabled      bool
}

// Audit actions of the account flows (audit_log.action, source web or cli).
const (
	AuditEmailVerified  = "email_verified"
	AuditPasswordReset  = "password_reset"
	AuditResetLinkIssue = "reset_link_issued"
)

// ReplaceAccountToken deletes the account's tokens of t.Purpose and stores t, in one
// transaction: only the newest link of each purpose works.
func (s *Store) ReplaceAccountToken(ctx context.Context, t AccountToken) error {
	err := s.inTx(ctx, func(q *db.Queries) error {
		if err := q.DeleteAccountTokens(ctx, db.DeleteAccountTokensParams{AccountID: t.AccountID, Purpose: string(t.Purpose)}); err != nil {
			return err
		}
		return q.CreateAccountToken(ctx, db.CreateAccountTokenParams{
			TokenHash: t.TokenHash, AccountID: t.AccountID, Purpose: string(t.Purpose),
			Email: t.Email, CreatedAt: ts(t.CreatedAt), ExpiresAt: ts(t.ExpiresAt),
		})
	})
	if err != nil {
		return fmt.Errorf("replace account token: %w", err)
	}
	return nil
}

// VerifyEmail consumes a verify_email token valid at now and marks the address it was
// sent to as verified, auditing it, in one transaction. It returns the account id, or
// ErrNotFound if the token is unknown, used, expired or for another address.
func (s *Store) VerifyEmail(ctx context.Context, tokenHash []byte, now time.Time) (int64, error) {
	var id int64
	err := s.inTx(ctx, func(q *db.Queries) error {
		row, err := q.ConsumeAccountToken(ctx, db.ConsumeAccountTokenParams{
			TokenHash: tokenHash, Purpose: string(TokenVerifyEmail), Now: ts(now),
		})
		if err != nil {
			return notFound(err)
		}
		n, err := q.MarkEmailVerified(ctx, db.MarkEmailVerifiedParams{At: ts(now), ID: row.AccountID, Email: row.Email})
		if err != nil {
			return err
		}
		if n == 0 {
			// Already verified or the address changed: the token is spent either way.
			id = row.AccountID
			return nil
		}
		id = row.AccountID
		return appendAudit(ctx, q, AuditEntry{
			At: now, Source: AuditWeb, ActorAccountID: id, ActorName: "account",
			Action: AuditEmailVerified, TargetAccountID: id, Result: ResultOK,
		})
	})
	if err != nil {
		return 0, fmt.Errorf("verify email: %w", err)
	}
	return id, nil
}

// ResetPassword consumes a reset_password token valid at now, sets the new password
// hash, deletes the account's other reset tokens, revokes every session of the account
// and audits it, all in one transaction. ErrNotFound if the token is not valid, or its
// account is disabled or no longer has the address the link was sent to.
func (s *Store) ResetPassword(ctx context.Context, tokenHash []byte, passwordHash string, now time.Time) (int64, error) {
	var id int64
	err := s.inTx(ctx, func(q *db.Queries) error {
		row, err := q.ConsumeAccountToken(ctx, db.ConsumeAccountTokenParams{
			TokenHash: tokenHash, Purpose: string(TokenResetPassword), Now: ts(now),
		})
		if err != nil {
			return notFound(err)
		}
		id = row.AccountID
		// The account must still be enabled and still have the address the link went to.
		acc, err := q.GetAccountProfile(ctx, id)
		if err != nil {
			return err
		}
		if acc.DisabledAt.Valid || acc.Email != row.Email {
			return ErrNotFound // the token is spent: the rollback keeps it, but it cannot work
		}
		if err := q.SetPasswordHash(ctx, db.SetPasswordHashParams{
			PasswordHash: pgtype.Text{String: passwordHash, Valid: true}, ID: id,
		}); err != nil {
			return err
		}
		if err := q.DeleteAccountTokens(ctx, db.DeleteAccountTokensParams{AccountID: id, Purpose: string(TokenResetPassword)}); err != nil {
			return err
		}
		n, err := q.DeleteAccountSessions(ctx, id)
		if err != nil {
			return err
		}
		return appendAudit(ctx, q, AuditEntry{
			At: now, Source: AuditWeb, ActorAccountID: id, ActorName: "account",
			Action: AuditPasswordReset, TargetAccountID: id,
			Args: map[string]string{"sessions_revoked": fmt.Sprint(n)}, Result: ResultOK,
		})
	})
	if err != nil {
		return 0, fmt.Errorf("reset password: %w", err)
	}
	return id, nil
}

// DeleteExpiredAccountTokens removes tokens expired at now and returns how many.
func (s *Store) DeleteExpiredAccountTokens(ctx context.Context, now time.Time) (int64, error) {
	n, err := s.q.DeleteExpiredAccountTokens(ctx, ts(now))
	if err != nil {
		return 0, fmt.Errorf("delete expired account tokens: %w", err)
	}
	return n, nil
}

// AccountProfile returns the account (ErrNotFound if it does not exist).
func (s *Store) AccountProfile(ctx context.Context, accountID int64) (Profile, error) {
	row, err := s.q.GetAccountProfile(ctx, accountID)
	if err != nil {
		return Profile{}, fmt.Errorf("account profile: %w", notFound(err))
	}
	return Profile{
		ID: row.ID, Email: row.Email, HasPassword: row.PasswordHash.Valid,
		EmailVerified: row.EmailVerifiedAt.Valid, Locale: row.Locale, Disabled: row.DisabledAt.Valid,
	}, nil
}

// SetAccountLocale stores the language of the account's emails.
func (s *Store) SetAccountLocale(ctx context.Context, accountID int64, locale string) error {
	if err := s.q.SetAccountLocale(ctx, db.SetAccountLocaleParams{ID: accountID, Locale: locale}); err != nil {
		return fmt.Errorf("set account locale: %w", err)
	}
	return nil
}

// AccountProfileByEmail returns the account with that (normalized) email, or ErrNotFound.
func (s *Store) AccountProfileByEmail(ctx context.Context, email string) (Profile, error) {
	row, err := s.q.GetAccountProfileByEmail(ctx, email)
	if err != nil {
		return Profile{}, fmt.Errorf("account profile: %w", notFound(err))
	}
	return Profile{
		ID: row.ID, Email: row.Email, HasPassword: row.PasswordHash.Valid,
		EmailVerified: row.EmailVerifiedAt.Valid, Locale: row.Locale, Disabled: row.DisabledAt.Valid,
	}, nil
}
