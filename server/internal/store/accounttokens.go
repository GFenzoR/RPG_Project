package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// TokenPurpose is what an emailed account token is for (account_tokens.purpose, T2.1).
type TokenPurpose string

// Account token purposes.
const (
	TokenVerifyEmail   TokenPurpose = "verify_email"
	TokenResetPassword TokenPurpose = "reset_password"
	// TokenClaimEmail is the reset link of an address nobody verified (lote 16): it
	// resets the password and verifies the address. A purpose of its own, so issuing it
	// never replaces the registration's verify_email link nor the other way around.
	TokenClaimEmail TokenPurpose = "claim_email"
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
	// Lote 17: "sign out everywhere" and a password change from the game.
	AuditSessionsRevoked = "sessions_revoked"
	AuditPasswordChanged = "password_changed"
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

// ResetPassword consumes a reset_password (or claim_email, which then also verifies the
// address) token valid at now, sets the new password
// hash, deletes the account's other reset tokens, revokes every session of the account,
// drops the linked identities that never proved the account's email and audits it, all
// in one transaction. ErrNotFound if the token is not valid, or its
// account is disabled or no longer has the address the link was sent to.
func (s *Store) ResetPassword(ctx context.Context, tokenHash []byte, passwordHash string, now time.Time) (int64, error) {
	var id int64
	err := s.inTx(ctx, func(q *db.Queries) error {
		row, err := q.ConsumeAccountToken(ctx, db.ConsumeAccountTokenParams{
			TokenHash: tokenHash, Purpose: string(TokenResetPassword), Now: ts(now),
		})
		claim := false
		if errors.Is(err, pgx.ErrNoRows) {
			// The reset of an address nobody ever verified sends a claim_email link
			// (auth.RequestPasswordReset): it proves the mailbox like a reset link, and
			// redeeming it also verifies the address, so the mailbox owner takes back a
			// squatted address.
			row, err = q.ConsumeAccountToken(ctx, db.ConsumeAccountTokenParams{
				TokenHash: tokenHash, Purpose: string(TokenClaimEmail), Now: ts(now),
			})
			claim = err == nil
		}
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
		if claim {
			for _, p := range []TokenPurpose{TokenVerifyEmail, TokenClaimEmail} {
				if err := q.DeleteAccountTokens(ctx, db.DeleteAccountTokensParams{AccountID: id, Purpose: string(p)}); err != nil {
					return err
				}
			}
			verified, err := q.MarkEmailVerified(ctx, db.MarkEmailVerifiedParams{At: ts(now), ID: id, Email: row.Email})
			if err != nil {
				return err
			}
			if verified > 0 {
				if err := appendAudit(ctx, q, AuditEntry{
					At: now, Source: AuditWeb, ActorAccountID: id, ActorName: "account",
					Action: AuditEmailVerified, TargetAccountID: id, Result: ResultOK,
				}); err != nil {
					return err
				}
			}
		}
		// Links in flight die with the sessions that started them.
		if err := q.DeleteAccountOAuthStates(ctx, pgtype.Int8{Int64: id, Valid: true}); err != nil {
			return err
		}
		n, err := q.DeleteAccountSessions(ctx, id)
		if err != nil {
			return err
		}
		// Linked identities that never proved this email (T2.1 2/2) go too: the address
		// may have been squatted through a provider before its owner took it back.
		dropped, err := q.DeleteUnprovenIdentities(ctx, db.DeleteUnprovenIdentitiesParams{AccountID: id, Email: row.Email})
		if err != nil {
			return err
		}
		return appendAudit(ctx, q, AuditEntry{
			At: now, Source: AuditWeb, ActorAccountID: id, ActorName: "account",
			Action: AuditPasswordReset, TargetAccountID: id,
			Args:   map[string]string{"sessions_revoked": fmt.Sprint(n), "identities_dropped": fmt.Sprint(dropped)},
			Result: ResultOK,
		})
	})
	if err != nil {
		return 0, fmt.Errorf("reset password: %w", err)
	}
	return id, nil
}

// RevokeAllSessions deletes every session of the account (account tokens of every device
// and pending play tokens) and its OAuth flows in flight, and audits it, in one
// transaction (lote 17, "sign out everywhere"). It returns how many sessions it deleted.
func (s *Store) RevokeAllSessions(ctx context.Context, accountID int64, now time.Time) (int64, error) {
	var n int64
	err := s.inTx(ctx, func(q *db.Queries) error {
		if err := q.DeleteAccountOAuthStates(ctx, pgtype.Int8{Int64: accountID, Valid: true}); err != nil {
			return err
		}
		var err error
		n, err = q.DeleteAccountSessions(ctx, accountID)
		if err != nil {
			return err
		}
		return appendAudit(ctx, q, AuditEntry{
			At: now, Source: AuditWeb, ActorAccountID: accountID, ActorName: "account",
			Action: AuditSessionsRevoked, TargetAccountID: accountID,
			Args: map[string]string{"sessions_revoked": fmt.Sprint(n)}, Result: ResultOK,
		})
	})
	if err != nil {
		return 0, fmt.Errorf("revoke all sessions: %w", err)
	}
	return n, nil
}

// ChangePassword sets the password hash of an account whose current password (or recent
// login) was already checked, and in the same transaction deletes every other session of
// the account (keep is the hash of the session that asked, which stays), its pending
// reset and claim links and its OAuth flows in flight, and audits it (lote 17). It
// returns how many sessions it revoked; ErrNotFound if the account is gone or disabled.
func (s *Store) ChangePassword(ctx context.Context, accountID int64, passwordHash string, keep []byte, now time.Time) (int64, error) {
	var n int64
	err := s.inTx(ctx, func(q *db.Queries) error {
		acc, err := q.GetAccountProfile(ctx, accountID)
		if err != nil {
			return notFound(err)
		}
		if acc.DisabledAt.Valid {
			return ErrNotFound
		}
		if err := q.SetPasswordHash(ctx, db.SetPasswordHashParams{
			PasswordHash: pgtype.Text{String: passwordHash, Valid: true}, ID: accountID,
		}); err != nil {
			return err
		}
		for _, p := range []TokenPurpose{TokenResetPassword, TokenClaimEmail} {
			if err := q.DeleteAccountTokens(ctx, db.DeleteAccountTokensParams{AccountID: accountID, Purpose: string(p)}); err != nil {
				return err
			}
		}
		if err := q.DeleteAccountOAuthStates(ctx, pgtype.Int8{Int64: accountID, Valid: true}); err != nil {
			return err
		}
		n, err = q.DeleteOtherAccountSessions(ctx, db.DeleteOtherAccountSessionsParams{AccountID: accountID, Keep: keep})
		if err != nil {
			return err
		}
		return appendAudit(ctx, q, AuditEntry{
			At: now, Source: AuditWeb, ActorAccountID: accountID, ActorName: "account",
			Action: AuditPasswordChanged, TargetAccountID: accountID,
			Args: map[string]string{"sessions_revoked": fmt.Sprint(n)}, Result: ResultOK,
		})
	})
	if err != nil {
		return 0, fmt.Errorf("change password: %w", err)
	}
	return n, nil
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
