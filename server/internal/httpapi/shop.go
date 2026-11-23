package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/payments"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// Cosmetic shop (T5.7, docs/05 "API HTTP", docs/01 "Pagos"). Every balance change is one
// database transaction of the store; the game hears of it through Shop.Changed (the
// handler never touches the world).

// ShopStore is the persistence of the shop. *store.Store implements it.
type ShopStore interface {
	ShopState(ctx context.Context, accountID int64, now time.Time) (store.ShopState, error)
	BuyCosmetic(ctx context.Context, accountID int64, id string, now time.Time) (store.Purchase, error)
	ApplyPayment(ctx context.Context, e store.PaymentEvent) (store.PaymentResult, error)
	PremiumBoughtSince(ctx context.Context, accountID int64, since time.Time) (int64, error)
	RecordUnmatchedPayment(ctx context.Context, e store.PaymentEvent, reason string) (string, error)
}

var _ ShopStore = (*store.Store)(nil)

// Shop configures the shop routes.
type Shop struct {
	Store ShopStore
	// Catalog is data/cosmetics.yaml. Required.
	Catalog *content.CosmeticShop
	// Provider is the payment provider; nil turns the shop off (GET says enabled: false,
	// every POST answers 503 shop_disabled, the webhook 404).
	Provider payments.Provider
	// Changed is told the account whose balance or cosmetics changed (it must not block):
	// the app pushes CosmeticsState to its online characters.
	Changed func(accountID int64)
	// RateLimit bounds checkouts and purchases per account; default DefaultShopRateLimit.
	RateLimit RateLimit
}

// DefaultShopRateLimit is the checkouts and purchases per account.
var DefaultShopRateLimit = RateLimit{Burst: 10, Every: 6 * time.Second}

// webhookBodyBytes bounds a provider notification.
const webhookBodyBytes = 16 << 10

// shopEnabled: the shop routes exist and a payment provider is configured.
func (a *api) shopEnabled() bool {
	s := a.cfg.Shop
	return s != nil && s.Store != nil && s.Catalog != nil && s.Provider != nil
}

func (a *api) shopRoutes(mux *http.ServeMux) {
	s := a.cfg.Shop
	if s == nil || s.Store == nil || s.Catalog == nil {
		return
	}
	mux.HandleFunc("GET /api/shop", a.authed(a.shopGet))
	mux.HandleFunc("POST /api/shop/checkout", a.authed(a.shopCheckout))
	mux.HandleFunc("POST /api/shop/buy", a.authed(a.shopBuy))
	mux.HandleFunc("POST /api/payments/webhook/{provider}", a.paymentWebhook)
	if _, ok := s.Provider.(*payments.Fake); ok {
		// The fake hosted checkout: a POST with the session of the account that started
		// it pays (development and tests only; the fake provider refuses to start in
		// production).
		mux.HandleFunc("POST "+payments.FakeCheckoutPath+"{session}", a.authed(a.fakeCheckout))
	}
}

type shopPackJSON struct {
	ID       string `json:"id"`
	Amount   int64  `json:"amount"`
	Price    int64  `json:"price"`
	Currency string `json:"currency"`
}

type shopCosmeticJSON struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Price int64  `json:"price"`
	Owned bool   `json:"owned"`
}

type shopHistoryJSON struct {
	At         time.Time `json:"at"`
	Kind       string    `json:"kind"`
	Amount     int64     `json:"amount"`
	CosmeticID string    `json:"cosmetic_id,omitempty"`
	PackID     string    `json:"pack_id,omitempty"`
	// Shortfall: a refund or chargeback that could not be fully debited.
	Shortfall int64 `json:"shortfall,omitempty"`
}

type shopJSON struct {
	Enabled bool  `json:"enabled"`
	Balance int64 `json:"balance"`
	// Blocked: the account cannot buy (disabled, banned or flagged after a refund).
	Blocked bool `json:"blocked"`
	// DailyLimit is data/cosmetics.yaml limits.daily_premium and BoughtToday what the account bought
	// in the last 24 hours (the website can say why a pack is refused).
	DailyLimit  int64              `json:"daily_limit"`
	BoughtToday int64              `json:"bought_today"`
	Packs       []shopPackJSON     `json:"packs"`
	Cosmetics   []shopCosmeticJSON `json:"cosmetics"`
	History     []shopHistoryJSON  `json:"history"`
}

func (a *api) shopGet(w http.ResponseWriter, r *http.Request, accountID int64) {
	s := a.cfg.Shop
	now := a.cfg.Clock.Now()
	st, err := s.Store.ShopState(r.Context(), accountID, now)
	if err != nil {
		a.shopFail(w, r, err)
		return
	}
	bought, err := s.Store.PremiumBoughtSince(r.Context(), accountID, now.Add(-payments.LimitWindow))
	if err != nil {
		a.shopFail(w, r, err)
		return
	}
	owned := make(map[string]bool, len(st.Owned))
	for _, id := range st.Owned {
		owned[id] = true
	}
	out := shopJSON{Enabled: s.Provider != nil, Balance: st.Balance, Blocked: st.Blocked,
		DailyLimit: s.Catalog.Limits.DailyPremium, BoughtToday: bought,
		Packs: []shopPackJSON{}, Cosmetics: []shopCosmeticJSON{}, History: []shopHistoryJSON{}}
	if out.Enabled {
		for _, p := range s.Catalog.Packs {
			out.Packs = append(out.Packs, shopPackJSON{ID: p.ID, Amount: p.Amount, Price: p.Price, Currency: p.Currency})
		}
	}
	for _, c := range s.Catalog.Cosmetics {
		out.Cosmetics = append(out.Cosmetics, shopCosmeticJSON{ID: c.ID, Kind: c.Kind, Price: c.Price, Owned: owned[c.ID]})
	}
	for _, h := range st.History {
		out.History = append(out.History, shopHistoryJSON{At: h.At.UTC(), Kind: h.Reason, Amount: h.Delta,
			CosmeticID: h.CosmeticID, PackID: h.PackID, Shortfall: h.Shortfall})
	}
	writeJSON(w, http.StatusOK, out)
}

// shopOpen answers 503 shop_disabled without a provider and applies the per-account
// rate limit; false means the response was written.
func (a *api) shopOpen(w http.ResponseWriter, accountID int64) bool {
	if a.cfg.Shop.Provider == nil {
		writeError(w, http.StatusServiceUnavailable, "shop_disabled")
		return false
	}
	if ok, _ := a.shopLimiter.allow(strconv.FormatInt(accountID, 10)); !ok {
		a.tooMany(w, a.cfg.Shop.RateLimit)
		return false
	}
	return true
}

type checkoutRequest struct {
	PackID string `json:"pack_id"`
	// Lang is the website's language: the pack's name on the provider's page is in it
	// (i18n/<lang>/cosmetics.yaml; Accept-Language, then Spanish, without it).
	Lang string `json:"lang,omitempty"`
}

// requestLang is lang, or the first language of Accept-Language ("" if none).
func requestLang(lang string, r *http.Request) string {
	if lang != "" {
		return lang
	}
	first, _, _ := strings.Cut(r.Header.Get("Accept-Language"), ",")
	first, _, _ = strings.Cut(strings.TrimSpace(first), ";")
	first, _, _ = strings.Cut(first, "-")
	return strings.ToLower(first)
}

func (a *api) shopCheckout(w http.ResponseWriter, r *http.Request, accountID int64) {
	s := a.cfg.Shop
	if !a.shopOpen(w, accountID) {
		return
	}
	var in checkoutRequest
	if !a.decode(w, r, &in) {
		return
	}
	pack := s.Catalog.Pack(in.PackID)
	if pack == nil {
		writeError(w, http.StatusNotFound, "unknown_pack")
		return
	}
	now := a.cfg.Clock.Now()
	st, err := s.Store.ShopState(r.Context(), accountID, now)
	if err != nil {
		a.shopFail(w, r, err)
		return
	}
	if st.Blocked {
		writeError(w, http.StatusForbidden, "shop_blocked")
		return
	}
	bought, err := s.Store.PremiumBoughtSince(r.Context(), accountID, now.Add(-payments.LimitWindow))
	if err != nil {
		a.shopFail(w, r, err)
		return
	}
	if bought+pack.Amount > s.Catalog.Limits.DailyPremium {
		writeError(w, http.StatusConflict, "daily_limit")
		return
	}
	var key [16]byte
	if _, err := rand.Read(key[:]); err != nil {
		a.shopFail(w, r, err)
		return
	}
	co, err := s.Provider.CreateCheckout(r.Context(), payments.Pack{ID: pack.ID, Price: pack.Price, Currency: pack.Currency,
		Title: s.Catalog.PackName(requestLang(in.Lang, r), pack.ID)}, accountID, hex.EncodeToString(key[:]))
	if err != nil {
		a.log.Error("shop: checkout failed", "provider", s.Provider.Name(), "pack", pack.ID, "err", err)
		writeError(w, http.StatusBadGateway, "provider_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": co.URL})
}

type buyRequest struct {
	CosmeticID string `json:"cosmetic_id"`
}

type buyResponse struct {
	Balance int64    `json:"balance"`
	Owned   []string `json:"owned"`
}

func (a *api) shopBuy(w http.ResponseWriter, r *http.Request, accountID int64) {
	s := a.cfg.Shop
	if !a.shopOpen(w, accountID) {
		return
	}
	var in buyRequest
	if !a.decode(w, r, &in) {
		return
	}
	if s.Catalog.Cosmetic(in.CosmeticID) == nil {
		writeError(w, http.StatusNotFound, "unknown_cosmetic")
		return
	}
	p, err := s.Store.BuyCosmetic(r.Context(), accountID, in.CosmeticID, a.cfg.Clock.Now())
	if err != nil {
		a.shopFail(w, r, err)
		return
	}
	a.shopChanged(accountID)
	writeJSON(w, http.StatusOK, buyResponse{Balance: p.Balance, Owned: p.Owned})
}

func (a *api) shopChanged(accountID int64) {
	if c := a.cfg.Shop.Changed; c != nil {
		c(accountID)
	}
}

func (a *api) shopFail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrInsufficient):
		writeError(w, http.StatusConflict, "insufficient_balance")
	case errors.Is(err, store.ErrOwned):
		writeError(w, http.StatusConflict, "already_owned")
	case errors.Is(err, store.ErrShopBlocked):
		writeError(w, http.StatusForbidden, "shop_blocked")
	case errors.Is(err, store.ErrNotForSale):
		writeError(w, http.StatusNotFound, "unknown_cosmetic")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusUnauthorized, "unauthorized") // the account is gone
	default:
		a.fail(w, r, err)
	}
}

// paymentWebhook is POST /api/payments/webhook/{provider}: the provider's signed
// notification. 401 for a bad signature, 200 once processed (or for a duplicate or a
// notification with nothing to do), 5xx when the provider should retry.
func (a *api) paymentWebhook(w http.ResponseWriter, r *http.Request) {
	s := a.cfg.Shop
	if s.Provider == nil || r.PathValue("provider") != s.Provider.Name() {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, webhookBodyBytes)
	status, result := a.processWebhook(r)
	if status != http.StatusOK {
		writeError(w, status, result)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": result})
}

// processWebhook verifies and applies one notification; it returns the HTTP status and
// the result (or error code).
func (a *api) processWebhook(r *http.Request) (int, string) {
	s := a.cfg.Shop
	prov := s.Provider.Name()
	ev, err := s.Provider.ParseWebhook(r)
	switch {
	case errors.Is(err, payments.ErrSignature):
		a.sampledLog(slog.LevelWarn, "payments: webhook with an invalid signature", "provider", prov)
		return http.StatusUnauthorized, "invalid_signature"
	case errors.Is(err, payments.ErrUnmatched):
		return a.unmatched(r.Context(), ev, ev.Unmatched)
	case errors.Is(err, payments.ErrIgnored):
		if err.Error() != payments.ErrIgnored.Error() {
			// A detail worth a look (a 4xx reading the payment, a foreign refund...).
			a.log.Warn("payments: notification ignored", "provider", prov, "err", err)
		}
		return http.StatusOK, store.PaymentIgnored
	case err != nil:
		a.log.Error("payments: webhook not verified, the provider will retry", "provider", prov, "err", err)
		return http.StatusBadGateway, "provider_error"
	}
	// Only a credit needs the pack (a paid, or a partial refund of a payment never
	// credited): exactly one of our packs at its price, else the store keeps the event
	// as unmatched where it would credit. A reversal always reaches the store: it takes
	// back what the ledger says was credited, even if the pack left the catalog or its
	// price changed since.
	var premium int64
	unmatched := ""
	switch pack := s.Catalog.Pack(ev.PackID); {
	case pack == nil:
		unmatched = store.UnmatchedPack
	case ev.AmountMinor != pack.Price || ev.Currency != pack.Currency:
		unmatched = store.UnmatchedAmount
	default:
		premium = pack.Amount
	}
	res, err := s.Store.ApplyPayment(r.Context(), store.PaymentEvent{Provider: prov, EventID: ev.ID, Type: string(ev.Type),
		PaymentID: ev.PaymentID, AccountID: ev.AccountID, PackID: ev.PackID, AmountMinor: ev.AmountMinor,
		Currency: ev.Currency, RefundedMinor: ev.RefundedMinor, Premium: premium, Unmatched: unmatched,
		At: a.cfg.Clock.Now()})
	if err != nil {
		a.log.Error("payments: webhook not stored, the provider will retry", "provider", prov, "payment", ev.PaymentID, "err", err)
		return http.StatusServiceUnavailable, "unavailable"
	}
	if res.Result == store.PaymentUnmatched {
		a.log.Error("payments: approved payment not credited, reconcile by hand", "provider", prov,
			"payment", ev.PaymentID, "event", ev.ID, "reason", unmatchedReason(unmatched), "account", ev.AccountID,
			"pack", ev.PackID, "amount", ev.AmountMinor, "currency", ev.Currency)
	}
	a.log.Info("payments: webhook", "provider", prov, "event", ev.ID, "account", ev.AccountID, "pack", ev.PackID,
		"result", res.Result, "reversed", res.Reversed, "shortfall", res.Shortfall)
	if res.Shortfall > 0 {
		a.log.Warn("payments: reversal larger than the balance, account flagged", "account", ev.AccountID,
			"payment", ev.PaymentID, "shortfall", res.Shortfall)
	}
	if res.Result == store.PaymentFlagged {
		a.log.Warn("payments: payment in dispute, account flagged for staff", "account", ev.AccountID, "payment", ev.PaymentID)
	}
	if res.Result == store.PaymentCredited || res.Result == store.PaymentDebited {
		a.shopChanged(ev.AccountID)
	}
	return http.StatusOK, res.Result
}

// unmatchedReason is the reason the store used: an empty one means the account is gone.
func unmatchedReason(r string) string {
	if r == "" {
		return store.UnmatchedAccount
	}
	return r
}

// unmatched logs (error level) and stores an approved payment that cannot be credited,
// for staff reconciliation (payment_events result unmatched, event id
// <payment>:unmatched). 200 once stored: a retry would not change anything; 503 if it
// could not be stored (the provider retries).
func (a *api) unmatched(ctx context.Context, ev payments.Event, reason string) (int, string) {
	prov := a.cfg.Shop.Provider.Name()
	a.log.Error("payments: approved payment not credited, reconcile by hand", "provider", prov,
		"payment", ev.PaymentID, "reason", reason, "account", ev.AccountID, "pack", ev.PackID,
		"amount", ev.AmountMinor, "currency", ev.Currency)
	res, err := a.cfg.Shop.Store.RecordUnmatchedPayment(ctx, store.PaymentEvent{Provider: prov, EventID: ev.PaymentID + ":unmatched",
		Type: store.PaymentPaid, PaymentID: ev.PaymentID, AccountID: ev.AccountID, PackID: ev.PackID,
		AmountMinor: ev.AmountMinor, Currency: ev.Currency, RefundedMinor: ev.RefundedMinor, At: a.cfg.Clock.Now()}, reason)
	if err != nil {
		a.log.Error("payments: unmatched payment not stored, the provider will retry", "provider", prov,
			"payment", ev.PaymentID, "err", err)
		return http.StatusServiceUnavailable, "unavailable"
	}
	return http.StatusOK, res
}

// fakeCheckout is the fake provider's hosted checkout: a POST with the session of the
// account that started the checkout pays the session's pack by sending the same webhook
// path a notification signed with the fake secret (the website posts it and then goes
// to /shop?checkout=success). ?status=refunded or chargeback reverses it instead
// (tests). Another account's session answers 404, like an unknown one.
func (a *api) fakeCheckout(w http.ResponseWriter, r *http.Request, accountID int64) {
	fake, _ := a.cfg.Shop.Provider.(*payments.Fake)
	owner, packID, err := fake.SessionPack(r.PathValue("session"))
	pack := a.cfg.Shop.Catalog.Pack(packID)
	if err != nil || pack == nil || owner != accountID {
		writeError(w, http.StatusNotFound, "unknown_session")
		return
	}
	t := payments.Paid
	switch r.URL.Query().Get("status") {
	case "", "paid":
	case "refunded":
		t = payments.Refunded
	case "chargeback":
		t = payments.Chargeback
	default:
		writeError(w, http.StatusBadRequest, "bad_request")
		return
	}
	n, err := fake.Notification("/api/payments/webhook/"+payments.FakeName, payments.FakeNotification{Type: t,
		Reference: r.PathValue("session"), AmountMinor: pack.Price, Currency: pack.Currency})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	status, result := a.processWebhook(n.WithContext(r.Context()))
	if status != http.StatusOK {
		writeError(w, status, result)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": result})
}
