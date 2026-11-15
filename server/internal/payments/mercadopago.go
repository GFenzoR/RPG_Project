package payments

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// MercadoPagoName is the Mercado Pago provider's id (/api/payments/webhook/mercadopago).
const MercadoPagoName = "mercadopago"

// DefaultMercadoPagoAPI is the Mercado Pago API base URL.
const DefaultMercadoPagoAPI = "https://api.mercadopago.com"

// MercadoPagoConfig configures MercadoPago. Keys come only from the environment.
type MercadoPagoConfig struct {
	// AccessToken (MP_ACCESS_TOKEN): "TEST-..." for the test mode.
	AccessToken string
	// WebhookSecret (MP_WEBHOOK_SECRET): the secret of the webhook configured in the
	// Mercado Pago panel ("Tus integraciones" → Webhooks); signs x-signature only.
	WebhookSecret string
	// RefSecret (PAYMENTS_REF_SECRET) signs the external_reference of our preferences.
	// It is ours, apart from the webhook secret: rotating the webhook secret in the
	// panel never invalidates the references of checkouts already paid.
	RefSecret string
	// RefSecretPrevious (PAYMENTS_REF_SECRET_PREVIOUS, optional) still verifies
	// references while RefSecret is being rotated (keep it until the checkouts signed
	// with it are paid or abandoned: a day or two).
	RefSecretPrevious string
	// PublicURL is the website's base URL: notification_url and back_urls hang from it.
	PublicURL string
	// Env is the server's environment: production (the default) requires an https
	// PublicURL.
	Env Env
	// BaseURL replaces DefaultMercadoPagoAPI (tests: an httptest server).
	BaseURL string
	// Client does every request (default: a client with a 10 s timeout).
	Client *http.Client
	// Clock is the clock of the signature's age check (default clock.Real; the server
	// passes its injected clock).
	Clock clock.Clock
}

// MercadoPago is Checkout Pro: a preference per checkout, the player pays on Mercado
// Pago's page, and a signed webhook (x-signature) says a payment changed; the payment is
// then read back with the access token (GET /v1/payments/<id>) and only its status there
// counts: approved = paid (with transaction_amount_refunded > 0: a partial refund),
// refunded, charged_back = chargeback, in_mediation = dispute.
type MercadoPago struct {
	cfg MercadoPagoConfig
}

var _ Provider = (*MercadoPago)(nil)

// NewMercadoPago checks cfg and returns the provider.
func NewMercadoPago(cfg MercadoPagoConfig) (*MercadoPago, error) {
	if cfg.AccessToken == "" || cfg.WebhookSecret == "" || cfg.RefSecret == "" {
		return nil, errors.New("payments: mercadopago needs MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET and PAYMENTS_REF_SECRET")
	}
	u, err := url.Parse(cfg.PublicURL)
	if cfg.PublicURL == "" || err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, errors.New("payments: mercadopago needs PUBLIC_URL (the website's base URL)")
	}
	if u.Scheme != "https" && cfg.Env != EnvDevelopment && cfg.Env != EnvTest {
		return nil, errors.New("payments: mercadopago needs an https PUBLIC_URL in production")
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultMercadoPagoAPI
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: 10 * time.Second}
	}
	if cfg.Clock == nil {
		cfg.Clock = clock.Real{}
	}
	return &MercadoPago{cfg: cfg}, nil
}

// Name implements Provider.
func (m *MercadoPago) Name() string { return MercadoPagoName }

// currencyExponent is the ISO 4217 minor unit of the currencies Mercado Pago sells in.
var currencyExponent = map[string]int{
	"CLP": 0, "ARS": 2, "BRL": 2, "MXN": 2, "COP": 2, "PEN": 2, "UYU": 2, "USD": 2,
}

// unitPrice converts a minor-unit price to Mercado Pago's unit_price (major units).
func unitPrice(minor int64, currency string) (float64, error) {
	exp, ok := currencyExponent[currency]
	if !ok {
		return 0, fmt.Errorf("payments: currency %q not supported by mercadopago", currency)
	}
	return float64(minor) / math.Pow10(exp), nil
}

// minorUnits converts Mercado Pago's transaction_amount back to minor units.
func minorUnits(amount float64, currency string) (int64, bool) {
	exp, ok := currencyExponent[currency]
	if !ok {
		return 0, false
	}
	return int64(math.Round(amount * math.Pow10(exp))), true
}

type mpItem struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Quantity   int     `json:"quantity"`
	UnitPrice  float64 `json:"unit_price"`
	CurrencyID string  `json:"currency_id"`
}

type mpPreference struct {
	Items             []mpItem          `json:"items"`
	ExternalReference string            `json:"external_reference"`
	NotificationURL   string            `json:"notification_url"`
	BackURLs          map[string]string `json:"back_urls"`
	AutoReturn        string            `json:"auto_return"`
}

// CreateCheckout implements Provider: POST /checkout/preferences. The player pays at
// init_point (sandbox_init_point with a TEST- access token, when Mercado Pago gives it).
func (m *MercadoPago) CreateCheckout(ctx context.Context, pack Pack, accountID int64, key string) (Checkout, error) {
	price, err := unitPrice(pack.Price, pack.Currency)
	if err != nil {
		return Checkout{}, err
	}
	ref, err := SignReference([]byte(m.cfg.RefSecret), accountID, pack.ID)
	if err != nil {
		return Checkout{}, err
	}
	title := pack.Title
	if title == "" {
		title = pack.ID
	}
	back := m.cfg.PublicURL + "/shop?checkout="
	body, err := json.Marshal(mpPreference{
		Items:             []mpItem{{ID: pack.ID, Title: title, Quantity: 1, UnitPrice: price, CurrencyID: pack.Currency}},
		ExternalReference: ref,
		NotificationURL:   m.cfg.PublicURL + "/api/payments/webhook/" + MercadoPagoName,
		BackURLs:          map[string]string{"success": back + "success", "failure": back + "failure", "pending": back + "pending"},
		AutoReturn:        "approved",
	})
	if err != nil {
		return Checkout{}, fmt.Errorf("payments: preference: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.cfg.BaseURL+"/checkout/preferences", bytes.NewReader(body))
	if err != nil {
		return Checkout{}, fmt.Errorf("payments: preference: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Idempotency-Key", key)
	var out struct {
		ID               string `json:"id"`
		InitPoint        string `json:"init_point"`
		SandboxInitPoint string `json:"sandbox_init_point"`
	}
	if err := m.do(req, &out); err != nil {
		return Checkout{}, err
	}
	u := out.InitPoint
	if strings.HasPrefix(m.cfg.AccessToken, "TEST-") && out.SandboxInitPoint != "" {
		u = out.SandboxInitPoint
	}
	if !strings.HasPrefix(u, "https://") || out.ID == "" {
		return Checkout{}, fmt.Errorf("%w: preference without an https checkout URL", ErrProvider)
	}
	return Checkout{URL: u, SessionID: out.ID}, nil
}

// do sends req with the access token and decodes a 2xx JSON answer into out.
func (m *MercadoPago) do(req *http.Request, out any) error {
	req.Header.Set("Authorization", "Bearer "+m.cfg.AccessToken)
	resp, err := m.cfg.Client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrProvider, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("%w: read: %w", ErrProvider, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &statusError{method: req.Method, path: req.URL.Path, code: resp.StatusCode}
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: decode: %w", ErrProvider, err)
	}
	return nil
}

// statusError is a non-2xx answer of the Mercado Pago API (it is an ErrProvider).
type statusError struct {
	method, path string
	code         int
}

func (e *statusError) Error() string {
	return fmt.Sprintf("%v: %s %s: status %d", ErrProvider, e.method, e.path, e.code)
}

func (e *statusError) Unwrap() error { return ErrProvider }

// permanent: retrying will not change a 404 (no such payment) or a 400 (a malformed
// id). Every other answer is retried: 429, 5xx, and 401/403 too, which mean our access
// token is wrong or revoked (a configuration error that affects every payment: never a
// reason to drop one; the webhook logs it at error level and Mercado Pago retries).
func (e *statusError) permanent() bool {
	return e.code == http.StatusNotFound || e.code == http.StatusBadRequest
}

// paymentIDRe bounds what we accept as a payment id (Mercado Pago's are numeric).
var paymentIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ParseWebhook implements Provider. It verifies x-signature: "ts=<ts>,v1=<hex>", where
// v1 = HMAC-SHA256(MP_WEBHOOK_SECRET, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;")
// (data.id lowercased; a missing part is left out of the manifest, as Mercado Pago
// documents), compared in constant time, and rejects a ts older than MaxWebhookAge.
// Then it reads the payment with the access token: only that answer is trusted.
func (m *MercadoPago) ParseWebhook(r *http.Request) (Event, error) {
	q := r.URL.Query()
	var body struct {
		Type string `json:"type"`
		Data struct {
			ID json.RawMessage `json:"id"`
		} `json:"data"`
	}
	raw, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	_ = json.Unmarshal(raw, &body)
	dataID := q.Get("data.id")
	if dataID == "" {
		dataID = strings.Trim(string(body.Data.ID), `"`)
	}
	topic := q.Get("type")
	if topic == "" {
		topic = body.Type
	}
	if err := m.verifySignature(r.Header.Get("x-signature"), r.Header.Get("x-request-id"), dataID); err != nil {
		return Event{}, err
	}
	if topic != "payment" || !paymentIDRe.MatchString(dataID) {
		return Event{}, ErrIgnored
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, m.cfg.BaseURL+"/v1/payments/"+url.PathEscape(dataID), nil)
	if err != nil {
		return Event{}, fmt.Errorf("payments: payment: %w", err)
	}
	var pay struct {
		ID                        json.Number `json:"id"`
		Status                    string      `json:"status"`
		ExternalReference         string      `json:"external_reference"`
		TransactionAmount         float64     `json:"transaction_amount"`
		TransactionAmountRefunded float64     `json:"transaction_amount_refunded"`
		CurrencyID                string      `json:"currency_id"`
	}
	if err := m.do(req, &pay); err != nil {
		var se *statusError
		if errors.As(err, &se) && se.permanent() {
			// Retrying cannot help: answer 200 (with a warning) so Mercado Pago stops.
			return Event{}, fmt.Errorf("%w: payment %s: %w", ErrIgnored, dataID, err)
		}
		return Event{}, err
	}
	id := pay.ID.String()
	if id == "" {
		id = dataID
	}
	var t EventType
	switch pay.Status {
	case "approved":
		t = Paid
	case "refunded":
		t = Refunded
	case "charged_back":
		t = Chargeback
	case "in_mediation":
		t = Dispute
	default:
		return Event{}, ErrIgnored // pending, in_process, rejected, cancelled...
	}
	amount, currencyOK := minorUnits(pay.TransactionAmount, pay.CurrencyID)
	account, pack, _, refErr := verifyReferenceAny([][]byte{[]byte(m.cfg.RefSecret), []byte(m.cfg.RefSecretPrevious)},
		pay.ExternalReference)
	if refErr != nil || !currencyOK {
		reason := UnmatchedReference
		if refErr == nil {
			reason = UnmatchedCurrency
		}
		if t != Paid {
			return Event{}, fmt.Errorf("%w: %s payment %s not ours (%s)", ErrIgnored, t, id, reason)
		}
		// Real money that cannot be credited: never drop it silently.
		return Event{ID: eventID(id, "unmatched"), Type: Paid, PaymentID: id, AccountID: account, PackID: pack,
			AmountMinor: amount, Currency: pay.CurrencyID, Unmatched: reason}, ErrUnmatched
	}
	ev := Event{ID: eventID(id, t), Type: t, PaymentID: id, AccountID: account, PackID: pack,
		AmountMinor: amount, Currency: pay.CurrencyID}
	if refunded, _ := minorUnits(pay.TransactionAmountRefunded, pay.CurrencyID); t == Paid && refunded > 0 {
		// Partially refunded (status stays approved): one event per new refunded total.
		// A refunded amount that rounds to 0 (or a negative one) is no refund at all.
		ev.Type, ev.RefundedMinor = Refunded, min(refunded, amount)
		ev.ID = eventID(id, Refunded) + ":" + strconv.FormatInt(ev.RefundedMinor, 10)
	}
	return ev, nil
}

func (m *MercadoPago) verifySignature(header, requestID, dataID string) error {
	var ts, v1 string
	for _, part := range strings.Split(header, ",") {
		k, v, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch k {
		case "ts":
			ts = v
		case "v1":
			v1 = v
		}
	}
	if ts == "" || v1 == "" {
		return ErrSignature
	}
	n, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return ErrSignature
	}
	at := time.Unix(n, 0)
	if n > 1e12 { // milliseconds
		at = time.UnixMilli(n)
	}
	if age := m.cfg.Clock.Now().Sub(at); age > MaxWebhookAge || age < -MaxWebhookAge {
		return ErrSignature
	}
	var b strings.Builder
	if dataID != "" {
		b.WriteString("id:" + strings.ToLower(dataID) + ";")
	}
	if requestID != "" {
		b.WriteString("request-id:" + requestID + ";")
	}
	b.WriteString("ts:" + ts + ";")
	if !hmac.Equal([]byte(hmacHex([]byte(m.cfg.WebhookSecret), b.String())), []byte(strings.ToLower(v1))) {
		return ErrSignature
	}
	return nil
}

// MercadoPagoSignature signs a notification like Mercado Pago does (tests and tools):
// the x-signature header value for dataID, requestID and ts (Unix seconds).
func MercadoPagoSignature(secret, dataID, requestID string, ts int64) string {
	s := strconv.FormatInt(ts, 10)
	manifest := "id:" + strings.ToLower(dataID) + ";request-id:" + requestID + ";ts:" + s + ";"
	return "ts=" + s + ",v1=" + hmacHex([]byte(secret), manifest)
}
