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

func newAdminWorker(st AdminStore, clk clock.Clock, log *slog.Logger, done func(session.AdminResult)) *adminWorker {
	return &adminWorker{store: st, clock: clk, log: log, done: done,
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
			a.run(job)
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
	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), adminWriteTimeout)
		res, err := a.write(ctx, job)
		cancel()
		if err == nil {
			a.report(job, res)
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
			a.log.Error("admin: job abandoned at shutdown", "kind", job.Kind, "action", job.Audit.Action,
				"actor", job.Audit.ActorName, "target", job.TargetName)
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

// fail answers a ban or unban the database rejected and still records the attempt.
func (a *adminWorker) fail(job session.AdminJob) {
	if job.Kind == session.AdminAudit {
		return
	}
	a.done(session.AdminResult{ID: job.ID, Result: session.AdminFailed, Name: job.TargetName})
	e := auditEntry(job.Audit)
	e.TargetName, e.Result = job.TargetName, session.AdminFailed
	ctx, cancel := context.WithTimeout(context.Background(), adminWriteTimeout)
	defer cancel()
	if err := a.store.AppendAudit(ctx, e); err != nil {
		a.log.Error("admin: audit of a failed job lost", "action", e.Action, "actor", e.ActorName, "err", err)
	}
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

// writePending writes, at shutdown, the jobs the loop could not queue.
func (a *adminWorker) writePending(ctx context.Context, jobs []session.AdminJob) error {
	var errs []error
	for _, job := range jobs {
		if _, err := a.write(ctx, job); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
