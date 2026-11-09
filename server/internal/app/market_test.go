package app

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// The loop's market changes and the store's are the same numbers (T5.3).
func TestMarketOpsMatch(t *testing.T) {
	pairs := map[session.MarketOpKind]store.MarketOpKind{
		session.MarketOfferAdd: store.MarketOfferAdd, session.MarketOfferFill: store.MarketOfferFill,
		session.MarketOfferRemove: store.MarketOfferRemove, session.MarketMailAdd: store.MarketMailAdd,
		session.MarketMailRemove: store.MarketMailRemove, session.MarketGoldAdd: store.MarketGoldAdd,
		session.MarketHistoryAdd: store.MarketHistoryAdd,
	}
	for s, st := range pairs {
		if uint8(s) != uint8(st) {
			t.Errorf("session %d != store %d", s, st)
		}
	}
	if side(true) != store.MarketSell || side(false) != store.MarketBuy {
		t.Error("sides")
	}
}
