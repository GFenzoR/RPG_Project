package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/content"
	"github.com/GFenzoR/RPG_Project/server/internal/session"
	"github.com/GFenzoR/RPG_Project/server/internal/store"
)

// MarketStore is the persistence of the global market and the trade window (T5.3).
// *store.Store implements it; without it both are off.
type MarketStore interface {
	LoadMarket(ctx context.Context, now time.Time, historyDays, perCharacter, salesDays int) (store.MarketData, error)
	SaveTransfer(ctx context.Context, t store.Transfer) error
}

// marketLoadTimeout bounds the read of the market at start; marketHistoryDays is how far
// back the history shown in the window goes after a restart.
const (
	marketLoadTimeout = 30 * time.Second
	marketHistoryDays = 60
)

func loadMarket(ms MarketStore, now time.Time, cfg content.Market) (*session.MarketData, error) {
	ctx, cancel := context.WithTimeout(context.Background(), marketLoadTimeout)
	defer cancel()
	d, err := ms.LoadMarket(ctx, now, marketHistoryDays, cfg.HistorySize, cfg.ReferenceDays)
	if err != nil {
		return nil, fmt.Errorf("load market: %w", err)
	}
	out := &session.MarketData{Gold: d.Gold, Bans: d.Bans, OfferHigh: d.OfferHigh, MailHigh: d.MailHigh}
	for _, o := range d.Offers {
		out.Offers = append(out.Offers, session.MarketOffer{ID: o.ID, CharacterID: o.CharacterID, AccountID: o.AccountID,
			Name: o.Name, Sell: o.Side == store.MarketSell, ItemID: uint16(o.ItemID), Amount: o.Amount, Price: o.Price,
			Created: o.Created, Expires: o.Expires})
	}
	for _, m := range d.Mail {
		out.Mail = append(out.Mail, session.MarketMail{ID: m.ID, CharacterID: m.CharacterID, Item: sessionItem(m.Item),
			Created: m.Created})
	}
	for _, h := range d.History {
		out.History = append(out.History, session.MarketHistory{CharacterID: h.CharacterID, Other: h.Other,
			Sold: h.Side == store.MarketSell, ItemID: uint16(h.ItemID), Amount: h.Amount, Price: h.Price, At: h.At})
	}
	for _, x := range d.Sales {
		out.Sales = append(out.Sales, session.MarketSale{ItemID: uint16(x.ItemID), Day: x.Day, Units: x.Units, Total: x.Total})
	}
	return out, nil
}

func sessionItem(it store.InventoryItem) session.ItemState {
	s := session.ItemState{ItemID: uint16(it.ItemID), Count: it.Count, Slot: it.Slot}
	for _, c := range it.Items {
		s.Items = append(s.Items, sessionItem(c))
	}
	return s
}

func side(sell bool) int {
	if sell {
		return store.MarketSell
	}
	return store.MarketBuy
}

// writeTransfer writes a trade or market change: the snapshots and the market rows in one
// transaction (store.SaveTransfer).
func (a *App) writeTransfer(ctx context.Context, t session.Transfer) error {
	ms, ok := a.cfg.Store.(MarketStore)
	if !ok {
		return fmt.Errorf("%w: the store has no transfers", session.ErrPermanent)
	}
	st := store.Transfer{OfferHigh: t.OfferHigh, MailHigh: t.MailHigh}
	for _, s := range t.Snapshots {
		st.Characters = append(st.Characters, a.characterState(s))
	}
	for _, op := range t.Market {
		o := store.MarketOp{Kind: store.MarketOpKind(op.Kind), ID: op.ID, CharacterID: op.CharacterID, Units: op.Units,
			Gold: op.Gold}
		switch op.Kind {
		case session.MarketOfferAdd:
			x := op.Offer
			o.Offer = store.MarketOffer{ID: x.ID, CharacterID: x.CharacterID, Side: side(x.Sell), ItemID: int(x.ItemID),
				Amount: x.Amount, Price: x.Price, Created: x.Created, Expires: x.Expires}
		case session.MarketMailAdd:
			m := op.Mail
			items := storeItems([]session.ItemState{m.Item})
			o.Mail = store.MarketMail{ID: m.ID, CharacterID: m.CharacterID, Item: items[0], Created: m.Created}
		case session.MarketHistoryAdd:
			h := op.History
			o.History = store.MarketHistory{CharacterID: h.CharacterID, Other: h.Other, Side: side(h.Sold),
				ItemID: int(h.ItemID), Amount: h.Amount, Price: h.Price, At: h.At}
		}
		st.Market = append(st.Market, o)
	}
	err := ms.SaveTransfer(ctx, st)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return fmt.Errorf("%w: %w", session.ErrPermanent, err) // a character is gone: never retried
	case store.Permanent(err):
		return fmt.Errorf("%w: %w", session.ErrPermanent, err)
	}
	return err
}
