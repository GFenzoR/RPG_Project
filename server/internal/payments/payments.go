// Package payments talks to the payment provider of the cosmetic shop (T5.7, docs/01
// "Pagos", docs/09 for the keys): a hosted checkout where the player pays (the server
// never sees card data) and a signed webhook that confirms the payment. Two providers:
// Fake (tests, e2e and development; refused in production) and MercadoPago (Checkout
// Pro, in test mode until the owner goes live).
//
// The provider only says "account A paid pack P" (or that the payment was refunded or
// charged back). What a pack is worth in premium currency, and every balance change,
// is decided by the server (httpapi/shop.go, store.ApplyPayment).
package payments

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// Limits of the payments (the shop's daily limit, equip anti-flood and staff grant bound
// live in data/cosmetics.yaml limits).
const (
	// LimitWindow is the window of the daily premium limit (limits.daily_premium).
	LimitWindow = 24 * time.Hour
	// MaxWebhookAge rejects a signed Mercado Pago notification older than this (replay).
	MaxWebhookAge = 10 * time.Minute
)

// EventType is what a webhook confirms.
type EventType string

// Event types (payment_events.type).
const (
	Paid       EventType = "paid"
	Refunded   EventType = "refunded"
	Chargeback EventType = "chargeback"
	// Dispute: the payment is in mediation; the account is flagged, nothing is debited.
	Dispute EventType = "dispute"
)

// Reasons of an unmatched payment (Event.Unmatched; the same codes as store.Unmatched*).
const (
	UnmatchedReference = "bad_reference"
	UnmatchedCurrency  = "unknown_currency"
)

// Event is a verified notification: the provider confirmed this state of a payment.
type Event struct {
	// ID is the idempotency key: the provider's payment id plus the confirmed state, so
	// the many notifications a provider sends for one payment credit it once.
	ID        string
	Type      EventType
	PaymentID string
	AccountID int64
	PackID    string
	// AmountMinor and Currency are what the provider confirmed was paid (minor units).
	AmountMinor int64
	Currency    string
	// RefundedMinor (Refunded): the total refunded so far when only part of the payment
	// was refunded (0: all of it). Each new refunded amount is a new event id.
	RefundedMinor int64
	// Unmatched is set with ErrUnmatched: why an approved payment cannot be credited.
	Unmatched string
}

// Pack is what a checkout sells (data/cosmetics.yaml packs).
type Pack struct {
	ID string
	// Price in the minor unit of Currency.
	Price    int64
	Currency string
	// Title is shown on the provider's page.
	Title string
}

// Checkout is a started hosted checkout: the browser goes to URL.
type Checkout struct {
	URL       string
	SessionID string
}

// Provider is a payment provider.
type Provider interface {
	// Name is the provider id in URLs and in payment_events.provider.
	Name() string
	// CreateCheckout starts a hosted checkout of pack for account. key is an idempotency
	// key: the same key never creates two checkouts at the provider.
	CreateCheckout(ctx context.Context, pack Pack, accountID int64, key string) (Checkout, error)
	// ParseWebhook verifies a notification (signature, age) and returns the event it
	// confirms. ErrSignature: not from the provider; ErrIgnored: nothing to do (another
	// topic, a pending payment...; it may wrap a detail worth a warning); ErrUnmatched:
	// an approved payment that cannot be credited (the Event says what is known, for
	// staff reconciliation).
	ParseWebhook(r *http.Request) (Event, error)
}

// Errors of ParseWebhook and CreateCheckout.
var (
	ErrSignature = errors.New("payments: invalid or stale signature")
	ErrIgnored   = errors.New("payments: notification ignored")
	ErrProvider  = errors.New("payments: provider error")
	// ErrUnmatched: the provider confirmed an approved payment we cannot credit (its
	// reference does not verify, or its currency is unknown).
	ErrUnmatched = errors.New("payments: approved payment cannot be credited")
)

// Env is the server's environment (RPG_ENV): only development and test allow the fake
// provider. Anything else (unset included) is production.
type Env string

// Environments.
const (
	EnvProduction  Env = "production"
	EnvDevelopment Env = "development"
	EnvTest        Env = "test"
)

// ParseEnv reads RPG_ENV; empty or unknown values are production (the safe side).
func ParseEnv(s string) Env {
	switch Env(strings.ToLower(strings.TrimSpace(s))) {
	case EnvDevelopment:
		return EnvDevelopment
	case EnvTest:
		return EnvTest
	default:
		return EnvProduction
	}
}

// ErrFakeInProduction is returned for PAYMENTS_PROVIDER=fake with RPG_ENV not development or test.
var ErrFakeInProduction = errors.New("payments: the fake provider is refused in production (set RPG_ENV=development to use it)")

// FromEnv builds the provider configured by the environment (docs/09):
// PAYMENTS_PROVIDER = "" (shop off: nil, nil) | fake | mercadopago, with MP_ACCESS_TOKEN,
// MP_WEBHOOK_SECRET, PAYMENTS_REF_SECRET (and optionally PAYMENTS_REF_SECRET_PREVIOUS
// while rotating it) and the public URL for mercadopago, and PAYMENTS_FAKE_SECRET
// (optional; random) for fake. publicURL is the website's base URL (PUBLIC_URL).
func FromEnv(getenv func(string) string, env Env, publicURL string, client *http.Client, clk clock.Clock) (Provider, error) {
	switch p := strings.TrimSpace(getenv("PAYMENTS_PROVIDER")); p {
	case "":
		return nil, nil
	case "fake":
		return NewFake(env, getenv("PAYMENTS_FAKE_SECRET"))
	case "mercadopago":
		return NewMercadoPago(MercadoPagoConfig{
			AccessToken:       getenv("MP_ACCESS_TOKEN"),
			WebhookSecret:     getenv("MP_WEBHOOK_SECRET"),
			RefSecret:         getenv("PAYMENTS_REF_SECRET"),
			RefSecretPrevious: getenv("PAYMENTS_REF_SECRET_PREVIOUS"),
			PublicURL:         publicURL,
			Env:               env,
			Client:            client,
			Clock:             clk,
		})
	default:
		return nil, fmt.Errorf("payments: unknown PAYMENTS_PROVIDER %q (fake or mercadopago)", p)
	}
}

// ---- signed references --------------------------------------------------------------

// A reference ties a checkout to an account and a pack without server-side state:
// "<account>.<pack>.<nonce>.<mac>", mac = first 16 bytes of HMAC-SHA256(key, the rest),
// base64url. It travels as Mercado Pago's external_reference and as the fake session id.

// SignReference returns a new reference for account and pack.
func SignReference(key []byte, accountID int64, packID string) (string, error) {
	var n [12]byte
	if _, err := rand.Read(n[:]); err != nil {
		return "", fmt.Errorf("payments: nonce: %w", err)
	}
	body := strconv.FormatInt(accountID, 10) + "." + packID + "." + base64.RawURLEncoding.EncodeToString(n[:])
	return body + "." + refMAC(key, body), nil
}

// VerifyReference checks a reference and returns its account, pack and nonce.
func VerifyReference(key []byte, ref string) (accountID int64, packID, nonce string, err error) {
	parts := strings.Split(ref, ".")
	if len(parts) != 4 || len(ref) > 256 {
		return 0, "", "", ErrSignature
	}
	body := strings.Join(parts[:3], ".")
	if !hmac.Equal([]byte(refMAC(key, body)), []byte(parts[3])) {
		return 0, "", "", ErrSignature
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || id <= 0 || parts[1] == "" {
		return 0, "", "", ErrSignature
	}
	return id, parts[1], parts[2], nil
}

// verifyReferenceAny is VerifyReference with the first key that verifies (the current
// secret, then the previous one while it is being rotated).
func verifyReferenceAny(keys [][]byte, ref string) (accountID int64, packID, nonce string, err error) {
	err = ErrSignature
	for _, k := range keys {
		if len(k) == 0 {
			continue
		}
		if accountID, packID, nonce, err = VerifyReference(k, ref); err == nil {
			return accountID, packID, nonce, nil
		}
	}
	return 0, "", "", err
}

func refMAC(key []byte, body string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte("ref:" + body))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:16])
}

func hmacHex(key []byte, msg string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

// eventID is the idempotency key of a confirmed payment state.
func eventID(paymentID string, t EventType) string { return paymentID + ":" + string(t) }
