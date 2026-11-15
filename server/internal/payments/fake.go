package payments

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// FakeName is the fake provider's id (/api/payments/webhook/fake).
const FakeName = "fake"

// FakeSignatureHeader carries hex(HMAC-SHA256(secret, body)) on a fake webhook.
const FakeSignatureHeader = "X-Fake-Signature"

// FakeCheckoutPath is where the fake hosted checkout lives: visiting
// FakeCheckoutPath + <session> pays (httpapi/shop.go). Only served with the fake provider.
const FakeCheckoutPath = "/api/shop/fake-checkout/"

// Fake is a provider without network for tests, e2e and development. Its checkout URL is
// a local page of the server that pays at once by sending itself a webhook signed with
// the fake secret. It refuses to exist in production.
type Fake struct {
	secret []byte
}

var _ Provider = (*Fake)(nil)

// NewFake returns the fake provider for env (ErrFakeInProduction unless development or
// test). An empty secret is replaced by a random one (then only this process can sign).
func NewFake(env Env, secret string) (*Fake, error) {
	if env != EnvDevelopment && env != EnvTest {
		return nil, ErrFakeInProduction
	}
	key := []byte(secret)
	if len(key) == 0 {
		key = make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, fmt.Errorf("payments: fake secret: %w", err)
		}
	}
	return &Fake{secret: key}, nil
}

// Name implements Provider.
func (f *Fake) Name() string { return FakeName }

// CreateCheckout implements Provider: the session is a signed reference, so the fake
// keeps no state. The URL is relative to the website (same origin as /api).
func (f *Fake) CreateCheckout(_ context.Context, pack Pack, accountID int64, _ string) (Checkout, error) {
	ref, err := SignReference(f.secret, accountID, pack.ID)
	if err != nil {
		return Checkout{}, err
	}
	return Checkout{URL: FakeCheckoutPath + url.PathEscape(ref), SessionID: ref}, nil
}

// FakeNotification is the body of a fake webhook.
type FakeNotification struct {
	Type        EventType `json:"type"`
	Reference   string    `json:"reference"`
	AmountMinor int64     `json:"amount_minor"`
	Currency    string    `json:"currency"`
}

// Notification builds the signed webhook request a fake payment of session sends: what
// the fake checkout page posts to the webhook route (and what tests send).
func (f *Fake) Notification(target string, n FakeNotification) (*http.Request, error) {
	body, err := json.Marshal(n)
	if err != nil {
		return nil, fmt.Errorf("payments: fake notification: %w", err)
	}
	r, err := http.NewRequest(http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("payments: fake notification: %w", err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(FakeSignatureHeader, hmacHex(f.secret, string(body)))
	return r, nil
}

// ParseWebhook implements Provider.
func (f *Fake) ParseWebhook(r *http.Request) (Event, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if err != nil {
		return Event{}, ErrSignature
	}
	if !hmac.Equal([]byte(hmacHex(f.secret, string(body))), []byte(r.Header.Get(FakeSignatureHeader))) {
		return Event{}, ErrSignature
	}
	var n FakeNotification
	if err := json.Unmarshal(body, &n); err != nil {
		return Event{}, ErrSignature
	}
	account, pack, nonce, err := VerifyReference(f.secret, n.Reference)
	if err != nil {
		return Event{}, err
	}
	switch n.Type {
	case Paid, Refunded, Chargeback:
	default:
		return Event{}, ErrIgnored
	}
	pay := "fake-" + nonce
	return Event{ID: eventID(pay, n.Type), Type: n.Type, PaymentID: pay, AccountID: account, PackID: pack,
		AmountMinor: n.AmountMinor, Currency: n.Currency}, nil
}

// SessionPack verifies a fake checkout session and returns its account and pack.
func (f *Fake) SessionPack(session string) (accountID int64, packID string, err error) {
	accountID, packID, _, err = VerifyReference(f.secret, session)
	return accountID, packID, err
}
