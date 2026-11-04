package app

import (
	"context"
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

func (a *adminWorker) write(ctx context.Context, job session.AdminJob) (store.BanResult, error) {
	switch job.Kind {
	case session.AdminBan:
		return a.store.Ban(ctx, banRequest(job))
	case session.AdminUnban:
		return a.store.Unban(ctx, banRequest(job))
	default:
		return store.BanResult{}, a.store.AppendAudit(ctx, auditEntry(job.Audit))
	}
}

func (a *adminWorker) report(job session.AdminJob, res store.BanResult) {
	if job.Kind == session.AdminAudit {
		return
	}
	a.done(session.AdminResult{ID: job.ID, Result: res.Result, AccountID: res.AccountID, Name: res.Name})
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
	if job.Kind != session.AdminAudit {
		a.done(session.AdminResult{ID: job.ID, Result: session.AdminFailed, Name: job.TargetName})
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
