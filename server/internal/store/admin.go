package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Account roles (accounts.role, T2.6). Only the operator's tool assigns them.
const (
	RolePlayer = "player"
	RoleGM     = "gm"
	RoleAdmin  = "admin"
)

// RoleRank orders the roles: player 0, gm 1, admin 2. An unknown role ranks as a player.
func RoleRank(role string) int {
	switch role {
	case RoleGM:
		return 1
	case RoleAdmin:
		return 2
	default:
		return 0
	}
}

// ValidRole reports whether role is one of the roles above.
func ValidRole(role string) bool {
	return role == RolePlayer || role == RoleGM || role == RoleAdmin
}

// Audit sources (audit_log.source).
const (
	AuditGame = "game"
	AuditCLI  = "cli"
)

// Results of a ban or unban (and audit_log.result values besides the caller's own).
const (
	ResultOK        = "ok"
	ResultNotFound  = "not_found"
	ResultProtected = "protected"
	ResultNotBanned = "not_banned"
)

// Ban is an active ban of an account.
type Ban struct {
	ID     int64
	Reason string
	// ExpiresAt is zero for a permanent ban.
	ExpiresAt time.Time
}

// Permanent reports whether the ban never expires.
func (b Ban) Permanent() bool { return b.ExpiresAt.IsZero() }

// AuditEntry is one row of the append-only audit_log. Zero ids are stored as NULL.
type AuditEntry struct {
	At                time.Time
	Source            string
	ActorAccountID    int64
	ActorCharacterID  int64
	ActorName         string
	Action            string
	TargetAccountID   int64
	TargetCharacterID int64
	TargetName        string
	Args              map[string]string
	Result            string
}

// BanRequest is a ban or unban by a staff member. Audit carries the actor, the time
// (also the ban's start), the action and its arguments; the store fills in the target
// and the result.
type BanRequest struct {
	Audit      AuditEntry
	TargetName string
	// ActorRank is RoleRank of the actor: a ban only reaches lower ranks.
	ActorRank int
	Reason    string
	// ExpiresAt is zero for a permanent ban. Unused by Unban.
	ExpiresAt time.Time
}

// BanResult is the outcome of a ban or unban.
type BanResult struct {
	Result      string // ResultOK, ResultNotFound, ResultProtected or ResultNotBanned
	AccountID   int64
	CharacterID int64
	Name        string
	role        string // the target account's role
}

// ActiveBan returns the active ban of an account at now that ends last (a permanent one
// first), or ErrNotFound.
func (s *Store) ActiveBan(ctx context.Context, accountID int64, now time.Time) (Ban, error) {
	row, err := s.q.GetActiveBan(ctx, db.GetActiveBanParams{AccountID: accountID, Now: ts(now)})
	if err != nil {
		return Ban{}, fmt.Errorf("active ban: %w", notFound(err))
	}
	b := Ban{ID: row.ID, Reason: row.Reason}
	if row.ExpiresAt.Valid {
		b.ExpiresAt = row.ExpiresAt.Time
	}
	return b, nil
}

// AppendAudit inserts one audit entry.
func (s *Store) AppendAudit(ctx context.Context, e AuditEntry) error {
	if err := appendAudit(ctx, s.q, e); err != nil {
		return fmt.Errorf("append audit: %w", err)
	}
	return nil
}

func appendAudit(ctx context.Context, q *db.Queries, e AuditEntry) error {
	args := e.Args
	if args == nil {
		args = map[string]string{}
	}
	raw, err := json.Marshal(args) // map keys are sorted: deterministic
	if err != nil {
		return fmt.Errorf("audit args: %w", err)
	}
	return q.InsertAudit(ctx, db.InsertAuditParams{
		At:                ts(e.At),
		Source:            e.Source,
		ActorAccountID:    optID(e.ActorAccountID),
		ActorCharacterID:  optID(e.ActorCharacterID),
		ActorName:         e.ActorName,
		Action:            e.Action,
		TargetAccountID:   optID(e.TargetAccountID),
		TargetCharacterID: optID(e.TargetCharacterID),
		TargetName:        e.TargetName,
		Args:              raw,
		Result:            e.Result,
	})
}

// ListAudit returns the newest n audit entries, newest first.
func (s *Store) ListAudit(ctx context.Context, n int) ([]AuditEntry, error) {
	rows, err := s.q.ListAudit(ctx, int32(min(max(n, 1), 10000)))
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	out := make([]AuditEntry, len(rows))
	for i, r := range rows {
		e := AuditEntry{
			At:                r.At.Time,
			Source:            r.Source,
			ActorAccountID:    r.ActorAccountID.Int64,
			ActorCharacterID:  r.ActorCharacterID.Int64,
			ActorName:         r.ActorName,
			Action:            r.Action,
			TargetAccountID:   r.TargetAccountID.Int64,
			TargetCharacterID: r.TargetCharacterID.Int64,
			TargetName:        r.TargetName,
			Result:            r.Result,
		}
		if err := json.Unmarshal(r.Args, &e.Args); err != nil {
			return nil, fmt.Errorf("audit %d args: %w", r.ID, err)
		}
		out[i] = e
	}
	return out, nil
}

// Ban bans the account of character r.TargetName, revokes every token of that account
// and records the audit entry, all in one transaction. A missing character or one whose
// account ranks at or above the actor is not banned; the attempt is still audited.
func (s *Store) Ban(ctx context.Context, r BanRequest) (BanResult, error) {
	var res BanResult
	err := s.inTx(ctx, func(q *db.Queries) error {
		var err error
		res, err = target(ctx, q, r.TargetName)
		if err != nil {
			return err
		}
		if res.Result == ResultOK && RoleRank(res.role) >= r.ActorRank {
			res.Result = ResultProtected
		}
		if res.Result == ResultOK {
			exp := pgtype.Timestamptz{}
			if !r.ExpiresAt.IsZero() {
				exp = ts(r.ExpiresAt)
			}
			if _, err := q.InsertBan(ctx, db.InsertBanParams{
				AccountID: res.AccountID,
				Reason:    r.Reason,
				BannedBy:  optID(r.Audit.ActorAccountID),
				CreatedAt: ts(r.Audit.At),
				ExpiresAt: exp,
			}); err != nil {
				return fmt.Errorf("insert ban: %w", err)
			}
			if _, err := q.DeleteAccountSessions(ctx, res.AccountID); err != nil {
				return fmt.Errorf("revoke sessions: %w", err)
			}
		}
		return appendAudit(ctx, q, withTarget(r.Audit, res))
	})
	if err != nil {
		return BanResult{}, fmt.Errorf("ban: %w", err)
	}
	return res, nil
}

// Unban lifts every active ban of the account of character r.TargetName and records
// the audit entry in the same transaction.
func (s *Store) Unban(ctx context.Context, r BanRequest) (BanResult, error) {
	var res BanResult
	err := s.inTx(ctx, func(q *db.Queries) error {
		var err error
		res, err = target(ctx, q, r.TargetName)
		if err != nil {
			return err
		}
		if res.Result == ResultOK {
			n, err := q.LiftBans(ctx, db.LiftBansParams{Now: ts(r.Audit.At), LiftedBy: optID(r.Audit.ActorAccountID), AccountID: res.AccountID})
			if err != nil {
				return fmt.Errorf("lift bans: %w", err)
			}
			if n == 0 {
				res.Result = ResultNotBanned
			}
		}
		return appendAudit(ctx, q, withTarget(r.Audit, res))
	})
	if err != nil {
		return BanResult{}, fmt.Errorf("unban: %w", err)
	}
	return res, nil
}

// target resolves a character name; a missing one gives ResultNotFound (no error).
func target(ctx context.Context, q *db.Queries, name string) (BanResult, error) {
	row, err := q.GetCharacterTarget(ctx, name)
	if err != nil {
		if errors.Is(notFound(err), ErrNotFound) {
			return BanResult{Result: ResultNotFound, Name: name}, nil
		}
		return BanResult{}, fmt.Errorf("find character: %w", err)
	}
	return BanResult{Result: ResultOK, AccountID: row.AccountID, CharacterID: row.ID, Name: row.Name, role: row.Role}, nil
}

func withTarget(e AuditEntry, r BanResult) AuditEntry {
	e.TargetAccountID, e.TargetCharacterID, e.TargetName, e.Result = r.AccountID, r.CharacterID, r.Name, r.Result
	return e
}

// SetRole sets the role of the account with that (normalized) email and records the
// change in the audit log (action "set_role", args old/new role plus audit.Args) in one
// transaction.
// It returns ErrNotFound if no account has that email.
func (s *Store) SetRole(ctx context.Context, email, role string, audit AuditEntry) (accountID int64, oldRole string, err error) {
	if !ValidRole(role) {
		return 0, "", fmt.Errorf("set role: invalid role %q", role)
	}
	err = s.inTx(ctx, func(q *db.Queries) error {
		row, err := q.SetAccountRole(ctx, db.SetAccountRoleParams{Role: role, Email: email})
		if err != nil {
			return fmt.Errorf("set role: %w", notFound(err))
		}
		accountID, oldRole = row.ID, row.OldRole
		audit.Action = "set_role"
		audit.TargetAccountID = row.ID
		audit.TargetName = email
		args := map[string]string{"old": row.OldRole, "new": role}
		for k, v := range audit.Args { // e.g. the operator's note
			if _, taken := args[k]; !taken {
				args[k] = v
			}
		}
		audit.Args = args
		if audit.Result == "" {
			audit.Result = ResultOK
		}
		return appendAudit(ctx, q, audit)
	})
	return accountID, oldRole, err
}

func optID(id int64) pgtype.Int8 { return pgtype.Int8{Int64: id, Valid: id != 0} }
