package auth

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/mail"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Email verification and password reset (T2.1, docs/01-architecture.md "Cuentas").
//
// Links carry a 256-bit random token in the URL fragment (/verify#token=…), which the
// browser never sends to a server, so it cannot end up in an access log; the website's
// page posts it to the API. Only the SHA-256 is stored and the lookup is by that hash,
// so no comparison ever runs on the secret itself.

// Errors of the email flows.
var (
	// ErrInvalidToken: unknown, used or expired link token.
	ErrInvalidToken = errors.New("auth: invalid or expired link")
	// ErrEmailUnverified: the action needs a verified email (map portal, or playing with
	// RequireVerifiedEmail).
	ErrEmailUnverified = errors.New("auth: email not verified")
	// ErrAlreadyVerified: a verification was asked for an already verified email.
	ErrAlreadyVerified = errors.New("auth: email already verified")
	// ErrEmailDisabled: the server has no mailer, so the email flows are off.
	ErrEmailDisabled = errors.New("auth: email is not configured on this server")
)

// Token lifetimes (docs/05).
const (
	DefaultVerifyTokenTTL = 24 * time.Hour
	DefaultResetTokenTTL  = time.Hour
)

// Emailer renders and queues an account email. *mail.Sender implements it.
type Emailer interface {
	Send(kind mail.Kind, to, lang, link string) error
	// Lang returns lang if the emails exist in it, else the default language.
	Lang(lang string) string
}

var _ Emailer = (*mail.Sender)(nil)

// CheckPublicURL validates the public base URL of the website (PUBLIC_URL) and returns
// it without a trailing slash.
func CheckPublicURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" ||
		u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("auth: public URL %q must be like https://example.com", raw)
	}
	return strings.TrimRight(raw, "/"), nil
}

// link is the website page that redeems a token, e.g. https://x/verify?lang=es#token=….
func link(publicURL, page, lang, token string) string {
	q := ""
	if lang != "" {
		q = "?lang=" + url.QueryEscape(lang)
	}
	return publicURL + "/" + page + q + "#token=" + token
}

// EmailEnabled reports whether the server sends emails (verification and reset). When
// false, everything behaves as without T2.1: nobody is asked to verify.
func (s *Service) EmailEnabled() bool { return s.mail != nil }

// Profile returns the account as the account itself sees it.
func (s *Service) Profile(ctx context.Context, accountID int64) (store.Profile, error) {
	p, err := s.repo.AccountProfile(ctx, accountID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Profile{}, ErrUnauthorized
	}
	if err != nil {
		return store.Profile{}, fmt.Errorf("profile: %w", err)
	}
	return p, nil
}

// RequireVerified returns ErrEmailUnverified if email is enabled and the account has not
// verified its email (map portal; playing with RequireVerifiedEmail). Without email
// nothing can be verified, so nothing is required.
func (s *Service) RequireVerified(ctx context.Context, accountID int64) error {
	if s.mail == nil {
		return nil
	}
	p, err := s.Profile(ctx, accountID)
	if err != nil {
		return err
	}
	if !p.EmailVerified {
		return ErrEmailUnverified
	}
	return nil
}

// SendVerification emails a new verification link to the account (registration and
// "resend"); any older link stops working. lang is the language of the request: it
// becomes the account's language if the account has none yet.
func (s *Service) SendVerification(ctx context.Context, accountID int64, lang string) error {
	if s.mail == nil {
		return ErrEmailDisabled
	}
	p, err := s.Profile(ctx, accountID)
	if err != nil {
		return err
	}
	if p.EmailVerified {
		return ErrAlreadyVerified
	}
	if p.Disabled {
		return ErrAccountDisabled
	}
	lang, err = s.accountLang(ctx, p, lang)
	if err != nil {
		return err
	}
	token, err := s.issue(ctx, p, store.TokenVerifyEmail, s.verifyTTL)
	if err != nil {
		return err
	}
	if err := s.mail.Send(mail.KindVerify, p.Email, lang, link(s.publicURL, "verify", lang, token)); err != nil {
		return fmt.Errorf("send verification: %w", err)
	}
	return nil
}

// accountLang is the language of the account's emails: the stored one, else lang (if
// the emails exist in it, stored for next time), else the default.
func (s *Service) accountLang(ctx context.Context, p store.Profile, lang string) (string, error) {
	if p.Locale != "" {
		return s.mail.Lang(p.Locale), nil
	}
	if lang != "" && s.mail.Lang(lang) == lang {
		if err := s.repo.SetAccountLocale(ctx, p.ID, lang); err != nil {
			return "", fmt.Errorf("account language: %w", err)
		}
		return lang, nil
	}
	return s.mail.Lang(""), nil
}

func (s *Service) issue(ctx context.Context, p store.Profile, purpose store.TokenPurpose, ttl time.Duration) (string, error) {
	token, hash, err := newToken()
	if err != nil {
		return "", err
	}
	now := s.clock.Now()
	if err := s.repo.ReplaceAccountToken(ctx, store.AccountToken{
		TokenHash: hash, AccountID: p.ID, Purpose: purpose, Email: p.Email,
		CreatedAt: now, ExpiresAt: now.Add(ttl),
	}); err != nil {
		return "", fmt.Errorf("issue %s token: %w", purpose, err)
	}
	return token, nil
}

// VerifyEmail redeems a verification token.
func (s *Service) VerifyEmail(ctx context.Context, token string) error {
	if !plausibleToken(token) {
		return ErrInvalidToken
	}
	_, err := s.repo.VerifyEmail(ctx, hashToken(token), s.clock.Now())
	if errors.Is(err, store.ErrNotFound) {
		return ErrInvalidToken
	}
	if err != nil {
		return fmt.Errorf("verify email: %w", err)
	}
	return nil
}

// RequestPasswordReset emails a reset link if email is an existing, enabled account
// with a verified email. It returns nil in every other case too, so the answer never
// tells whether an account exists (the HTTP API answers the same either way). Only
// real failures (database, full mail queue) are errors, and those are not specific to
// the address.
func (s *Service) RequestPasswordReset(ctx context.Context, email, lang string) error {
	if s.mail == nil {
		return ErrEmailDisabled
	}
	email, ok := NormalizeEmail(email)
	if !ok {
		return nil
	}
	acc, err := s.repo.AccountByEmail(ctx, email)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("password reset: %w", err)
	}
	p, err := s.Profile(ctx, acc.ID)
	if err != nil {
		return err
	}
	// An unverified address may not be the owner's: a reset link would hand the
	// account to whoever owns the mailbox later. The operator can still issue a link by
	// hand (gameserver admin reset-link).
	if p.Disabled || !p.EmailVerified {
		return nil
	}
	lang, err = s.accountLang(ctx, p, lang)
	if err != nil {
		return err
	}
	token, err := s.issue(ctx, p, store.TokenResetPassword, s.resetTTL)
	if err != nil {
		return err
	}
	if err := s.mail.Send(mail.KindReset, p.Email, lang, link(s.publicURL, "reset-password", lang, token)); err != nil {
		return fmt.Errorf("password reset: %w", err)
	}
	return nil
}

// ResetPassword redeems a reset token (emailed, or from gameserver admin reset-link): it
// sets the new password and revokes every stored session of the account (one
// transaction), then has the game disconnect the account's online characters
// (Config.SessionsRevoked).
func (s *Service) ResetPassword(ctx context.Context, token, password string) error {
	if !ValidPassword(password) {
		return ErrInvalidPassword
	}
	if !plausibleToken(token) {
		return ErrInvalidToken
	}
	var hash string
	err := s.withHashSlot(ctx, func() error {
		var err error
		hash, err = hashPassword(password, s.hash)
		return err
	})
	if errors.Is(err, ErrBusy) {
		return ErrBusy
	}
	if err != nil {
		return err
	}
	id, err := s.repo.ResetPassword(ctx, hashToken(token), hash, s.clock.Now())
	if errors.Is(err, store.ErrNotFound) {
		return ErrInvalidToken
	}
	if err != nil {
		return fmt.Errorf("reset password: %w", err)
	}
	if s.revoked != nil {
		s.revoked(id) // online characters too, not only the stored tokens
	}
	return nil
}

// plausibleToken rejects what newToken could never have produced, before any lookup.
func plausibleToken(t string) bool {
	if len(t) != 43 {
		return false
	}
	for _, c := range t {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// ResetLinkRepo is what IssueResetLink needs. *store.Store implements it.
type ResetLinkRepo interface {
	AccountProfileByEmail(ctx context.Context, email string) (store.Profile, error)
	ReplaceAccountToken(ctx context.Context, t store.AccountToken) error
}

// IssueResetLink creates a password reset link for the operator to hand over by other
// means (gameserver admin reset-link; no SMTP needed). It works for unverified accounts
// too: the operator is the one checking who asks. The link is returned, never logged.
func IssueResetLink(ctx context.Context, repo ResetLinkRepo, now time.Time, publicURL, email string) (string, store.Profile, error) {
	base, err := CheckPublicURL(publicURL)
	if err != nil {
		return "", store.Profile{}, err
	}
	norm, ok := NormalizeEmail(email)
	if !ok {
		return "", store.Profile{}, ErrInvalidEmail
	}
	p, err := repo.AccountProfileByEmail(ctx, norm)
	if err != nil {
		return "", store.Profile{}, fmt.Errorf("reset link: %w", err)
	}
	token, hash, err := newToken()
	if err != nil {
		return "", store.Profile{}, err
	}
	if err := repo.ReplaceAccountToken(ctx, store.AccountToken{
		TokenHash: hash, AccountID: p.ID, Purpose: store.TokenResetPassword, Email: p.Email,
		CreatedAt: now, ExpiresAt: now.Add(DefaultResetTokenTTL),
	}); err != nil {
		return "", store.Profile{}, fmt.Errorf("reset link: %w", err)
	}
	return link(base, "reset-password", p.Locale, token), p, nil
}
