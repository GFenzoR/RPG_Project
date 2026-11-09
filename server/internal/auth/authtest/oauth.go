package authtest

import (
	"context"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// OAuth half of the in-memory repository (auth.OAuthRepo, T2.1 2/2). Mirrors the
// constraints of migration 00012: (provider, subject) and (account, provider) unique.

type identityRow struct {
	store.ExternalIdentity
	accountID int64
	at        time.Time
}

func (r *Repo) oauthInit() {
	if r.identities == nil {
		r.identities = map[string]identityRow{}
		r.states = map[string]store.OAuthState{}
		r.pendings = map[string]pendingRow{}
	}
}

type pendingRow struct {
	store.OAuthPending
	expires time.Time
}

func identityKey(provider, subject string) string { return provider + "\x00" + subject }

// CreateOAuthState implements auth.OAuthRepo.
func (r *Repo) CreateOAuthState(_ context.Context, st store.OAuthState) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	r.states[string(st.StateHash)] = st
	return nil
}

// ConsumeOAuthState implements auth.OAuthRepo.
func (r *Repo) ConsumeOAuthState(_ context.Context, hash []byte, now time.Time) (store.OAuthState, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	st, ok := r.states[string(hash)]
	delete(r.states, string(hash))
	if !ok || !st.ExpiresAt.After(now) {
		return store.OAuthState{}, store.ErrNotFound
	}
	return st, nil
}

// StateCount returns how many OAuth states are stored (test helper).
func (r *Repo) StateCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.states)
}

// IdentityAccount implements auth.OAuthRepo.
func (r *Repo) IdentityAccount(_ context.Context, provider, subject string) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	row, ok := r.identities[identityKey(provider, subject)]
	if !ok {
		return 0, store.ErrNotFound
	}
	return row.accountID, nil
}

func (r *Repo) insertIdentity(accountID int64, id store.ExternalIdentity, at time.Time, action string) error {
	if _, ok := r.identities[identityKey(id.Provider, id.Subject)]; ok {
		return store.ErrIdentityTaken
	}
	for _, row := range r.identities {
		if row.accountID == accountID && row.Provider == id.Provider {
			return store.ErrProviderLinked
		}
	}
	r.identities[identityKey(id.Provider, id.Subject)] = identityRow{ExternalIdentity: id, accountID: accountID, at: at}
	r.Audit = append(r.Audit, store.AuditEntry{At: at, Source: store.AuditWeb, ActorAccountID: accountID, Action: action,
		TargetAccountID: accountID, Args: map[string]string{"provider": id.Provider}, Result: store.ResultOK})
	return nil
}

// LinkIdentity implements auth.OAuthRepo.
func (r *Repo) LinkIdentity(_ context.Context, accountID int64, id store.ExternalIdentity, at time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	return r.insertIdentity(accountID, id, at, store.AuditIdentityLinked)
}

// CreateOAuthAccount implements auth.OAuthRepo.
func (r *Repo) CreateOAuthAccount(_ context.Context, email string, verified bool, id store.ExternalIdentity, at time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	if _, ok := r.byEmail[email]; ok {
		return 0, store.ErrEmailTaken
	}
	if _, ok := r.identities[identityKey(id.Provider, id.Subject)]; ok {
		return 0, store.ErrIdentityTaken
	}
	accountID := r.id()
	r.accounts[accountID] = &store.Account{ID: accountID, Email: email}
	r.byEmail[email] = accountID
	r.verified[accountID] = verified
	return accountID, r.insertIdentity(accountID, id, at, store.AuditOAuthAccount)
}

// Identities implements auth.OAuthRepo.
func (r *Repo) Identities(_ context.Context, accountID int64) ([]store.Identity, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	var out []store.Identity
	for _, row := range r.identities {
		if row.accountID == accountID {
			out = append(out, store.Identity{Provider: row.Provider, Email: row.Email, CreatedAt: row.at})
		}
	}
	return out, nil
}

// UnlinkIdentity implements auth.OAuthRepo.
func (r *Repo) UnlinkIdentity(_ context.Context, accountID int64, provider string, at time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	n, key := 0, ""
	for k, row := range r.identities {
		if row.accountID == accountID {
			n++
			if row.Provider == provider {
				key = k
			}
		}
	}
	if r.accounts[accountID].PasswordHash == "" && n <= 1 {
		return store.ErrLastLoginMethod
	}
	if key == "" {
		return store.ErrNotFound
	}
	delete(r.identities, key)
	r.Audit = append(r.Audit, store.AuditEntry{At: at, Source: store.AuditWeb, ActorAccountID: accountID,
		Action: store.AuditIdentityUnlinked, TargetAccountID: accountID, Args: map[string]string{"provider": provider}, Result: store.ResultOK})
	return nil
}

// CreateOAuthPending implements auth.OAuthRepo.
func (r *Repo) CreateOAuthPending(_ context.Context, hash []byte, p store.OAuthPending, expires time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	r.pendings[string(hash)] = pendingRow{OAuthPending: p, expires: expires}
	return nil
}

// OAuthPendingByToken implements auth.OAuthRepo.
func (r *Repo) OAuthPendingByToken(_ context.Context, hash []byte, now time.Time) (store.OAuthPending, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	p, ok := r.pendings[string(hash)]
	if !ok || !p.expires.After(now) {
		return store.OAuthPending{}, store.ErrNotFound
	}
	return p.OAuthPending, nil
}

// DeleteOAuthPending implements auth.OAuthRepo.
func (r *Repo) DeleteOAuthPending(_ context.Context, hash []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	delete(r.pendings, string(hash))
	return nil
}

// DeleteExpiredOAuth implements auth.OAuthRepo.
func (r *Repo) DeleteExpiredOAuth(_ context.Context, now time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.oauthInit()
	var n int64
	for k, st := range r.states {
		if !st.ExpiresAt.After(now) {
			delete(r.states, k)
			n++
		}
	}
	for k, p := range r.pendings {
		if !p.expires.After(now) {
			delete(r.pendings, k)
			n++
		}
	}
	return n, nil
}
