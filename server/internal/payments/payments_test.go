package payments

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

var t0 = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

func TestFakeRefusedInProduction(t *testing.T) {
	for _, env := range []string{"", "production", "prod", "staging"} {
		if _, err := NewFake(ParseEnv(env), "x"); !errors.Is(err, ErrFakeInProduction) {
			t.Errorf("RPG_ENV=%q: %v", env, err)
		}
		_, err := FromEnv(mapEnv{"PAYMENTS_PROVIDER": "fake"}.get, ParseEnv(env), "", nil, nil)
		if !errors.Is(err, ErrFakeInProduction) {
			t.Errorf("FromEnv RPG_ENV=%q: %v", env, err)
		}
	}
	for _, env := range []string{"development", "test", " Development "} {
		if _, err := NewFake(ParseEnv(env), ""); err != nil {
			t.Errorf("RPG_ENV=%q: %v", env, err)
		}
	}
}

type mapEnv map[string]string

func (m mapEnv) get(k string) string { return m[k] }

func TestFromEnv(t *testing.T) {
	p, err := FromEnv(mapEnv{}.get, EnvProduction, "", nil, nil)
	if p != nil || err != nil {
		t.Fatalf("unset: %v %v", p, err)
	}
	if _, err := FromEnv(mapEnv{"PAYMENTS_PROVIDER": "stripe"}.get, EnvProduction, "", nil, nil); err == nil {
		t.Fatal("unknown provider accepted")
	}
	if _, err := FromEnv(mapEnv{"PAYMENTS_PROVIDER": "mercadopago"}.get, EnvProduction, "https://x.test", nil, nil); err == nil {
		t.Fatal("mercadopago without keys accepted")
	}
	env := mapEnv{"PAYMENTS_PROVIDER": "mercadopago", "MP_ACCESS_TOKEN": "TEST-1", "MP_WEBHOOK_SECRET": "s"}
	if _, err := FromEnv(env.get, EnvProduction, "https://x.test", nil, nil); err == nil {
		t.Fatal("mercadopago without PAYMENTS_REF_SECRET accepted")
	}
	env["PAYMENTS_REF_SECRET"] = "r"
	if _, err := FromEnv(env.get, EnvProduction, "", nil, nil); err == nil {
		t.Fatal("mercadopago without PUBLIC_URL accepted")
	}
	// Production needs https; development may use a plain http tunnel or LAN address.
	for _, e := range []Env{EnvProduction, ""} {
		if _, err := FromEnv(env.get, e, "http://x.test", nil, nil); err == nil {
			t.Fatalf("env %q: http PUBLIC_URL accepted", e)
		}
	}
	if _, err := FromEnv(env.get, EnvDevelopment, "http://x.test", nil, nil); err != nil {
		t.Fatalf("development http: %v", err)
	}
	p, err = FromEnv(env.get, EnvProduction, "https://x.test/", nil, nil)
	if err != nil || p.Name() != MercadoPagoName {
		t.Fatalf("mercadopago: %v %v", p, err)
	}
}

func TestReference(t *testing.T) {
	key := []byte("k")
	ref, err := SignReference(key, 42, "pack_small")
	if err != nil {
		t.Fatal(err)
	}
	acc, pack, _, err := VerifyReference(key, ref)
	if err != nil || acc != 42 || pack != "pack_small" {
		t.Fatalf("verify: %d %s %v", acc, pack, err)
	}
	tampered := strings.Replace(ref, "42.", "43.", 1)
	if _, _, _, err := VerifyReference(key, tampered); !errors.Is(err, ErrSignature) {
		t.Fatalf("tampered account accepted: %v", err)
	}
	if _, _, _, err := VerifyReference([]byte("other"), ref); !errors.Is(err, ErrSignature) {
		t.Fatal("other key accepted")
	}
	for _, bad := range []string{"", "a.b.c", "0.p.n.m", "x.p.n.m"} {
		if _, _, _, err := VerifyReference(key, bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestFakeWebhook(t *testing.T) {
	f, err := NewFake(EnvTest, "secret")
	if err != nil {
		t.Fatal(err)
	}
	co, err := f.CreateCheckout(context.Background(), Pack{ID: "pack_small", Price: 1990, Currency: "CLP"}, 7, "k")
	if err != nil || !strings.HasPrefix(co.URL, FakeCheckoutPath) {
		t.Fatalf("checkout: %+v %v", co, err)
	}
	r, err := f.Notification("/api/payments/webhook/fake", FakeNotification{Type: Paid, Reference: co.SessionID, AmountMinor: 1990, Currency: "CLP"})
	if err != nil {
		t.Fatal(err)
	}
	ev, err := f.ParseWebhook(r)
	if err != nil || ev.AccountID != 7 || ev.PackID != "pack_small" || ev.Type != Paid || ev.AmountMinor != 1990 ||
		ev.ID != ev.PaymentID+":paid" {
		t.Fatalf("event: %+v %v", ev, err)
	}
	// Same payment refunded: same payment id, another event id.
	r, _ = f.Notification("/", FakeNotification{Type: Refunded, Reference: co.SessionID})
	ev2, err := f.ParseWebhook(r)
	if err != nil || ev2.PaymentID != ev.PaymentID || ev2.ID == ev.ID {
		t.Fatalf("refund: %+v %v", ev2, err)
	}
	// A wrong signature.
	r, _ = f.Notification("/", FakeNotification{Type: Paid, Reference: co.SessionID})
	r.Header.Set(FakeSignatureHeader, strings.Repeat("0", 64))
	if _, err := f.ParseWebhook(r); !errors.Is(err, ErrSignature) {
		t.Fatalf("bad signature: %v", err)
	}
	// Signed by another fake (another secret).
	g, _ := NewFake(EnvTest, "other")
	r, _ = g.Notification("/", FakeNotification{Type: Paid, Reference: co.SessionID})
	if _, err := f.ParseWebhook(r); !errors.Is(err, ErrSignature) {
		t.Fatalf("other secret: %v", err)
	}
}

// mpServer is a fake Mercado Pago API: preferences and payments.
type mpServer struct {
	*httptest.Server
	prefs    []mpPreference
	idemKeys []string
	payments map[string]map[string]any
	auth     []string
	// status, when set, is the answer of every GET /v1/payments/<id>.
	status int
}

func newMPServer(t *testing.T) *mpServer {
	s := &mpServer{payments: map[string]map[string]any{}}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.auth = append(s.auth, r.Header.Get("Authorization"))
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/checkout/preferences":
			var p mpPreference
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &p); err != nil {
				http.Error(w, "bad", http.StatusBadRequest)
				return
			}
			s.prefs = append(s.prefs, p)
			s.idemKeys = append(s.idemKeys, r.Header.Get("X-Idempotency-Key"))
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "pref-1",
				"init_point":         "https://www.mercadopago.cl/checkout/v1/redirect?pref_id=pref-1",
				"sandbox_init_point": "https://sandbox.mercadopago.cl/checkout/v1/redirect?pref_id=pref-1"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/payments/"):
			if s.status != 0 {
				http.Error(w, "status", s.status)
				return
			}
			p, ok := s.payments[strings.TrimPrefix(r.URL.Path, "/v1/payments/")]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(p)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func newMP(t *testing.T, s *mpServer, now time.Time) *MercadoPago {
	m, err := NewMercadoPago(MercadoPagoConfig{AccessToken: "TEST-token", WebhookSecret: "whsec", RefSecret: "refsec",
		RefSecretPrevious: "oldref", PublicURL: "https://game.test/",
		BaseURL: s.URL, Client: s.Client(), Clock: clock.NewFake(now)})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestMercadoPagoCheckout(t *testing.T) {
	s := newMPServer(t)
	m := newMP(t, s, t0)
	co, err := m.CreateCheckout(context.Background(), Pack{ID: "pack_small", Price: 1990, Currency: "CLP", Title: "100"}, 9, "idem-1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(co.URL, "https://sandbox.") || co.SessionID != "pref-1" {
		t.Fatalf("checkout: %+v", co)
	}
	p := s.prefs[0]
	if p.Items[0].UnitPrice != 1990 || p.Items[0].CurrencyID != "CLP" || p.Items[0].Quantity != 1 {
		t.Fatalf("item: %+v", p.Items[0])
	}
	if p.NotificationURL != "https://game.test/api/payments/webhook/mercadopago" || p.BackURLs["success"] != "https://game.test/shop?checkout=success" {
		t.Fatalf("urls: %+v", p)
	}
	if acc, pack, _, err := VerifyReference([]byte("refsec"), p.ExternalReference); err != nil || acc != 9 || pack != "pack_small" {
		t.Fatalf("reference: %v", err)
	}
	if _, _, _, err := VerifyReference([]byte("whsec"), p.ExternalReference); err == nil {
		t.Fatal("reference signed with the webhook secret")
	}
	if s.idemKeys[0] != "idem-1" || s.auth[0] != "Bearer TEST-token" {
		t.Fatalf("headers: %v %v", s.idemKeys, s.auth)
	}
	// Minor units: USD 499 is 4.99.
	if _, err := m.CreateCheckout(context.Background(), Pack{ID: "p", Price: 499, Currency: "USD"}, 9, "k"); err != nil {
		t.Fatal(err)
	}
	if got := s.prefs[1].Items[0].UnitPrice; got != 4.99 {
		t.Fatalf("USD unit price %v", got)
	}
	if _, err := m.CreateCheckout(context.Background(), Pack{ID: "p", Price: 1, Currency: "XXX"}, 9, "k"); err == nil {
		t.Fatal("unknown currency accepted")
	}
}

func notification(t *testing.T, sig, requestID, dataID string) *http.Request {
	t.Helper()
	body := `{"action":"payment.updated","type":"payment","data":{"id":"` + dataID + `"}}`
	r := httptest.NewRequest(http.MethodPost, "/api/payments/webhook/mercadopago?data.id="+dataID+"&type=payment", strings.NewReader(body))
	if sig != "" {
		r.Header.Set("x-signature", sig)
	}
	r.Header.Set("x-request-id", requestID)
	return r
}

func TestMercadoPagoWebhook(t *testing.T) {
	s := newMPServer(t)
	m := newMP(t, s, t0)
	ref, _ := SignReference([]byte("refsec"), 9, "pack_small")
	s.payments["123"] = map[string]any{"id": 123, "status": "approved", "external_reference": ref,
		"transaction_amount": 1990, "currency_id": "CLP"}
	sig := MercadoPagoSignature("whsec", "123", "req-1", t0.Unix())

	ev, err := m.ParseWebhook(notification(t, sig, "req-1", "123"))
	if err != nil {
		t.Fatal(err)
	}
	want := Event{ID: "123:paid", Type: Paid, PaymentID: "123", AccountID: 9, PackID: "pack_small", AmountMinor: 1990, Currency: "CLP"}
	if ev != want {
		t.Fatalf("event %+v, want %+v", ev, want)
	}

	cases := map[string]*http.Request{
		"no signature":       notification(t, "", "req-1", "123"),
		"wrong secret":       notification(t, MercadoPagoSignature("other", "123", "req-1", t0.Unix()), "req-1", "123"),
		"other request id":   notification(t, sig, "req-2", "123"),
		"other payment":      notification(t, sig, "req-1", "124"),
		"stale":              notification(t, MercadoPagoSignature("whsec", "123", "req-1", t0.Add(-MaxWebhookAge-time.Second).Unix()), "req-1", "123"),
		"future":             notification(t, MercadoPagoSignature("whsec", "123", "req-1", t0.Add(MaxWebhookAge+time.Minute).Unix()), "req-1", "123"),
		"garbage":            notification(t, "ts=abc,v1=zz", "req-1", "123"),
		"truncated v1":       notification(t, sig[:len(sig)-2], "req-1", "123"),
		"signature only v1=": notification(t, "v1=00", "req-1", "123"),
	}
	for name, r := range cases {
		if _, err := m.ParseWebhook(r); !errors.Is(err, ErrSignature) {
			t.Errorf("%s: %v", name, err)
		}
	}

	// Status mapping, read from the API (never from the notification).
	for status, typ := range map[string]EventType{"refunded": Refunded, "charged_back": Chargeback} {
		s.payments["123"]["status"] = status
		ev, err := m.ParseWebhook(notification(t, sig, "req-1", "123"))
		if err != nil || ev.Type != typ || ev.ID != "123:"+string(typ) {
			t.Errorf("%s: %+v %v", status, ev, err)
		}
	}
	for _, status := range []string{"pending", "in_process", "rejected", "cancelled"} {
		s.payments["123"]["status"] = status
		if _, err := m.ParseWebhook(notification(t, sig, "req-1", "123")); !errors.Is(err, ErrIgnored) {
			t.Errorf("%s: %v", status, err)
		}
	}
	// Partially refunded (still approved): a refund event per new refunded total.
	s.payments["123"]["status"] = "approved"
	s.payments["123"]["transaction_amount_refunded"] = 500
	ev, err = m.ParseWebhook(notification(t, sig, "req-1", "123"))
	if err != nil || ev.Type != Refunded || ev.RefundedMinor != 500 || ev.ID != "123:refunded:500" || ev.AmountMinor != 1990 {
		t.Fatalf("partial refund: %+v %v", ev, err)
	}
	// A refunded amount that rounds to nothing, or a negative one, is no refund.
	for _, v := range []float64{0.2, -5} {
		s.payments["123"]["transaction_amount_refunded"] = v
		if ev, err := m.ParseWebhook(notification(t, sig, "req-1", "123")); err != nil || ev.Type != Paid || ev.RefundedMinor != 0 {
			t.Fatalf("refunded %v: %+v %v", v, ev, err)
		}
	}
	delete(s.payments["123"], "transaction_amount_refunded")
	// In mediation: a dispute.
	s.payments["123"]["status"] = "in_mediation"
	if ev, err := m.ParseWebhook(notification(t, sig, "req-1", "123")); err != nil || ev.Type != Dispute || ev.ID != "123:dispute" {
		t.Fatalf("in_mediation: %+v %v", ev, err)
	}
	// A reference signed with the previous secret still verifies (rotation).
	s.payments["123"]["status"] = "approved"
	old, _ := SignReference([]byte("oldref"), 9, "pack_small")
	s.payments["123"]["external_reference"] = old
	if ev, err := m.ParseWebhook(notification(t, sig, "req-1", "123")); err != nil || ev.AccountID != 9 {
		t.Fatalf("previous ref secret: %+v %v", ev, err)
	}
	// An approved payment that cannot be credited: unmatched, with what is known.
	for _, bad := range []string{"someone-else", func() string { r, _ := SignReference([]byte("whsec"), 9, "pack_small"); return r }()} {
		s.payments["123"]["external_reference"] = bad
		ev, err := m.ParseWebhook(notification(t, sig, "req-1", "123"))
		if !errors.Is(err, ErrUnmatched) || ev.Unmatched != UnmatchedReference || ev.PaymentID != "123" ||
			ev.ID != "123:unmatched" || ev.AmountMinor != 1990 {
			t.Errorf("foreign reference %q: %+v %v", bad, ev, err)
		}
	}
	s.payments["123"]["external_reference"] = ref
	s.payments["123"]["currency_id"] = "XXX"
	if ev, err := m.ParseWebhook(notification(t, sig, "req-1", "123")); !errors.Is(err, ErrUnmatched) ||
		ev.Unmatched != UnmatchedCurrency || ev.AccountID != 9 {
		t.Errorf("unknown currency: %+v %v", ev, err)
	}
	// A refund of a payment that is not ours: ignored (no money to reconcile).
	s.payments["123"]["status"] = "refunded"
	if _, err := m.ParseWebhook(notification(t, sig, "req-1", "123")); !errors.Is(err, ErrIgnored) {
		t.Errorf("foreign refund: %v", err)
	}
	s.payments["123"]["currency_id"] = "CLP"
	s.payments["123"]["status"] = "approved"
	// Another topic, validly signed.
	r := httptest.NewRequest(http.MethodPost, "/?data.id=55&type=merchant_order", strings.NewReader("{}"))
	r.Header.Set("x-signature", MercadoPagoSignature("whsec", "55", "req-9", t0.Unix()))
	r.Header.Set("x-request-id", "req-9")
	if _, err := m.ParseWebhook(r); !errors.Is(err, ErrIgnored) {
		t.Errorf("merchant_order: %v", err)
	}
	// The API is down or throttling: an error the webhook answers with a retryable status.
	for _, code := range []int{http.StatusInternalServerError, http.StatusBadGateway, http.StatusTooManyRequests,
		http.StatusUnauthorized, http.StatusForbidden} {
		s.status = code
		if _, err := m.ParseWebhook(notification(t, sig, "req-1", "123")); !errors.Is(err, ErrProvider) || errors.Is(err, ErrIgnored) {
			t.Errorf("status %d: %v", code, err)
		}
	}
	// A 404 or 400 will not change by retrying: ignored (with the detail for a warning).
	// 401/403 (a wrong or revoked access token) are retried above: never drop a payment.
	for _, code := range []int{http.StatusNotFound, http.StatusBadRequest} {
		s.status = code
		if _, err := m.ParseWebhook(notification(t, sig, "req-1", "123")); !errors.Is(err, ErrIgnored) || err.Error() == ErrIgnored.Error() {
			t.Errorf("status %d: %v", code, err)
		}
	}
}

func TestMercadoPagoSignatureMilliseconds(t *testing.T) {
	s := newMPServer(t)
	m := newMP(t, s, t0)
	ms := t0.UnixMilli()
	manifest := "id:123;request-id:r;ts:" + itoa(ms) + ";"
	sig := "ts=" + itoa(ms) + ",v1=" + hmacHex([]byte("whsec"), manifest)
	if err := m.verifySignature(sig, "r", "123"); err != nil {
		t.Fatal(err)
	}
	// Alphanumeric ids are lowercased in the manifest.
	sig = MercadoPagoSignature("whsec", "ABC", "r", t0.Unix())
	if err := m.verifySignature(sig, "r", "ABC"); err != nil {
		t.Fatal(err)
	}
}

func itoa(v int64) string { return strconv.FormatInt(v, 10) }
