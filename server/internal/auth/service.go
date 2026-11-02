// Package auth implements accounts, passwords (argon2id), session tokens and the
// account's characters. It is used by the HTTP API, never by the game loop.
//
// OAuth (Google, Discord), email verification and password reset arrive in T2.1.
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Errors returned by Service. Each maps to a stable API error code in httpapi.
var (
	ErrInvalidEmail       = errors.New("auth: invalid email")
	ErrInvalidPassword    = errors.New("auth: invalid password")
	ErrEmailTaken         = errors.New("auth: email already registered")
	ErrInvalidCredentials = errors.New("auth: invalid email or password")
	ErrAccountDisabled    = errors.New("auth: account disabled")
	ErrUnauthorized       = errors.New("auth: missing, expired or revoked token")
	ErrInvalidName        = errors.New("auth: invalid character name")
	ErrNameTaken          = errors.New("auth: character name taken")
	ErrInvalidVocation    = errors.New("auth: invalid vocation")
	ErrCharacterLimit     = errors.New("auth: character limit reached")
)

// Repo is the persistence the service needs. *store.Store implements it; unit tests use
// an in-memory fake.
type Repo interface {
	CreateAccount(ctx context.Context, email, passwordHash string) (int64, error)
	AccountByEmail(ctx context.Context, email string) (store.Account, error)
	TouchLogin(ctx context.Context, accountID int64, at time.Time) error
	CreateSession(ctx context.Context, s store.Session) error
	ActiveSession(ctx context.Context, tokenHash []byte, kind store.SessionKind, now time.Time) (store.Session, error)
	DeleteSession(ctx context.Context, tokenHash []byte) error
	DeleteExpiredSessions(ctx context.Context, now time.Time) (int64, error)
	ListCharacters(ctx context.Context, accountID int64) ([]store.Character, error)
	CreateCharacter(ctx context.Context, c store.NewCharacter, maxPerAccount int) (store.Character, error)
}

// Config configures a Service. Zero durations and limits take the defaults below.
type Config struct {
	Repo      Repo
	Clock     clock.Clock
	Vocations content.Vocations
	// Vocations a new character may pick. Empty = every loaded vocation.
	PlayableVocations []string
	AccountTokenTTL   time.Duration // default 30 days
	MaxCharacters     int           // per account, default 10
	Hash              HashParams    // default DefaultHashParams
	// Concurrent argon2 computations allowed; bounds memory under a login burst.
	MaxConcurrentHashes int // default 4
}

// Defaults for Config.
const (
	DefaultAccountTokenTTL     = 30 * 24 * time.Hour
	DefaultMaxCharacters       = 10
	DefaultMaxConcurrentHashes = 4
)

// Service is safe for concurrent use.
type Service struct {
	repo      Repo
	clock     clock.Clock
	playable  map[string]content.Vocation
	tokenTTL  time.Duration
	maxChars  int
	hash      HashParams
	hashSlots chan struct{}
	// dummyHash is verified when the email does not exist, so a login takes the same
	// time whether or not the account exists.
	dummyHash string
}

// New validates cfg and builds a Service.
func New(cfg Config) (*Service, error) {
	if cfg.Repo == nil || cfg.Clock == nil {
		return nil, errors.New("auth: Repo and Clock are required")
	}
	if len(cfg.Vocations) == 0 {
		return nil, errors.New("auth: no vocations loaded")
	}
	s := &Service{
		repo:     cfg.Repo,
		clock:    cfg.Clock,
		playable: map[string]content.Vocation{},
		tokenTTL: cfg.AccountTokenTTL,
		maxChars: cfg.MaxCharacters,
		hash:     cfg.Hash,
	}
	if len(cfg.PlayableVocations) == 0 {
		s.playable = cfg.Vocations
	}
	for _, id := range cfg.PlayableVocations {
		v, ok := cfg.Vocations[id]
		if !ok {
			return nil, fmt.Errorf("auth: playable vocation %q is not in vocations.yaml", id)
		}
		s.playable[id] = v
	}
	if s.tokenTTL <= 0 {
		s.tokenTTL = DefaultAccountTokenTTL
	}
	if s.maxChars <= 0 {
		s.maxChars = DefaultMaxCharacters
	}
	if s.hash == (HashParams{}) {
		s.hash = DefaultHashParams
	}
	slots := cfg.MaxConcurrentHashes
	if slots <= 0 {
		slots = DefaultMaxConcurrentHashes
	}
	s.hashSlots = make(chan struct{}, slots)
	dummy, err := hashPassword("dummy password for timing", s.hash)
	if err != nil {
		return nil, err
	}
	s.dummyHash = dummy
	return s, nil
}

// withHashSlot runs fn while holding one of the bounded argon2 slots.
func (s *Service) withHashSlot(ctx context.Context, fn func() error) error {
	select {
	case s.hashSlots <- struct{}{}:
	case <-ctx.Done():
		return fmt.Errorf("auth: waiting for hash slot: %w", ctx.Err())
	}
	defer func() { <-s.hashSlots }()
	return fn()
}

// Register creates an account with email and password and returns its id.
func (s *Service) Register(ctx context.Context, email, password string) (int64, error) {
	email, ok := NormalizeEmail(email)
	if !ok {
		return 0, ErrInvalidEmail
	}
	if !ValidPassword(password) {
		return 0, ErrInvalidPassword
	}
	var hash string
	err := s.withHashSlot(ctx, func() error {
		var err error
		hash, err = hashPassword(password, s.hash)
		return err
	})
	if err != nil {
		return 0, err
	}
	id, err := s.repo.CreateAccount(ctx, email, hash)
	if errors.Is(err, store.ErrEmailTaken) {
		return 0, ErrEmailTaken
	}
	if err != nil {
		return 0, fmt.Errorf("register: %w", err)
	}
	return id, nil
}

// Token is an issued session token. The plain token is only ever returned here.
type Token struct {
	Token     string
	AccountID int64
	ExpiresAt time.Time
}

// Login checks the credentials and issues an account token.
func (s *Service) Login(ctx context.Context, email, password string) (Token, error) {
	email, ok := NormalizeEmail(email)
	if !ok || len(password) > 4*MaxPasswordLen {
		return Token{}, ErrInvalidCredentials
	}
	acc, err := s.repo.AccountByEmail(ctx, email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return Token{}, fmt.Errorf("login: %w", err)
	}
	encoded := acc.PasswordHash
	if encoded == "" { // unknown email or OAuth-only account
		encoded = s.dummyHash
	}
	var match bool
	err = s.withHashSlot(ctx, func() error {
		var err error
		match, err = verifyPassword(password, encoded)
		return err
	})
	if err != nil {
		return Token{}, fmt.Errorf("login: %w", err)
	}
	if !match || acc.PasswordHash == "" {
		return Token{}, ErrInvalidCredentials
	}
	if acc.Disabled {
		return Token{}, ErrAccountDisabled
	}

	now := s.clock.Now()
	token, hash, err := newToken()
	if err != nil {
		return Token{}, err
	}
	sess := store.Session{
		TokenHash: hash,
		AccountID: acc.ID,
		Kind:      store.SessionAccount,
		CreatedAt: now,
		ExpiresAt: now.Add(s.tokenTTL),
	}
	if err := s.repo.CreateSession(ctx, sess); err != nil {
		return Token{}, fmt.Errorf("login: %w", err)
	}
	if err := s.repo.TouchLogin(ctx, acc.ID, now); err != nil {
		return Token{}, fmt.Errorf("login: %w", err)
	}
	return Token{Token: token, AccountID: acc.ID, ExpiresAt: sess.ExpiresAt}, nil
}

// Authenticate resolves an account token to its account id.
func (s *Service) Authenticate(ctx context.Context, token string) (int64, error) {
	if token == "" || len(token) > 128 {
		return 0, ErrUnauthorized
	}
	sess, err := s.repo.ActiveSession(ctx, hashToken(token), store.SessionAccount, s.clock.Now())
	if errors.Is(err, store.ErrNotFound) {
		return 0, ErrUnauthorized
	}
	if err != nil {
		return 0, fmt.Errorf("authenticate: %w", err)
	}
	return sess.AccountID, nil
}

// Logout revokes a token. Revoking an unknown token succeeds.
func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" || len(token) > 128 {
		return nil
	}
	if err := s.repo.DeleteSession(ctx, hashToken(token)); err != nil {
		return fmt.Errorf("logout: %w", err)
	}
	return nil
}

// PurgeExpiredSessions deletes expired sessions and returns how many it removed.
func (s *Service) PurgeExpiredSessions(ctx context.Context) (int64, error) {
	n, err := s.repo.DeleteExpiredSessions(ctx, s.clock.Now())
	if err != nil {
		return 0, fmt.Errorf("purge sessions: %w", err)
	}
	return n, nil
}

// Characters lists the account's characters.
func (s *Service) Characters(ctx context.Context, accountID int64) ([]store.Character, error) {
	cs, err := s.repo.ListCharacters(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("characters: %w", err)
	}
	return cs, nil
}

// CreateCharacter validates the name and vocation and creates a level 1 character with
// the vocation's starting health and mana.
func (s *Service) CreateCharacter(ctx context.Context, accountID int64, name, vocation string) (store.Character, error) {
	if !ValidCharacterName(name) {
		return store.Character{}, ErrInvalidName
	}
	v, ok := s.playable[vocation]
	if !ok {
		return store.Character{}, ErrInvalidVocation
	}
	c, err := s.repo.CreateCharacter(ctx, store.NewCharacter{
		AccountID: accountID,
		Name:      name,
		Vocation:  v.ID,
		Health:    v.Start.Health,
		Mana:      v.Start.Mana,
	}, s.maxChars)
	switch {
	case errors.Is(err, store.ErrNameTaken):
		return store.Character{}, ErrNameTaken
	case errors.Is(err, store.ErrCharacterLimit):
		return store.Character{}, ErrCharacterLimit
	case err != nil:
		return store.Character{}, fmt.Errorf("create character: %w", err)
	}
	return c, nil
}
