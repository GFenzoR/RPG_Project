package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// OAuth login and linked identities (T2.1 2/2, migration 00012).

// Errors of the identity operations.
var (
	// ErrIdentityTaken: the provider identity is linked to another account.
	ErrIdentityTaken = errors.New("store: identity linked to another account")
	// ErrProviderLinked: the account already has an identity of that provider.
	ErrProviderLinked = errors.New("store: account already linked to this provider")
	// ErrLastLoginMethod: unlinking would leave the account without a way to log in.
	ErrLastLoginMethod = errors.New("store: last login method")
)

const (
	identitiesPKey        = "account_identities_pkey"
	identitiesProviderKey = "account_identities_account_id_provider_key"
)

// Audit actions of the identity operations (source web; the email never goes in).
const (
	AuditIdentityLinked   = "identity_linked"
	AuditIdentityUnlinked = "identity_unlinked"
	AuditOAuthAccount     = "oauth_account_created"
)

// ExternalIdentity is an identity as the provider reported it.
type ExternalIdentity struct {
	Provider      string
	Subject       string
	Email         string
	EmailVerified bool
}

// Identity is a linked identity as the account sees it.
type Identity struct {
	Provider  string
	Email     string
	CreatedAt time.Time
}

// OAuthState is a login or link in flight (oauth_states).
type OAuthState struct {
	StateHash   []byte
	BindingHash []byte
	Provider    string
	Verifier    string
	Nonce       string
	Mode        string // "login" or "link"
	AccountID   int64  // the account to link to (mode link)
	// SessionHash is the SHA-256 of the session that passed the re-authentication (mode
	// link): the callback links only while it is active.
	SessionHash []byte
	ReturnTo    string
	ExpiresAt   time.Time
}

// OAuthPending is an identity waiting for its user to choose (oauth_pending).
type OAuthPending struct {
	Identity ExternalIdentity
	ReturnTo string
}

// CreateOAuthState stores a login or link in flight.
func (s *Store) CreateOAuthState(ctx context.Context, st OAuthState) error {
	err := s.q.CreateOAuthState(ctx, db.CreateOAuthStateParams{
		StateHash: st.StateHash, BindingHash: st.BindingHash, Provider: st.Provider,
		Verifier: st.Verifier, Nonce: st.Nonce, Mode: st.Mode,
		AccountID:   pgtype.Int8{Int64: st.AccountID, Valid: st.AccountID != 0},
		SessionHash: st.SessionHash,
		ReturnTo:    st.ReturnTo, ExpiresAt: ts(st.ExpiresAt),
	})
	if err != nil {
		return fmt.Errorf("create oauth state: %w", err)
	}
	return nil
}

// ConsumeOAuthState deletes and returns the state if it is still valid at now
// (ErrNotFound otherwise): a state works once.
func (s *Store) ConsumeOAuthState(ctx context.Context, stateHash []byte, now time.Time) (OAuthState, error) {
	row, err := s.q.ConsumeOAuthState(ctx, db.ConsumeOAuthStateParams{StateHash: stateHash, Now: ts(now)})
	if err != nil {
		return OAuthState{}, fmt.Errorf("consume oauth state: %w", notFound(err))
	}
	return OAuthState{
		StateHash: stateHash, BindingHash: row.BindingHash, Provider: row.Provider,
		Verifier: row.Verifier, Nonce: row.Nonce, Mode: row.Mode, AccountID: row.AccountID.Int64,
		SessionHash: row.SessionHash, ReturnTo: row.ReturnTo,
	}, nil
}

// IdentityAccount returns the account an identity is linked to, or ErrNotFound.
func (s *Store) IdentityAccount(ctx context.Context, provider, subject string) (int64, error) {
	id, err := s.q.GetIdentity(ctx, db.GetIdentityParams{Provider: provider, Subject: subject})
	if err != nil {
		return 0, fmt.Errorf("identity: %w", notFound(err))
	}
	return id, nil
}

func identityError(err error) error {
	switch {
	case uniqueViolation(err, identitiesPKey):
		return ErrIdentityTaken
	case uniqueViolation(err, identitiesProviderKey):
		return ErrProviderLinked
	}
	return err
}

func insertIdentity(ctx context.Context, q *db.Queries, accountID int64, id ExternalIdentity, at time.Time) error {
	return identityError(q.InsertIdentity(ctx, db.InsertIdentityParams{
		Provider: id.Provider, Subject: id.Subject, AccountID: accountID, Email: id.Email,
		EmailVerified: id.EmailVerified, CreatedAt: ts(at),
	}))
}

func identityAudit(action string, accountID int64, provider string, at time.Time) AuditEntry {
	return AuditEntry{
		At: at, Source: AuditWeb, ActorAccountID: accountID, ActorName: "account", Action: action,
		TargetAccountID: accountID, Args: map[string]string{"provider": provider}, Result: ResultOK,
	}
}

// LinkIdentity links id to the account and audits it, in one transaction.
// ErrIdentityTaken / ErrProviderLinked on a conflict.
func (s *Store) LinkIdentity(ctx context.Context, accountID int64, id ExternalIdentity, at time.Time) error {
	err := s.inTx(ctx, func(q *db.Queries) error {
		if err := insertIdentity(ctx, q, accountID, id, at); err != nil {
			return err
		}
		return appendAudit(ctx, q, identityAudit(AuditIdentityLinked, accountID, id.Provider, at))
	})
	if err != nil {
		return fmt.Errorf("link identity: %w", err)
	}
	return nil
}

// CreateOAuthAccount creates an account without a password, with email (verified at at
// only if verified), links id to it and audits it, in one transaction. ErrEmailTaken if
// the email has an account; ErrIdentityTaken if the identity is linked meanwhile.
func (s *Store) CreateOAuthAccount(ctx context.Context, email string, verified bool, id ExternalIdentity, at time.Time) (int64, error) {
	var accountID int64
	err := s.inTx(ctx, func(q *db.Queries) error {
		var err error
		accountID, err = q.CreateOAuthAccount(ctx, db.CreateOAuthAccountParams{
			Email: email, EmailVerifiedAt: pgtype.Timestamptz{Time: at, Valid: verified},
		})
		if uniqueViolation(err, accountsEmailKey) {
			return ErrEmailTaken
		}
		if err != nil {
			return err
		}
		if err := insertIdentity(ctx, q, accountID, id, at); err != nil {
			return err
		}
		return appendAudit(ctx, q, identityAudit(AuditOAuthAccount, accountID, id.Provider, at))
	})
	if err != nil {
		return 0, fmt.Errorf("create oauth account: %w", err)
	}
	return accountID, nil
}

// Identities lists the account's linked identities.
func (s *Store) Identities(ctx context.Context, accountID int64) ([]Identity, error) {
	rows, err := s.q.ListIdentities(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("identities: %w", err)
	}
	out := make([]Identity, len(rows))
	for i, r := range rows {
		out[i] = Identity{Provider: r.Provider, Email: r.Email, CreatedAt: r.CreatedAt.Time}
	}
	return out, nil
}

// UnlinkIdentity removes the account's identity of provider and audits it, unless it is
// the account's last way to log in (no password, no other identity): ErrLastLoginMethod.
// ErrNotFound if there is no such identity.
func (s *Store) UnlinkIdentity(ctx context.Context, accountID int64, provider string, at time.Time) error {
	err := s.inTx(ctx, func(q *db.Queries) error {
		acc, err := q.LockAccountForIdentities(ctx, accountID)
		if err != nil {
			return notFound(err)
		}
		n, err := q.CountIdentities(ctx, accountID)
		if err != nil {
			return err
		}
		if !acc.PasswordHash.Valid && n <= 1 {
			return ErrLastLoginMethod
		}
		deleted, err := q.DeleteIdentity(ctx, db.DeleteIdentityParams{AccountID: accountID, Provider: provider})
		if err != nil {
			return err
		}
		if deleted == 0 {
			return ErrNotFound
		}
		return appendAudit(ctx, q, identityAudit(AuditIdentityUnlinked, accountID, provider, at))
	})
	if err != nil {
		return fmt.Errorf("unlink identity: %w", err)
	}
	return nil
}

// CreateOAuthPending stores an identity waiting for its user to choose.
func (s *Store) CreateOAuthPending(ctx context.Context, tokenHash []byte, p OAuthPending, expires time.Time) error {
	err := s.q.CreateOAuthPending(ctx, db.CreateOAuthPendingParams{
		TokenHash: tokenHash, Provider: p.Identity.Provider, Subject: p.Identity.Subject,
		Email: p.Identity.Email, EmailVerified: p.Identity.EmailVerified, ReturnTo: p.ReturnTo,
		ExpiresAt: ts(expires),
	})
	if err != nil {
		return fmt.Errorf("create oauth pending: %w", err)
	}
	return nil
}

// OAuthPendingByToken returns a pending identity valid at now, or ErrNotFound.
func (s *Store) OAuthPendingByToken(ctx context.Context, tokenHash []byte, now time.Time) (OAuthPending, error) {
	row, err := s.q.GetOAuthPending(ctx, db.GetOAuthPendingParams{TokenHash: tokenHash, Now: ts(now)})
	if err != nil {
		return OAuthPending{}, fmt.Errorf("oauth pending: %w", notFound(err))
	}
	return OAuthPending{
		Identity: ExternalIdentity{Provider: row.Provider, Subject: row.Subject, Email: row.Email, EmailVerified: row.EmailVerified},
		ReturnTo: row.ReturnTo,
	}, nil
}

// DeleteOAuthPending removes a pending identity (used or abandoned).
func (s *Store) DeleteOAuthPending(ctx context.Context, tokenHash []byte) error {
	if _, err := s.q.DeleteOAuthPending(ctx, tokenHash); err != nil {
		return fmt.Errorf("delete oauth pending: %w", err)
	}
	return nil
}

// DeleteExpiredOAuth removes expired states and pending identities.
func (s *Store) DeleteExpiredOAuth(ctx context.Context, now time.Time) (int64, error) {
	n, err := s.q.DeleteExpiredOAuth(ctx, ts(now))
	if err != nil {
		return 0, fmt.Errorf("delete expired oauth: %w", err)
	}
	return n, nil
}
