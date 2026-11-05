package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Map submission statuses (T4.5, migrations/00010_map_submissions.sql).
const (
	SubmissionPending  = "pending"
	SubmissionApproved = "approved"
	SubmissionRejected = "rejected"
	SubmissionPROpened = "pr_opened"
	SubmissionFailed   = "failed"
)

// AuditWeb is the audit source of website actions (the actor is an account).
const AuditWeb = "web"

// Errors of map submissions.
var (
	ErrSubmitLimit         = errors.New("store: daily map submission limit reached")
	ErrAccountTooNew       = errors.New("store: account too new to submit maps")
	ErrDuplicateSubmission = errors.New("store: the same patch is already waiting for review")
	ErrForbidden           = errors.New("store: forbidden")
	ErrNotPending          = errors.New("store: submission is not pending")
	// ErrOwnSubmission: a moderator cannot decide on their own submission.
	ErrOwnSubmission = errors.New("store: moderators cannot review their own submission")
)

// ValidSubmissionStatus reports whether s is a status of map_submissions.
func ValidSubmissionStatus(s string) bool {
	switch s {
	case SubmissionPending, SubmissionApproved, SubmissionRejected, SubmissionPROpened, SubmissionFailed:
		return true
	}
	return false
}

// MapSubmissionFile is a file a submitted patch touches.
type MapSubmissionFile struct {
	Path   string `json:"path"`
	Action string `json:"action"`
}

// MapSubmission is a row of map_submissions without the patch bytes.
type MapSubmission struct {
	ID                int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
	AccountID         int64
	AuthorCharacterID int64
	AuthorName        string
	Title             string
	Description       string
	License           string
	Status            string
	SHA256            string
	SizeBytes         int
	BaseRef           string
	Files             []MapSubmissionFile
	ReviewedAt        time.Time // zero while pending
	ReviewedBy        int64
	Reason            string
	Failure           string
	PRURL             string
	PRNumber          int
}

// NewMapSubmission is an upload that already passed the patch check (mappatch).
type NewMapSubmission struct {
	At          time.Time
	AccountID   int64
	CharacterID int64 // the character the author is credited as
	Title       string
	Description string
	License     string
	SHA256      string
	BaseRef     string
	Files       []MapSubmissionFile
	Patch       []byte
	// PerDay is how many submissions an account may make in 24 hours.
	PerDay int
	// MinAccountAge is how old the account must be.
	MinAccountAge time.Duration
}

// CreateMapSubmission stores an upload and its audit entry (action "map_submit") in one
// transaction. It fails with ErrForbidden for a disabled or banned account,
// ErrAccountTooNew, ErrSubmitLimit, ErrNotFound when the character is not the account's,
// and ErrDuplicateSubmission when the same patch of the account is still pending.
func (s *Store) CreateMapSubmission(ctx context.Context, n NewMapSubmission) (MapSubmission, error) {
	files, err := json.Marshal(n.Files)
	if err != nil {
		return MapSubmission{}, fmt.Errorf("create map submission: %w", err)
	}
	out := MapSubmission{
		CreatedAt: n.At, UpdatedAt: n.At, AccountID: n.AccountID, AuthorCharacterID: n.CharacterID,
		Title: n.Title, Description: n.Description, License: n.License, Status: SubmissionPending,
		SHA256: n.SHA256, SizeBytes: len(n.Patch), BaseRef: n.BaseRef, Files: n.Files,
	}
	err = s.inTx(ctx, func(q *db.Queries) error {
		acc, err := q.LockSubmitter(ctx, db.LockSubmitterParams{AccountID: n.AccountID, Now: ts(n.At)})
		if err != nil {
			return fmt.Errorf("submitter: %w", notFound(err))
		}
		recent, err := q.CountRecentSubmissions(ctx, db.CountRecentSubmissionsParams{
			AccountID: n.AccountID, Since: ts(n.At.Add(-24 * time.Hour)),
		})
		if err != nil {
			return fmt.Errorf("count submissions: %w", err)
		}
		if err := submitterError(acc.DisabledAt.Valid || acc.Banned,
			n.At.Sub(acc.CreatedAt.Time) < n.MinAccountAge, recent >= int64(n.PerDay)); err != nil {
			return err
		}
		out.AuthorName, err = q.CharacterOfAccount(ctx, db.CharacterOfAccountParams{ID: n.CharacterID, AccountID: n.AccountID})
		if err != nil {
			return fmt.Errorf("author character: %w", notFound(err))
		}
		out.ID, err = q.InsertMapSubmission(ctx, db.InsertMapSubmissionParams{
			Now: ts(n.At), AccountID: n.AccountID, AuthorCharacterID: n.CharacterID,
			AuthorName: out.AuthorName, Title: n.Title, Description: n.Description, License: n.License,
			Sha256: n.SHA256, SizeBytes: int32(len(n.Patch)), BaseRef: n.BaseRef, Files: files, Patch: n.Patch, //nolint:gosec // bounded by the upload limit
		})
		if uniqueViolation(err, "map_submissions_pending_sha_key") {
			return ErrDuplicateSubmission
		}
		if err != nil {
			return fmt.Errorf("insert: %w", err)
		}
		return appendAudit(ctx, q, AuditEntry{
			At: n.At, Source: AuditWeb, ActorAccountID: n.AccountID, ActorCharacterID: n.CharacterID,
			ActorName: out.AuthorName, Action: "map_submit",
			Args: map[string]string{
				"submission_id": strconv.FormatInt(out.ID, 10), "sha256": n.SHA256,
				"files": strconv.Itoa(len(n.Files)), "size": strconv.Itoa(len(n.Patch)),
			},
			Result: ResultOK,
		})
	})
	if err != nil {
		return MapSubmission{}, fmt.Errorf("create map submission: %w", err)
	}
	return out, nil
}

// CheckSubmitter is a cheap check, without locks, of what CreateMapSubmission enforces
// on the account (disabled or banned, age, daily limit), so an upload that would be
// refused is refused before its body is read. CreateMapSubmission checks again.
func (s *Store) CheckSubmitter(ctx context.Context, accountID int64, at time.Time, perDay int, minAge time.Duration) error {
	row, err := s.q.SubmitterStatus(ctx, db.SubmitterStatusParams{
		AccountID: accountID, Now: ts(at), Since: ts(at.Add(-24 * time.Hour)),
	})
	if err != nil {
		return fmt.Errorf("check submitter: %w", notFound(err))
	}
	return submitterError(row.DisabledAt.Valid || row.Banned, at.Sub(row.CreatedAt.Time) < minAge, row.Recent >= int64(perDay))
}

func submitterError(blocked, tooNew, overLimit bool) error {
	switch {
	case blocked:
		return ErrForbidden
	case tooNew:
		return ErrAccountTooNew
	case overLimit:
		return ErrSubmitLimit
	}
	return nil
}

// AccountRole returns the current role of an account (ErrNotFound if it does not exist).
func (s *Store) AccountRole(ctx context.Context, accountID int64) (string, error) {
	role, err := s.q.GetAccountRole(ctx, accountID)
	if err != nil {
		return "", fmt.Errorf("account role: %w", notFound(err))
	}
	return role, nil
}

// AccountMapSubmissions returns an account's newest n submissions.
func (s *Store) AccountMapSubmissions(ctx context.Context, accountID int64, n int) ([]MapSubmission, error) {
	rows, err := s.q.ListAccountSubmissions(ctx, db.ListAccountSubmissionsParams{AccountID: accountID, MaxRows: rowLimit(n)})
	if err != nil {
		return nil, fmt.Errorf("account map submissions: %w", err)
	}
	out := make([]MapSubmission, 0, len(rows))
	for _, r := range rows {
		m, err := submissionOf(db.GetSubmissionRow(r))
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

// MapSubmissionsByStatus returns the oldest n submissions with a status (the queue).
func (s *Store) MapSubmissionsByStatus(ctx context.Context, status string, n int) ([]MapSubmission, error) {
	rows, err := s.q.ListSubmissionsByStatus(ctx, db.ListSubmissionsByStatusParams{Status: status, MaxRows: rowLimit(n)})
	if err != nil {
		return nil, fmt.Errorf("map submissions by status: %w", err)
	}
	out := make([]MapSubmission, 0, len(rows))
	for _, r := range rows {
		m, err := submissionOf(db.GetSubmissionRow(r))
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

// MapSubmission returns one submission (ErrNotFound if there is none).
func (s *Store) MapSubmission(ctx context.Context, id int64) (MapSubmission, error) {
	r, err := s.q.GetSubmission(ctx, id)
	if err != nil {
		return MapSubmission{}, fmt.Errorf("map submission: %w", notFound(err))
	}
	return submissionOf(r)
}

// MapSubmissionPatch returns the patch bytes of a submission and its author's account.
func (s *Store) MapSubmissionPatch(ctx context.Context, id int64) (accountID int64, sha string, patch []byte, err error) {
	r, err := s.q.GetSubmissionPatch(ctx, id)
	if err != nil {
		return 0, "", nil, fmt.Errorf("map submission patch: %w", notFound(err))
	}
	return r.AccountID, r.Sha256, r.Patch, nil
}

// ReviewRequest is a moderator's decision on a pending submission.
type ReviewRequest struct {
	At             time.Time
	ID             int64
	ActorAccountID int64
	Approve        bool
	// Reason is required to reject; optional (a note) to approve.
	Reason string
}

// ReviewMapSubmission approves or rejects a pending submission and audits it
// ("map_approve" / "map_reject") in one transaction. The actor's role is read in the same
// transaction: ErrForbidden below gm, ErrOwnSubmission for the author's own submission.
// ErrNotFound, or ErrNotPending once decided.
func (s *Store) ReviewMapSubmission(ctx context.Context, r ReviewRequest) (MapSubmission, error) {
	status, action := SubmissionRejected, "map_reject"
	if r.Approve {
		status, action = SubmissionApproved, "map_approve"
	}
	err := s.inTx(ctx, func(q *db.Queries) error {
		role, err := q.GetAccountRole(ctx, r.ActorAccountID)
		if err != nil {
			return fmt.Errorf("actor role: %w", notFound(err))
		}
		if RoleRank(role) < RoleRank(RoleGM) {
			return ErrForbidden
		}
		author, err := q.SubmissionAuthor(ctx, r.ID)
		if err != nil {
			return fmt.Errorf("submission: %w", notFound(err))
		}
		if author == r.ActorAccountID {
			return ErrOwnSubmission
		}
		row, err := q.ReviewSubmission(ctx, db.ReviewSubmissionParams{
			Status: status, Now: ts(r.At), ReviewedBy: optID(r.ActorAccountID),
			Reason: pgtype.Text{String: r.Reason, Valid: r.Reason != ""}, ID: r.ID,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotPending
		}
		if err != nil {
			return fmt.Errorf("review: %w", err)
		}
		args := map[string]string{"submission_id": strconv.FormatInt(row.ID, 10), "sha256": row.Sha256}
		if r.Reason != "" {
			args["reason"] = r.Reason
		}
		return appendAudit(ctx, q, AuditEntry{
			At: r.At, Source: AuditWeb, ActorAccountID: r.ActorAccountID,
			ActorName: StaffName(r.ActorAccountID), Action: action,
			TargetAccountID: row.AccountID, TargetName: row.AuthorName, Args: args, Result: ResultOK,
		})
	})
	if err != nil {
		return MapSubmission{}, fmt.Errorf("review map submission: %w", err)
	}
	return s.MapSubmission(ctx, r.ID)
}

// StaffName is the audit actor name of a staff account acting on the website, where it
// has no character: "account <id>" (never the email).
func StaffName(accountID int64) string { return "account " + strconv.FormatInt(accountID, 10) }

func rowLimit(n int) int32 { return int32(min(max(n, 1), 1000)) } //nolint:gosec // clamped

func submissionOf(r db.GetSubmissionRow) (MapSubmission, error) {
	m := MapSubmission{
		ID: r.ID, CreatedAt: r.CreatedAt.Time, UpdatedAt: r.UpdatedAt.Time, AccountID: r.AccountID,
		AuthorCharacterID: r.AuthorCharacterID, AuthorName: r.AuthorName, Title: r.Title,
		Description: r.Description, License: r.License, Status: r.Status, SHA256: r.Sha256,
		SizeBytes: int(r.SizeBytes), BaseRef: r.BaseRef, ReviewedAt: r.ReviewedAt.Time,
		ReviewedBy: r.ReviewedBy.Int64, Reason: r.Reason.String, Failure: r.Failure.String,
		PRURL: r.PrUrl.String, PRNumber: int(r.PrNumber.Int32),
	}
	if err := json.Unmarshal(r.Files, &m.Files); err != nil {
		return MapSubmission{}, fmt.Errorf("map submission %d files: %w", r.ID, err)
	}
	return m, nil
}
