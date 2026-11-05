package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// AdminStore is the persistence of staff commands (T2.6). *store.Store implements it.
type AdminStore interface {
	AppendAudit(ctx context.Context, e store.AuditEntry) error
	Ban(ctx context.Context, r store.BanRequest) (store.BanResult, error)
	Unban(ctx context.Context, r store.BanRequest) (store.BanResult, error)
	AccountRoles(ctx context.Context, ids []int64) (map[int64]string, error)
	// Player reports (T4.1).
	CreateReport(ctx context.Context, r store.Report, audit store.AuditEntry) (int64, error)
	ListReportsAudited(ctx context.Context, n int, audit store.AuditEntry) ([]store.Report, error)
	CloseReport(ctx context.Context, id int64, resolution string, audit store.AuditEntry) (string, error)
}

// adminWorker is the goroutine that writes the audit log and runs bans for the game
// loop, like session.Saver does for snapshots: the loop submits jobs without blocking,
// the worker writes them in order and retries a failed write with backoff, so a
// database outage delays audit entries instead of losing them. Ban and unban results go
// back to the loop through done.
type adminWorker struct {
	store AdminStore
	clock clock.Clock
	log   *slog.Logger
	done  func(session.AdminResult)
	// roles receives the current roles of accounts (World.RolesChanged).
	roles func(map[int64]session.Role)

	mu       sync.Mutex
	ch       chan session.AdminJob
	shut     bool
	finished chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
}

const (
	adminQueue        = 1024
	adminWriteTimeout = 10 * time.Second
)

func newAdminWorker(st AdminStore, clk clock.Clock, log *slog.Logger, done func(session.AdminResult),
	roles func(map[int64]session.Role)) *adminWorker {
	return &adminWorker{store: st, clock: clk, log: log, done: done, roles: roles,
		ch: make(chan session.AdminJob, adminQueue), finished: make(chan struct{}), stop: make(chan struct{})}
}

// Submit queues job without blocking (session.Config.Admin).
func (a *adminWorker) Submit(job session.AdminJob) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.shut {
		return false
	}
	select {
	case a.ch <- job:
		return true
	default:
		return false
	}
}

func (a *adminWorker) Start() {
	go func() {
		defer close(a.finished)
		for job := range a.ch {
			select {
			case <-a.stop: // Stop gave up: no more attempts, keep the job in the log
				a.abandon(job)
			default:
				a.run(job)
			}
		}
	}()
}

// Stop stops accepting jobs and waits for the queued ones until ctx is done; then the
// pending retries are abandoned (and logged).
func (a *adminWorker) Stop(ctx context.Context) error {
	a.mu.Lock()
	if !a.shut {
		a.shut = true
		close(a.ch)
	}
	a.mu.Unlock()
	select {
	case <-a.finished:
		return nil
	case <-ctx.Done():
		a.stopOnce.Do(func() { close(a.stop) })
		<-a.finished
		return ctx.Err()
	}
}

// run writes one job, retrying transient errors until it succeeds or Stop gives up.
func (a *adminWorker) run(job session.AdminJob) {
	if job.Kind == session.AdminCheckRoles {
		a.checkRoles(job.Accounts) // one try: the loop asks again every few seconds
		return
	}
	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), adminWriteTimeout)
		res, err := a.write(ctx, job)
		cancel()
		if err == nil {
			a.report(job, res)
			if id := job.Audit.ActorAccountID; id != 0 {
				a.checkRoles([]int64{id}) // a demoted actor loses the role after one command
			}
			return
		}
		if store.Permanent(err) {
			a.log.Error("admin: job rejected by the database", "kind", job.Kind, "action", job.Audit.Action, "err", err)
			a.fail(job)
			return
		}
		a.log.Error("admin: job failed, retrying", "kind", job.Kind, "action", job.Audit.Action,
			"attempt", attempt, "retry_in", backoff.String(), "err", err)
		select {
		case <-a.stop:
			a.abandon(job)
			return
		case <-a.clock.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (a *adminWorker) write(ctx context.Context, job session.AdminJob) (session.AdminResult, error) {
	res := session.AdminResult{ID: job.ID, Result: session.AdminOK, ReportID: job.ReportID}
	var err error
	switch job.Kind {
	case session.AdminBan, session.AdminUnban:
		var b store.BanResult
		if job.Kind == session.AdminBan {
			b, err = a.store.Ban(ctx, banRequest(job))
		} else {
			b, err = a.store.Unban(ctx, banRequest(job))
		}
		res.Result, res.AccountID, res.Name = b.Result, b.AccountID, b.Name
	case session.AdminReport:
		_, err = a.store.CreateReport(ctx, storeReport(job), auditEntry(job.Audit))
	case session.AdminListReports:
		var rs []store.Report
		rs, err = a.store.ListReportsAudited(ctx, reportsListed, withResult(auditEntry(job.Audit), store.ResultOK))
		for _, r := range rs {
			res.Reports = append(res.Reports, session.ReportSummary{ID: r.ID, At: r.At, Reporter: r.ReporterName,
				Target: r.TargetName, Reason: r.Reason})
		}
	case session.AdminCloseReport:
		res.Result, err = a.store.CloseReport(ctx, job.ReportID, job.Reason, auditEntry(job.Audit))
	default:
		err = a.store.AppendAudit(ctx, auditEntry(job.Audit))
	}
	return res, err
}

// reportsListed is how many open reports a GM's /reports shows.
const reportsListed = 10

func withResult(e store.AuditEntry, r string) store.AuditEntry {
	e.Result = r
	return e
}

// storeReport is the report row of an AdminReport job; its context goes as JSON.
func storeReport(job session.AdminJob) store.Report {
	e, r := job.Audit, job.Report
	var ctxJSON json.RawMessage
	if r == nil {
		r = &session.ReportJob{}
	} else if raw, err := json.Marshal(r.Context); err == nil {
		ctxJSON = raw
	} else {
		slog.Error("admin: report context not encodable, stored without it", "target", e.TargetName, "err", err)
	}
	return store.Report{At: e.At, ReporterAccountID: e.ActorAccountID, ReporterCharacterID: e.ActorCharacterID,
		ReporterName: e.ActorName, TargetAccountID: e.TargetAccountID, TargetCharacterID: e.TargetCharacterID,
		TargetName: e.TargetName, Reason: r.Reason, Context: ctxJSON}
}

func (a *adminWorker) report(job session.AdminJob, res session.AdminResult) {
	if job.Kind == session.AdminAudit || job.Kind == session.AdminReport {
		return
	}
	a.done(res)
}

// abandon logs a job that will not reach the database (shutdown with the database
// down), with everything the audit entry would have had: the log is the last copy.
func (a *adminWorker) abandon(job session.AdminJob) {
	if job.Kind == session.AdminCheckRoles {
		return
	}
	e := job.Audit
	a.log.Error("admin: job abandoned at shutdown", "kind", job.Kind, "at", e.At, "action", e.Action,
		"actor_account", e.ActorAccountID, "actor", e.ActorName, "target", job.TargetName+e.TargetName,
		"args", e.Args, "result", e.Result, "reason", job.Reason, "until", job.Until)
}

// fail handles a job the database rejected (invalid values): a ban or unban is answered
// as failed, and the attempt is still recorded with a reduced entry (no free-form
// arguments) that cannot break the table's constraints.
func (a *adminWorker) fail(job session.AdminJob) {
	if job.Kind != session.AdminAudit && job.Kind != session.AdminReport {
		a.done(session.AdminResult{ID: job.ID, Result: session.AdminFailed, Name: job.TargetName, ReportID: job.ReportID})
	}
	if job.Kind == session.AdminReport && job.Report != nil {
		// The report itself is not stored: keep all of it in the structured log.
		raw, _ := json.Marshal(job.Report.Context)
		a.log.Error("admin: report rejected by the database", "reporter", job.Audit.ActorName,
			"target", job.TargetName, "reason", job.Report.Reason, "context", string(raw))
	}
	e := auditEntry(job.Audit)
	e.Args, e.Result = nil, session.AdminFailed
	if e.TargetName == "" && len(job.TargetName) <= 64 {
		e.TargetName = job.TargetName
	}
	ctx, cancel := context.WithTimeout(context.Background(), adminWriteTimeout)
	defer cancel()
	if err := a.store.AppendAudit(ctx, e); err != nil {
		a.abandon(job)
	}
}

// checkRoles reads the current roles of accounts and hands them to the loop. An account
// that no longer exists is a player.
func (a *adminWorker) checkRoles(accounts []int64) {
	ctx, cancel := context.WithTimeout(context.Background(), adminWriteTimeout)
	defer cancel()
	m, err := a.store.AccountRoles(ctx, accounts)
	if err != nil {
		a.log.Warn("admin: role check failed", "accounts", len(accounts), "err", err)
		return
	}
	out := make(map[int64]session.Role, len(accounts))
	for _, id := range accounts {
		out[id] = session.RoleFromString(m[id])
	}
	a.roles(out)
}

func banRequest(job session.AdminJob) store.BanRequest {
	return store.BanRequest{
		Audit:      auditEntry(job.Audit),
		TargetName: job.TargetName,
		ActorRank:  store.RoleRank(job.ActorRole.String()),
		Reason:     job.Reason,
		ExpiresAt:  job.Until,
	}
}

func auditEntry(e session.AuditEntry) store.AuditEntry {
	return store.AuditEntry{
		At:                e.At,
		Source:            store.AuditGame,
		ActorAccountID:    e.ActorAccountID,
		ActorCharacterID:  e.ActorCharacterID,
		ActorName:         e.ActorName,
		Action:            e.Action,
		TargetAccountID:   e.TargetAccountID,
		TargetCharacterID: e.TargetCharacterID,
		TargetName:        e.TargetName,
		Args:              e.Args,
		Result:            e.Result,
	}
}

// writePending writes, at shutdown, the jobs the loop could not queue. A job that
// cannot be written is kept in the structured log, like on the channel's path: the
// log is the last copy of what the staff did.
func (a *adminWorker) writePending(ctx context.Context, jobs []session.AdminJob) error {
	var errs []error
	for _, job := range jobs {
		if job.Kind == session.AdminCheckRoles {
			continue
		}
		if ctx.Err() != nil {
			a.abandon(job)
			errs = append(errs, ctx.Err())
			continue
		}
		if _, err := a.write(ctx, job); err != nil {
			if store.Permanent(err) {
				a.fail(job)
			} else {
				a.abandon(job)
			}
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
