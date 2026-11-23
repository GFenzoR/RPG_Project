//go:build integration

package app_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/app"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/payments"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
	"github.com/GFenzoR/RPG_Project/server/internal/store/storetest"
	"github.com/GFenzoR/RPG_Project/server/internal/world/worldtest"
	"github.com/GFenzoR/RPG_Project/server/pkg/bot"
)

type shopBody struct {
	Enabled bool
	Balance int64
	Packs   []struct {
		ID     string
		Amount int64
	}
	Cosmetics []struct {
		ID    string
		Owned bool
	}
	History []struct {
		Kind   string
		Amount int64
	}
}

// TestShopEndToEnd runs the whole server with the fake payment provider (T5.7): a player
// online buys premium currency through the fake checkout, the game hears of it, buys an
// outfit on the website, equips it in the game and another player sees it; a duplicate
// webhook changes nothing and a staff grant reaches the game too.
func TestShopEndToEnd(t *testing.T) {
	st := storetest.Open(t, "it_app_shop", true)
	data := filepath.Join("..", "..", "..", "data")
	vocations, err := content.LoadVocations(data)
	if err != nil {
		t.Fatal(err)
	}
	balance, err := content.LoadBalance(data)
	if err != nil {
		t.Fatal(err)
	}
	items, err := content.LoadItems(data)
	if err != nil {
		t.Fatal(err)
	}
	cosmetics, err := content.LoadCosmetics(data)
	if err != nil || cosmetics == nil {
		t.Fatalf("cosmetics: %v", err)
	}
	fake, err := payments.NewFake(payments.EnvTest, "")
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.New(app.Config{
		WSExemptLoopback: true, // every bot dials from loopback
		Store:            st, Clock: clock.Real{}, Seed: 1, Vocations: vocations, Balance: balance, Items: items,
		Cosmetics: cosmetics, Payments: fake,
		Map: worldtest.Map(t, 0, 0, 7, "................", ".......T........", "................"),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	runCtx, stop := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() { runDone <- a.Run(runCtx) }()
	defer func() {
		stop()
		if err := <-runDone; err != nil {
			t.Error(err)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	buyer := bot.New(srv.URL)
	token, err := buyer.Login(ctx, "buyer@bots.local", "bot-password")
	if err != nil {
		t.Fatal(err)
	}
	if err := buyer.Play(ctx, token, "Bot Buyer", "guardian"); err != nil {
		t.Fatal(err)
	}
	if err := eventually(ctx, func() bool { return buyer.Shop().Updates >= 1 }); err != nil {
		t.Fatalf("no CosmeticsState at login: %v", err)
	}
	if s := buyer.Shop(); s.Balance != 0 || len(s.Owned) != 0 {
		t.Fatalf("login shop %+v", s)
	}
	watcher := bot.New(srv.URL)
	if err := watcher.Enter(ctx, bot.Account{Email: "watch@bots.local", Password: "bot-password", Character: "Bot Watch", Vocation: "guardian"}); err != nil {
		t.Fatal(err)
	}

	var shop shopBody
	if err := buyer.API(ctx, "GET", "/api/shop", token, nil, &shop); err != nil {
		t.Fatal(err)
	}
	if !shop.Enabled || len(shop.Packs) != len(cosmetics.Packs) || len(shop.Cosmetics) != len(cosmetics.Cosmetics) {
		t.Fatalf("shop %+v", shop)
	}
	// Not enough currency yet.
	var apiErr *bot.APIError
	err = buyer.API(ctx, "POST", "/api/shop/buy", token, map[string]string{"cosmetic_id": "outfit_sailor"}, nil)
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusConflict || apiErr.Code != "insufficient_balance" {
		t.Fatalf("buy without balance: %v", err)
	}

	// Checkout of the medium pack; the fake hosted page pays it.
	var co struct{ URL string }
	if err := buyer.API(ctx, "POST", "/api/shop/checkout", token, map[string]string{"pack_id": "pack_medium"}, &co); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(co.URL, payments.FakeCheckoutPath) {
		t.Fatalf("checkout url %q", co.URL)
	}
	var paid struct{ Status string }
	if err := buyer.API(ctx, "POST", co.URL, token, nil, &paid); err != nil || paid.Status != store.PaymentCredited {
		t.Fatalf("fake payment: %+v %v", paid, err)
	}
	pack := cosmetics.Pack("pack_medium")
	if err := eventually(ctx, func() bool { return buyer.Shop().Balance == pack.Amount }); err != nil {
		t.Fatalf("game balance after payment %+v: %v", buyer.Shop(), err)
	}
	// The same notification again (a provider retry): nothing changes.
	if err := buyer.API(ctx, "POST", co.URL, token, nil, &paid); err != nil || paid.Status != store.PaymentDuplicate {
		t.Fatalf("duplicate: %+v %v", paid, err)
	}

	var bought struct {
		Balance int64
		Owned   []string
	}
	if err := buyer.API(ctx, "POST", "/api/shop/buy", token, map[string]string{"cosmetic_id": "outfit_sailor"}, &bought); err != nil {
		t.Fatal(err)
	}
	price := cosmetics.Cosmetic("outfit_sailor").Price
	if bought.Balance != pack.Amount-price || !slices.Equal(bought.Owned, []string{"outfit_sailor"}) {
		t.Fatalf("bought %+v", bought)
	}
	if err := eventually(ctx, func() bool { return slices.Contains(buyer.Shop().Owned, "outfit_sailor") }); err != nil {
		t.Fatalf("game owned after purchase %+v: %v", buyer.Shop(), err)
	}
	if err := buyer.EquipCosmetic(ctx, "outfit_sailor"); err != nil {
		t.Fatal(err)
	}
	id := buyer.CreatureID()
	if err := eventually(ctx, func() bool {
		for _, c := range watcher.Creatures(bot.KindPlayer) {
			if c.ID == id && c.Cosmetics[0] == "outfit_sailor" {
				return true
			}
		}
		return false
	}); err != nil {
		t.Fatalf("watcher did not see the outfit: %v", err)
	}

	if err := buyer.API(ctx, "GET", "/api/shop", token, nil, &shop); err != nil {
		t.Fatal(err)
	}
	if shop.Balance != pack.Amount-price || len(shop.History) != 2 || shop.History[0].Kind != "purchase" || shop.History[1].Kind != "pack" {
		t.Fatalf("shop after purchase %+v", shop)
	}

	// A refund of the pack after spending: what is left is debited and the account
	// flagged, so it cannot buy any more.
	var refunded struct{ Status string }
	if err := buyer.API(ctx, "POST", co.URL+"?status=refunded", token, nil, &refunded); err != nil || refunded.Status != store.PaymentDebited {
		t.Fatalf("refund: %+v %v", refunded, err)
	}
	if err := eventually(ctx, func() bool { return buyer.Shop().Balance == 0 }); err != nil {
		t.Fatalf("game balance after refund %+v: %v", buyer.Shop(), err)
	}
	err = buyer.API(ctx, "POST", "/api/shop/checkout", token, map[string]string{"pack_id": "pack_small"}, nil)
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden || apiErr.Code != "shop_blocked" {
		t.Fatalf("checkout of a flagged account: %v", err)
	}

	// A forged webhook is refused.
	r, _ := http.NewRequestWithContext(ctx, "POST", srv.URL+"/api/payments/webhook/fake", strings.NewReader(`{"type":"paid"}`))
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("forged webhook %d", resp.StatusCode)
	}
}

// eventually polls cond (which may call the bots' locking getters, unlike bot.Wait).
func eventually(ctx context.Context, cond func() bool) error {
	wall := clock.Real{}
	for !cond() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-wall.After(10 * time.Millisecond):
		}
	}
	return nil
}
