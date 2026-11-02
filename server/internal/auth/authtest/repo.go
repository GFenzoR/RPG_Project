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
}

// NewRepo returns an empty Repo.
func NewRepo() *Repo {
	return &Repo{
		accounts:   map[int64]*store.Account{},
		byEmail:    map[string]int64{},
		sessions:   map[string]store.Session{},
		characters: map[int64][]store.Character{},
		names:      map[string]bool{},
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
