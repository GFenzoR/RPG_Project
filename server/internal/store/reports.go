package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Report statuses and the result of closing one that is not open.
const (
	ResultNotOpen = "not_open"
)

// Report is a row of player_reports (T4.1). Context is the JSON the server attached.
type Report struct {
	ID                  int64
	At                  time.Time
	ReporterAccountID   int64
	ReporterCharacterID int64
	ReporterName        string
	TargetAccountID     int64
	TargetCharacterID   int64
	TargetName          string
	Reason              string
	Context             json.RawMessage
}

// CreateReport stores a report and its audit entry in one transaction and returns the
// report id. The audit entry gets report_id among its arguments.
func (s *Store) CreateReport(ctx context.Context, r Report, audit AuditEntry) (int64, error) {
	var id int64
	ctxJSON := r.Context
	if len(ctxJSON) == 0 {
		ctxJSON = json.RawMessage("{}")
	}
	err := s.inTx(ctx, func(q *db.Queries) error {
		var err error
		id, err = q.InsertReport(ctx, db.InsertReportParams{
			CreatedAt:           ts(r.At),
			ReporterAccountID:   r.ReporterAccountID,
			ReporterCharacterID: r.ReporterCharacterID,
			ReporterName:        r.ReporterName,
			TargetAccountID:     r.TargetAccountID,
			TargetCharacterID:   r.TargetCharacterID,
			TargetName:          r.TargetName,
			Reason:              r.Reason,
			Context:             ctxJSON,
		})
		if err != nil {
			return fmt.Errorf("insert report: %w", err)
		}
		audit.Args = withArg(audit.Args, "report_id", fmt.Sprint(id))
		return appendAudit(ctx, q, audit)
	})
	if err != nil {
		return 0, fmt.Errorf("create report: %w", err)
	}
	return id, nil
}

// OpenReports returns the n oldest open reports (the queue order), with their context.
func (s *Store) OpenReports(ctx context.Context, n int) ([]Report, error) {
	rows, err := s.q.ListOpenReports(ctx, int32(min(max(n, 1), 1000)))
	if err != nil {
		return nil, fmt.Errorf("open reports: %w", err)
	}
	out := make([]Report, len(rows))
	for i, r := range rows {
		out[i] = Report{ID: r.ID, At: r.CreatedAt.Time, ReporterName: r.ReporterName, TargetName: r.TargetName,
			TargetCharacterID: r.TargetCharacterID, Reason: r.Reason, Context: json.RawMessage(r.Context)}
	}
	return out, nil
}

// ListReportsAudited is OpenReports plus the audit entry of who looked, in one
// transaction (a GM's /reports).
func (s *Store) ListReportsAudited(ctx context.Context, n int, audit AuditEntry) ([]Report, error) {
	var out []Report
	err := s.inTx(ctx, func(q *db.Queries) error {
		rows, err := q.ListOpenReports(ctx, int32(min(max(n, 1), 1000)))
		if err != nil {
			return fmt.Errorf("open reports: %w", err)
		}
		for _, r := range rows {
			out = append(out, Report{ID: r.ID, At: r.CreatedAt.Time, ReporterName: r.ReporterName, TargetName: r.TargetName,
				TargetCharacterID: r.TargetCharacterID, Reason: r.Reason, Context: json.RawMessage(r.Context)})
		}
		audit.Args = withArg(audit.Args, "listed", fmt.Sprint(len(rows)))
		return appendAudit(ctx, q, audit)
	})
	if err != nil {
		return nil, fmt.Errorf("list reports: %w", err)
	}
	return out, nil
}

// CloseReport closes open report id with resolution by the audit's actor and records
// the audit entry with the result (ResultOK, ResultNotFound or ResultNotOpen) in one
// transaction.
func (s *Store) CloseReport(ctx context.Context, id int64, resolution string, audit AuditEntry) (string, error) {
	result := ResultOK
	err := s.inTx(ctx, func(q *db.Queries) error {
		n, err := q.CloseReport(ctx, db.CloseReportParams{
			Now:          ts(audit.At),
			ClosedBy:     optID(audit.ActorAccountID),
			ClosedByName: pgtype.Text{String: audit.ActorName, Valid: true},
			Resolution:   pgtype.Text{String: resolution, Valid: true},
			ID:           id,
		})
		if err != nil {
			return fmt.Errorf("close report: %w", err)
		}
		if n == 0 {
			exists, err := q.ReportExists(ctx, id)
			if err != nil {
				return fmt.Errorf("report exists: %w", err)
			}
			result = ResultNotFound
			if exists {
				result = ResultNotOpen
			}
		}
		audit.Result = result
		return appendAudit(ctx, q, audit)
	})
	if err != nil {
		return "", fmt.Errorf("close report: %w", err)
	}
	return result, nil
}

func withArg(args map[string]string, k, v string) map[string]string {
	out := make(map[string]string, len(args)+1)
	for a, b := range args {
		out[a] = b
	}
	out[k] = v
	return out
}
