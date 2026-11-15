package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/httpapi"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// ShopStore is the persistence of the cosmetic shop (T5.7). *store.Store implements it;
// without it (fake stores of tests) the shop is off.
type ShopStore interface {
	httpapi.ShopStore
	SyncCosmetics(ctx context.Context, rows []store.CosmeticRow) error
	GrantPremium(ctx context.Context, g store.PremiumGrant) (store.GrantResult, error)
	PremiumHistory(ctx context.Context, name string, n int, audit store.AuditEntry) (store.GrantResult, []store.LedgerEntry, error)
}

var _ ShopStore = (*store.Store)(nil)

// shopSyncTimeout bounds the catalog sync at start; shopReadTimeout the read of an
// account's shop state after a change.
const (
	shopSyncTimeout = 30 * time.Second
	shopReadTimeout = 10 * time.Second
)

// shopConfig syncs the catalog to the database and returns the API's shop (nil: off).
func (a *App) shopConfig() (*httpapi.Shop, error) {
	cfg := a.cfg
	ss, ok := cfg.Store.(ShopStore)
	if cfg.Cosmetics == nil || !ok {
		if cfg.Payments != nil {
			return nil, errors.New("app: a payment provider needs data/cosmetics.yaml and a Postgres store")
		}
		return nil, nil
	}
	rows := make([]store.CosmeticRow, 0, len(cfg.Cosmetics.Cosmetics))
	for _, c := range cfg.Cosmetics.Cosmetics {
		rows = append(rows, store.CosmeticRow{ID: c.ID, Kind: c.Kind, Price: c.Price})
	}
	ctx, cancel := context.WithTimeout(context.Background(), shopSyncTimeout)
	defer cancel()
	if err := ss.SyncCosmetics(ctx, rows); err != nil {
		return nil, fmt.Errorf("sync cosmetics: %w", err)
	}
	return &httpapi.Shop{Store: ss, Catalog: cfg.Cosmetics, Provider: cfg.Payments, Changed: a.shopChanged}, nil
}

// shopChanged reads the account's shop state again and hands it to the loop, which
// sends CosmeticsState to its online characters (T5.7). It runs in its own goroutine:
// the HTTP handler or webhook that changed the balance does not wait. A lost read only
// delays the update to the next login; a full queue is retried like a ban.
func (a *App) shopChanged(accountID int64) {
	ss, ok := a.cfg.Store.(ShopStore)
	if a.World == nil || !ok {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), shopReadTimeout)
		st, err := ss.ShopState(ctx, accountID, a.cfg.Clock.Now())
		cancel()
		if err != nil {
			a.log.Warn("shop: state not pushed to the game", "account", accountID, "err", err)
			return
		}
		u := session.ShopUpdate{AccountID: accountID, Owned: st.Owned, Balance: st.Balance}
		if len(st.History) > 0 {
			u.Seq = st.History[0].ID
		}
		a.enqueueRetry(a.World.CosmeticsChanged(u))
	}()
}
