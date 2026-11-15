package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/payments"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// memShop is an in-memory httpapi.ShopStore with the store's rules (idempotent events,
// one credit per payment, no negative balance).
type memShop struct {
	mu      sync.Mutex
	balance map[int64]int64
	owned   map[int64][]string
	bought  map[int64]int64
	events  map[string]bool
	blocked map[int64]bool
	applied []store.PaymentEvent
	// unmatched are the approved payments recorded for reconciliation, by reason.
	unmatched map[string]string
	credited  map[string]int64 // payment id -> premium credited
}

func newMemShop() *memShop {
	return &memShop{balance: map[int64]int64{}, owned: map[int64][]string{}, bought: map[int64]int64{},
		events: map[string]bool{}, blocked: map[int64]bool{}, unmatched: map[string]string{}, credited: map[string]int64{}}
}

func (m *memShop) RecordUnmatchedPayment(_ context.Context, e store.PaymentEvent, reason string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.events[e.Provider+e.EventID] {
		return store.PaymentDuplicate, nil
	}
	m.events[e.Provider+e.EventID] = true
	m.unmatched[e.EventID] = reason
	return store.PaymentUnmatched, nil
}

func (m *memShop) ShopState(_ context.Context, id int64, _ time.Time) (store.ShopState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return store.ShopState{Balance: m.balance[id], Owned: m.owned[id], Blocked: m.blocked[id],
		History: []store.LedgerEntry{{ID: 1, Reason: "grant", Delta: m.balance[id]}}}, nil
}

func (m *memShop) BuyCosmetic(_ context.Context, id int64, cos string, _ time.Time) (store.Purchase, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.blocked[id] {
		return store.Purchase{}, store.ErrShopBlocked
	}
	for _, o := range m.owned[id] {
		if o == cos {
			return store.Purchase{}, store.ErrOwned
		}
	}
	if m.balance[id] < 100 {
		return store.Purchase{}, store.ErrInsufficient
	}
	m.balance[id] -= 100
	m.owned[id] = append(m.owned[id], cos)
	return store.Purchase{Balance: m.balance[id], Owned: m.owned[id]}, nil
}

func (m *memShop) ApplyPayment(_ context.Context, e store.PaymentEvent) (store.PaymentResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.events[e.Provider+e.EventID] {
		return store.PaymentResult{Result: store.PaymentDuplicate}, nil
	}
	m.events[e.Provider+e.EventID] = true
	if e.Unmatched != "" && (e.Type == store.PaymentPaid || e.RefundedMinor > 0) {
		m.unmatched[e.EventID] = e.Unmatched
		return store.PaymentResult{Result: store.PaymentUnmatched}, nil
	}
	m.applied = append(m.applied, e)
	if e.Type == store.PaymentPaid {
		m.balance[e.AccountID] += e.Premium
		m.bought[e.AccountID] += e.Premium
		m.credited[e.PaymentID] = e.Premium
		return store.PaymentResult{Result: store.PaymentCredited, Balance: m.balance[e.AccountID]}, nil
	}
	// A reversal takes back what the payment credited (like the ledger), not the pack.
	m.balance[e.AccountID] = max(m.balance[e.AccountID]-m.credited[e.PaymentID], 0)
	return store.PaymentResult{Result: store.PaymentDebited, Balance: m.balance[e.AccountID]}, nil
}

func (m *memShop) PremiumBoughtSince(_ context.Context, id int64, _ time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.bought[id], nil
}

func catalog(t *testing.T) *content.CosmeticShop {
	t.Helper()
	s := &content.CosmeticShop{
		Packs: []*content.PremiumPack{{ID: "pack_small", Amount: 100, Price: 1990, Currency: "CLP"},
			{ID: "pack_huge", Amount: 5000, Price: 99990, Currency: "CLP"}},
		Cosmetics: []*content.Cosmetic{{ID: "outfit_sailor", Kind: "outfit", Price: 100, Outfit: "sailor"}},
	}
	s.Currency.ID = "premium"
	s.Limits = content.ShopLimits{DailyPremium: 5000, EquipBurst: 5, EquipRefillMs: 500, MaxPremiumGrant: 100000}
	if err := s.Index(); err != nil {
		t.Fatal(err)
	}
	return s
}

type shopHarness struct {
	*harness
	shop    *httpapi.Shop
	store   *memShop
	fake    *payments.Fake
	changed []int64
	mu      sync.Mutex
	token   string
	account int64
}

func newShopHarness(t *testing.T, provider payments.Provider) *shopHarness {
	t.Helper()
	s := &shopHarness{store: newMemShop()}
	s.fake, _ = provider.(*payments.Fake)
	s.harness = newHarness(t, func(c *httpapi.Config) {
		c.Shop = &httpapi.Shop{Store: s.store, Catalog: catalog(t), Provider: provider, Changed: func(id int64) {
			s.mu.Lock()
			s.changed = append(s.changed, id)
			s.mu.Unlock()
		}}
		s.shop = c.Shop
	})
	w := s.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"shop@example.org","password":"hunter2hunter2"}`})
	expect(t, w, http.StatusCreated, "")
	var reg struct {
		AccountID int64 `json:"account_id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &reg)
	s.account = reg.AccountID
	s.token = s.login("shop@example.org", "hunter2hunter2")
	return s
}

func testFake(t *testing.T) *payments.Fake {
	t.Helper()
	f, err := payments.NewFake(payments.EnvTest, "s3cret")
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestShopDisabledWithoutProvider(t *testing.T) {
	s := newShopHarness(t, nil)
	w := s.do(req{method: "GET", path: "/api/shop", token: s.token})
	expect(t, w, http.StatusOK, "")
	var body struct {
		Enabled   bool
		Packs     []any
		Cosmetics []any
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Enabled || len(body.Packs) != 0 || len(body.Cosmetics) != 1 {
		t.Fatalf("body %s", w.Body.String())
	}
	expect(t, s.do(req{method: "POST", path: "/api/shop/checkout", token: s.token, body: `{"pack_id":"pack_small"}`}), http.StatusServiceUnavailable, "shop_disabled")
	expect(t, s.do(req{method: "POST", path: "/api/shop/buy", token: s.token, body: `{"cosmetic_id":"outfit_sailor"}`}), http.StatusServiceUnavailable, "shop_disabled")
	expect(t, s.do(req{method: "POST", path: "/api/payments/webhook/fake", body: `{}`}), http.StatusNotFound, "not_found")
	expect(t, s.do(req{method: "POST", path: "/api/shop/fake-checkout/x", token: s.token}), http.StatusNotFound, "not_found")
	if w := s.do(req{method: "GET", path: "/api/auth/config"}); strings.Contains(w.Body.String(), `"shop"`) {
		t.Fatalf("config without provider %s", w.Body.String())
	}
}

func TestAuthConfigSaysShopEnabled(t *testing.T) {
	s := newShopHarness(t, testFake(t))
	if w := s.do(req{method: "GET", path: "/api/auth/config"}); !strings.Contains(w.Body.String(), `"shop":true`) {
		t.Fatalf("config %s", w.Body.String())
	}
}

func TestShopNeedsSession(t *testing.T) {
	s := newShopHarness(t, testFake(t))
	expect(t, s.do(req{method: "GET", path: "/api/shop"}), http.StatusUnauthorized, "unauthorized")
	expect(t, s.do(req{method: "POST", path: "/api/shop/buy", body: `{"cosmetic_id":"outfit_sailor"}`}), http.StatusUnauthorized, "unauthorized")
	// CSRF: a cross-site form post has no JSON content type.
	expect(t, s.do(req{method: "POST", path: "/api/shop/buy", cookie: s.token, body: `cosmetic_id=outfit_sailor`,
		contentType: "application/x-www-form-urlencoded"}), http.StatusUnsupportedMediaType, "unsupported_media_type")
}

func TestShopFakeCheckoutFlow(t *testing.T) {
	s := newShopHarness(t, testFake(t))
	expect(t, s.do(req{method: "POST", path: "/api/shop/checkout", token: s.token, body: `{"pack_id":"nope"}`}), http.StatusNotFound, "unknown_pack")
	w := s.do(req{method: "POST", path: "/api/shop/checkout", token: s.token, body: `{"pack_id":"pack_small"}`})
	expect(t, w, http.StatusOK, "")
	var co struct{ URL string }
	_ = json.Unmarshal(w.Body.Bytes(), &co)
	if !strings.HasPrefix(co.URL, payments.FakeCheckoutPath) {
		t.Fatalf("url %q", co.URL)
	}
	// The fake checkout pays only with a POST of the account that started it: a GET (a
	// link someone was sent) or no session does nothing.
	if w := s.do(req{method: "GET", path: co.URL, token: s.token}); w.Code == http.StatusOK || w.Code == http.StatusSeeOther {
		t.Fatalf("GET fake checkout %d", w.Code)
	}
	expect(t, s.do(req{method: "POST", path: co.URL}), http.StatusUnauthorized, "unauthorized")
	if len(s.store.applied) != 0 {
		t.Fatal("paid without the session")
	}
	w = s.do(req{method: "POST", path: co.URL, token: s.token})
	expect(t, w, http.StatusOK, "")
	if !strings.Contains(w.Body.String(), store.PaymentCredited) {
		t.Fatalf("fake checkout %s", w.Body.String())
	}
	if s.store.balance[s.account] != 100 || len(s.changed) != 1 || s.changed[0] != s.account {
		t.Fatalf("balance %d changed %v", s.store.balance[s.account], s.changed)
	}
	e := s.store.applied[0]
	if e.Provider != "fake" || e.PackID != "pack_small" || e.Premium != 100 || e.AmountMinor != 1990 || e.Type != store.PaymentPaid {
		t.Fatalf("event %+v", e)
	}
	// Paying again: duplicate, nothing changes and nobody is told.
	w = s.do(req{method: "POST", path: co.URL, token: s.token})
	expect(t, w, http.StatusOK, "")
	if !strings.Contains(w.Body.String(), store.PaymentDuplicate) || s.store.balance[s.account] != 100 || len(s.changed) != 1 {
		t.Fatalf("duplicate %s", w.Body.String())
	}
	expect(t, s.do(req{method: "POST", path: payments.FakeCheckoutPath + "forged.session.x.y", token: s.token}), http.StatusNotFound, "unknown_session")
	// Another account cannot pay (or refund) someone else's session.
	expect(t, s.do(req{method: "POST", path: "/api/auth/register", body: `{"email":"other@example.org","password":"hunter2hunter2"}`}), http.StatusCreated, "")
	other := s.login("other@example.org", "hunter2hunter2")
	expect(t, s.do(req{method: "POST", path: co.URL + "?status=refunded", token: other}), http.StatusNotFound, "unknown_session")
	if len(s.store.applied) != 1 {
		t.Fatalf("another account touched the payment: %+v", s.store.applied)
	}

	w = s.do(req{method: "POST", path: "/api/shop/buy", token: s.token, body: `{"cosmetic_id":"outfit_sailor"}`})
	expect(t, w, http.StatusOK, "")
	if !strings.Contains(w.Body.String(), `"owned":["outfit_sailor"]`) || len(s.changed) != 2 {
		t.Fatalf("buy %s", w.Body.String())
	}
	expect(t, s.do(req{method: "POST", path: "/api/shop/buy", token: s.token, body: `{"cosmetic_id":"outfit_sailor"}`}), http.StatusConflict, "already_owned")
	expect(t, s.do(req{method: "POST", path: "/api/shop/buy", token: s.token, body: `{"cosmetic_id":"nope"}`}), http.StatusNotFound, "unknown_cosmetic")
	s.store.owned[s.account] = nil
	expect(t, s.do(req{method: "POST", path: "/api/shop/buy", token: s.token, body: `{"cosmetic_id":"outfit_sailor"}`}), http.StatusConflict, "insufficient_balance")

	// The daily limit refuses a checkout before the player pays.
	expect(t, s.do(req{method: "POST", path: "/api/shop/checkout", token: s.token, body: `{"pack_id":"pack_huge"}`}), http.StatusConflict, "daily_limit")
	// A blocked account cannot start a checkout.
	s.store.blocked[s.account] = true
	expect(t, s.do(req{method: "POST", path: "/api/shop/checkout", token: s.token, body: `{"pack_id":"pack_small"}`}), http.StatusForbidden, "shop_blocked")
}

func TestShopWebhook(t *testing.T) {
	f := testFake(t)
	s := newShopHarness(t, f)
	co, err := f.CreateCheckout(context.Background(), payments.Pack{ID: "pack_small"}, s.account, "k")
	if err != nil {
		t.Fatal(err)
	}
	send := func(n payments.FakeNotification, mutate func(*http.Request)) *httptest.ResponseRecorder {
		r, err := f.Notification("/api/payments/webhook/fake", n)
		if err != nil {
			t.Fatal(err)
		}
		if mutate != nil {
			mutate(r)
		}
		w := httptest.NewRecorder()
		s.h.ServeHTTP(w, r)
		return w
	}
	ok := payments.FakeNotification{Type: payments.Paid, Reference: co.SessionID, AmountMinor: 1990, Currency: "CLP"}
	expect(t, send(ok, func(r *http.Request) { r.Header.Set(payments.FakeSignatureHeader, "00") }), http.StatusUnauthorized, "invalid_signature")
	if len(s.store.applied) != 0 {
		t.Fatal("unsigned webhook applied")
	}
	// A paid amount that is not the pack's price is not credited: it is stored as
	// unmatched for staff (another checkout: the event id of a payment is used once).
	other, err := f.CreateCheckout(context.Background(), payments.Pack{ID: "pack_small"}, s.account, "k2")
	if err != nil {
		t.Fatal(err)
	}
	bad := ok
	bad.Reference = other.SessionID
	bad.AmountMinor = 1
	w := send(bad, nil)
	if w.Code != http.StatusOK || len(s.store.applied) != 0 || !strings.Contains(w.Body.String(), store.PaymentUnmatched) {
		t.Fatalf("underpaid: %d %s", w.Code, w.Body.String())
	}
	if len(s.store.unmatched) != 1 {
		t.Fatalf("unmatched %v", s.store.unmatched)
	}
	for id, reason := range s.store.unmatched {
		if reason != store.UnmatchedAmount || !strings.HasSuffix(id, ":paid") {
			t.Fatalf("unmatched %s %s", id, reason)
		}
	}
	bad.AmountMinor, bad.Currency = 1990, "USD"
	if w := send(bad, nil); len(s.store.applied) != 0 || !strings.Contains(w.Body.String(), store.PaymentDuplicate) {
		t.Fatalf("other currency: %s", w.Body.String())
	}
	w = send(ok, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), store.PaymentCredited) {
		t.Fatalf("paid %d %s", w.Code, w.Body.String())
	}
	if w = send(ok, nil); !strings.Contains(w.Body.String(), store.PaymentDuplicate) || len(s.store.applied) != 1 {
		t.Fatalf("duplicate %s", w.Body.String())
	}
	w = send(payments.FakeNotification{Type: payments.Chargeback, Reference: co.SessionID}, nil)
	if !strings.Contains(w.Body.String(), store.PaymentDebited) || s.store.balance[s.account] != 0 {
		t.Fatalf("chargeback %s", w.Body.String())
	}
	// Another provider's path.
	expect(t, s.do(req{method: "POST", path: "/api/payments/webhook/mercadopago", body: `{}`}), http.StatusNotFound, "not_found")
}

// stubProvider is a payments.Provider whose webhook returns a fixed event or error, and
// that records the checkouts it is asked for.
type stubProvider struct {
	ev    payments.Event
	err   error
	packs []payments.Pack
}

func (p *stubProvider) Name() string { return "stub" }

func (p *stubProvider) CreateCheckout(_ context.Context, pack payments.Pack, _ int64, _ string) (payments.Checkout, error) {
	p.packs = append(p.packs, pack)
	return payments.Checkout{URL: "https://pay.test/x", SessionID: "x"}, nil
}

func (p *stubProvider) ParseWebhook(*http.Request) (payments.Event, error) { return p.ev, p.err }

func TestShopWebhookUnmatchedAndIgnored(t *testing.T) {
	p := &stubProvider{}
	s := newShopHarness(t, p)
	hook := func() *httptest.ResponseRecorder {
		return s.do(req{method: "POST", path: "/api/payments/webhook/stub", body: `{}`})
	}
	// A bad reference: logged and stored as unmatched, 200 (retrying changes nothing).
	p.ev, p.err = payments.Event{ID: "9:unmatched", Type: payments.Paid, PaymentID: "9", AmountMinor: 1990,
		Currency: "CLP", Unmatched: payments.UnmatchedReference}, payments.ErrUnmatched
	if w := hook(); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), store.PaymentUnmatched) {
		t.Fatalf("unmatched %d %s", w.Code, w.Body.String())
	}
	if s.store.unmatched["9:unmatched"] != store.UnmatchedReference || len(s.store.applied) != 0 {
		t.Fatalf("unmatched rows %v", s.store.unmatched)
	}
	// An unknown pack, paid.
	p.ev, p.err = payments.Event{ID: "10:paid", Type: payments.Paid, PaymentID: "10", AccountID: s.account,
		PackID: "pack_gone", AmountMinor: 1990, Currency: "CLP"}, nil
	if hook(); s.store.unmatched["10:paid"] != store.UnmatchedPack {
		t.Fatalf("unknown pack %v", s.store.unmatched)
	}
	// A partial refund credits what was never credited: its amount is checked too.
	p.ev = payments.Event{ID: "11:refunded:100", Type: payments.Refunded, PaymentID: "11", AccountID: s.account,
		PackID: "pack_small", AmountMinor: 5, Currency: "CLP", RefundedMinor: 100}
	if hook(); s.store.unmatched["11:refunded:100"] != store.UnmatchedAmount {
		t.Fatalf("partial refund with another amount %v", s.store.unmatched)
	}
	// A partial refund and a dispute reach the store with their fields.
	p.ev.AmountMinor, p.ev.RefundedMinor, p.ev.ID = 1990, 200, "11:refunded:200"
	if w := hook(); w.Code != http.StatusOK || len(s.store.applied) != 1 || s.store.applied[0].RefundedMinor != 200 ||
		s.store.applied[0].Type != store.PaymentRefunded {
		t.Fatalf("partial refund %d %+v", w.Code, s.store.applied)
	}
	p.ev = payments.Event{ID: "11:dispute", Type: payments.Dispute, PaymentID: "11", AccountID: s.account, PackID: "pack_small"}
	if hook(); len(s.store.applied) != 2 || s.store.applied[1].Type != store.PaymentDispute {
		t.Fatalf("dispute %+v", s.store.applied)
	}
	// A refund or chargeback of a pack no longer sold (or repriced) still reaches the
	// store, without a premium amount: it takes back what the ledger credited.
	p.ev = payments.Event{ID: "13:refunded", Type: payments.Refunded, PaymentID: "13", AccountID: s.account,
		PackID: "pack_gone", AmountMinor: 777, Currency: "CLP"}
	if hook(); len(s.store.applied) != 3 || s.store.applied[2].Premium != 0 || s.store.applied[2].Unmatched != store.UnmatchedPack {
		t.Fatalf("reversal of a removed pack %+v", s.store.applied)
	}
	p.ev = payments.Event{ID: "14:chargeback", Type: payments.Chargeback, PaymentID: "14", AccountID: s.account,
		PackID: "pack_small", AmountMinor: 999, Currency: "CLP"}
	if hook(); len(s.store.applied) != 4 || s.store.applied[3].Type != store.PaymentChargeback {
		t.Fatalf("chargeback of a repriced pack %+v", s.store.applied)
	}
	// An ignored notification (a 4xx reading the payment) is 200, so the provider stops.
	p.ev, p.err = payments.Event{}, fmt.Errorf("%w: payment 12: status 404", payments.ErrIgnored)
	if w := hook(); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), store.PaymentIgnored) {
		t.Fatalf("ignored %d %s", w.Code, w.Body.String())
	}
	// A provider error is retried (5xx).
	p.err = fmt.Errorf("%w: status 500", payments.ErrProvider)
	if w := hook(); w.Code != http.StatusBadGateway {
		t.Fatalf("provider error %d", w.Code)
	}
}

func TestShopCheckoutTitleIsTranslated(t *testing.T) {
	p := &stubProvider{}
	s := newShopHarness(t, p)
	cat := s.shop.Catalog
	dir := t.TempDir()
	for lang, names := range map[string]string{"es": "Puñado", "en": "Handful"} {
		if err := os.MkdirAll(filepath.Join(dir, lang), 0o700); err != nil {
			t.Fatal(err)
		}
		body := "cosmetic_pack.pack_small.name: " + names + "\ncosmetic_pack.pack_huge.name: x\n"
		if err := os.WriteFile(filepath.Join(dir, lang, "cosmetics.yaml"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := cat.LoadTexts(dir); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ body, accept, lang string }{
		{`{"pack_id":"pack_small","lang":"en"}`, "", "en"},
		{`{"pack_id":"pack_small"}`, "en-US,en;q=0.9", "en"},
		{`{"pack_id":"pack_small"}`, "", "es"},
		{`{"pack_id":"pack_small","lang":"fr"}`, "", "es"},
	} {
		p.packs = nil
		w := s.do(req{method: "POST", path: "/api/shop/checkout", token: s.token, body: tc.body, header: map[string]string{"Accept-Language": tc.accept}})
		expect(t, w, http.StatusOK, "")
		if want := cat.PackName(tc.lang, "pack_small"); len(p.packs) != 1 || p.packs[0].Title != want || want == "pack_small" {
			t.Errorf("%s %q: title %+v, want %q", tc.body, tc.accept, p.packs, want)
		}
	}
}
