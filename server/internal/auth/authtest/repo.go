// Package authtest provides an in-memory auth.Repo for tests that must run without
// PostgreSQL. It mirrors the constraints of the real schema that the service relies on.
package authtest

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Repo is an in-memory implementation of auth.Repo.
type Repo struct {
	mu         sync.Mutex
	nextID     int64
	accounts   map[int64]*store.Account
	byEmail    map[string]int64
	sessions   map[string]store.Session
	characters map[int64][]store.Character
	names      map[string]bool
	bans       map[int64]store.Ban
	verified   map[int64]bool
	locales    map[int64]string
	tokens     map[string]store.AccountToken
	identities map[string]identityRow
	states     map[string]store.OAuthState
	pendings   map[string]pendingRow
	// Audit holds the audit entries the store would have written (VerifyEmail,
	// ResetPassword).
	Audit []store.AuditEntry
}

// NewRepo returns an empty Repo.
func NewRepo() *Repo {
	return &Repo{
		accounts:   map[int64]*store.Account{},
		byEmail:    map[string]int64{},
		sessions:   map[string]store.Session{},
		characters: map[int64][]store.Character{},
		names:      map[string]bool{},
		bans:       map[int64]store.Ban{},
		verified:   map[int64]bool{},
		locales:    map[int64]string{},
		tokens:     map[string]store.AccountToken{},
	}
}

func (r *Repo) id() int64 { r.nextID++; return r.nextID }

// CreateAccount implements auth.Repo.
func (r *Repo) CreateAccount(_ context.Context, email, hash string) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byEmail[email]; ok {
		return 0, store.ErrEmailTaken
	}
	id := r.id()
	r.accounts[id] = &store.Account{ID: id, Email: email, PasswordHash: hash}
	r.byEmail[email] = id
	return id, nil
}

// AccountByEmail implements auth.Repo.
func (r *Repo) AccountByEmail(_ context.Context, email string) (store.Account, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := r.byEmail[email]
	if !ok {
		return store.Account{}, store.ErrNotFound
	}
	return *r.accounts[id], nil
}

// Disable marks an account as disabled (test helper).
func (r *Repo) Disable(accountID int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.accounts[accountID].Disabled = true
}

// SetBan gives an account an active ban (test helper). A zero ExpiresAt is permanent.
func (r *Repo) SetBan(accountID int64, b store.Ban) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bans[accountID] = b
}

// ActiveBan implements auth.Repo.
func (r *Repo) ActiveBan(_ context.Context, accountID int64, now time.Time) (store.Ban, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if b, ok := r.bans[accountID]; ok && (b.Permanent() || b.ExpiresAt.After(now)) {
		return b, nil
	}
	return store.Ban{}, store.ErrNotFound
}

// TouchLogin implements auth.Repo.
func (r *Repo) TouchLogin(context.Context, int64, time.Time) error { return nil }

// CreateSession implements auth.Repo.
func (r *Repo) CreateSession(_ context.Context, s store.Session) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[string(s.TokenHash)] = s
	return nil
}

// ActiveSession implements auth.Repo.
func (r *Repo) ActiveSession(_ context.Context, hash []byte, kind store.SessionKind, now time.Time) (store.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[string(hash)]
	if !ok || s.Kind != kind || !s.ExpiresAt.After(now) || r.accounts[s.AccountID].Disabled {
		return store.Session{}, store.ErrNotFound
	}
	return s, nil
}

// DeleteSession implements auth.Repo.
func (r *Repo) DeleteSession(_ context.Context, hash []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, string(hash))
	return nil
}

// DeleteExpiredSessions implements auth.Repo.
func (r *Repo) DeleteExpiredSessions(_ context.Context, now time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	for k, s := range r.sessions {
		if !s.ExpiresAt.After(now) {
			delete(r.sessions, k)
			n++
		}
	}
	return n, nil
}

// SessionCount returns how many sessions are stored (test helper).
func (r *Repo) SessionCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions)
}

// ListCharacters implements auth.Repo.
func (r *Repo) ListCharacters(_ context.Context, accountID int64) ([]store.Character, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]store.Character{}, r.characters[accountID]...), nil
}

// CreateCharacter implements auth.Repo.
func (r *Repo) CreateCharacter(_ context.Context, c store.NewCharacter, maxPerAccount int) (store.Character, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.accounts[c.AccountID]; !ok {
		return store.Character{}, store.ErrNotFound
	}
	if len(r.characters[c.AccountID]) >= maxPerAccount {
		return store.Character{}, store.ErrCharacterLimit
	}
	key := strings.ToLower(c.Name)
	if r.names[key] {
		return store.Character{}, store.ErrNameTaken
	}
	r.names[key] = true
	ch := store.Character{ID: r.id(), Name: c.Name, Vocation: c.Vocation, Level: 1}
	r.characters[c.AccountID] = append(r.characters[c.AccountID], ch)
	return ch, nil
}

// CharacterBelongsTo implements auth.Repo.
func (r *Repo) CharacterBelongsTo(_ context.Context, accountID, characterID int64) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.characters[accountID] {
		if c.ID == characterID {
			return true, nil
		}
	}
	return false, nil
}

// ConsumeSession implements auth.Repo.
func (r *Repo) ConsumeSession(_ context.Context, hash []byte, kind store.SessionKind, now time.Time) (store.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.sessions[string(hash)]
	if !ok || s.Kind != kind || !s.ExpiresAt.After(now) || r.accounts[s.AccountID].Disabled {
		return store.Session{}, store.ErrNotFound
	}
	delete(r.sessions, string(hash))
	return s, nil
}

// AccountProfile implements auth.Repo.
func (r *Repo) AccountProfile(_ context.Context, accountID int64) (store.Profile, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.profile(accountID)
}

func (r *Repo) profile(id int64) (store.Profile, error) {
	a, ok := r.accounts[id]
	if !ok {
		return store.Profile{}, store.ErrNotFound
	}
	return store.Profile{
		ID: a.ID, Email: a.Email, HasPassword: a.PasswordHash != "", EmailVerified: r.verified[id],
		Locale: r.locales[id], Disabled: a.Disabled,
	}, nil
}

// AccountProfileByEmail implements auth.ResetLinkRepo.
func (r *Repo) AccountProfileByEmail(_ context.Context, email string) (store.Profile, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := r.byEmail[email]
	if !ok {
		return store.Profile{}, store.ErrNotFound
	}
	return r.profile(id)
}

// SetVerified marks an account's email as verified (test helper).
func (r *Repo) SetVerified(accountID int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.verified[accountID] = true
}

// PasswordHash returns the stored password hash (test helper).
func (r *Repo) PasswordHash(accountID int64) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.accounts[accountID].PasswordHash
}

// TokenCount returns how many emailed tokens are stored (test helper).
func (r *Repo) TokenCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.tokens)
}

// SetAccountLocale implements auth.Repo.
func (r *Repo) SetAccountLocale(_ context.Context, accountID int64, locale string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.locales[accountID] = locale
	return nil
}

// ReplaceAccountToken implements auth.Repo.
func (r *Repo) ReplaceAccountToken(_ context.Context, t store.AccountToken) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for k, old := range r.tokens {
		if old.AccountID == t.AccountID && old.Purpose == t.Purpose {
			delete(r.tokens, k)
		}
	}
	r.tokens[string(t.TokenHash)] = t
	return nil
}

// consume deletes and returns a valid token. Caller holds mu.
func (r *Repo) consume(hash []byte, purpose store.TokenPurpose, now time.Time) (store.AccountToken, bool) {
	t, ok := r.tokens[string(hash)]
	if !ok || t.Purpose != purpose || !t.ExpiresAt.After(now) {
		return store.AccountToken{}, false
	}
	delete(r.tokens, string(hash))
	return t, true
}

// VerifyEmail implements auth.Repo.
func (r *Repo) VerifyEmail(_ context.Context, hash []byte, now time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.consume(hash, store.TokenVerifyEmail, now)
	if !ok {
		return 0, store.ErrNotFound
	}
	if a := r.accounts[t.AccountID]; a.Email == t.Email && !r.verified[a.ID] {
		r.verified[a.ID] = true
		r.Audit = append(r.Audit, store.AuditEntry{At: now, Source: store.AuditWeb, ActorAccountID: a.ID,
			Action: store.AuditEmailVerified, TargetAccountID: a.ID, Result: store.ResultOK})
	}
	return t.AccountID, nil
}

// ResetPassword implements auth.Repo.
func (r *Repo) ResetPassword(_ context.Context, hash []byte, passwordHash string, now time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.consume(hash, store.TokenResetPassword, now)
	if !ok {
		return 0, store.ErrNotFound
	}
	if a := r.accounts[t.AccountID]; a.Disabled || a.Email != t.Email {
		return 0, store.ErrNotFound
	}
	r.accounts[t.AccountID].PasswordHash = passwordHash
	for k, old := range r.tokens {
		if old.AccountID == t.AccountID && old.Purpose == store.TokenResetPassword {
			delete(r.tokens, k)
		}
	}
	for k, s := range r.sessions {
		if s.AccountID == t.AccountID {
			delete(r.sessions, k)
		}
	}
	for k, row := range r.identities {
		if row.accountID == t.AccountID && (!row.EmailVerified || row.Email != t.Email) {
			delete(r.identities, k)
		}
	}
	for k, st := range r.states {
		if st.AccountID == t.AccountID {
			delete(r.states, k)
		}
	}
	r.Audit = append(r.Audit, store.AuditEntry{At: now, Source: store.AuditWeb, ActorAccountID: t.AccountID,
		Action: store.AuditPasswordReset, TargetAccountID: t.AccountID, Result: store.ResultOK})
	return t.AccountID, nil
}

// DeleteExpiredAccountTokens implements auth.Repo.
func (r *Repo) DeleteExpiredAccountTokens(_ context.Context, now time.Time) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	for k, t := range r.tokens {
		if !t.ExpiresAt.After(now) {
			delete(r.tokens, k)
			n++
		}
	}
	return n, nil
}
