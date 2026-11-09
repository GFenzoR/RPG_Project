package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Global market and trade window (T5.3, docs/01 "Transacciones"). The game loop owns the
// market: LoadMarket reads it once at start, and SaveTransfer writes each change the loop
// decided together with the snapshots of the characters it touched, in ONE transaction,
// from the persistence goroutine (in order with the autosaves).

// ErrMarketConflict reports a market change the database cannot apply (an offer or
// mail item that is not there, or a fill of more units than are left). The whole
// transfer is rolled back: it is permanent (a bug, or a second write of the same
// change), never a partial write.
var ErrMarketConflict = errors.New("store: market change conflicts with the database")

// MarketOpKind is the kind of a MarketOp (same values as session.MarketOpKind).
type MarketOpKind uint8

// Market changes.
const (
	MarketOfferAdd MarketOpKind = iota + 1
	MarketOfferFill
	MarketOfferRemove
	MarketMailAdd
	MarketMailRemove
	MarketGoldAdd
	MarketHistoryAdd
)

// Market offer sides (market_offers.side, market_history.side).
const (
	MarketSell = 1
	MarketBuy  = 2
)

// MarketOffer is a row of market_offers (Name and AccountID: the owner's, on load).
type MarketOffer struct {
	ID, CharacterID, AccountID int64
	Name                       string
	Side                       int
	ItemID, Amount             int
	Price                      int64
	Created, Expires           time.Time
}

// MarketMail is a row of market_mail_items: Item is the instance (InventoryItem).
type MarketMail struct {
	ID, CharacterID int64
	Item            InventoryItem
	Created         time.Time
}

// MarketHistory is a row of market_history.
type MarketHistory struct {
	CharacterID, Other int64
	Side               int
	ItemID, Amount     int
	Price              int64
	At                 time.Time
}

// MarketSale is the sales of one item on one day.
type MarketSale struct {
	ItemID       int
	Day          time.Time
	Units, Total int64
}

// MarketData is the whole market as loaded at start.
type MarketData struct {
	Offers              []MarketOffer
	Mail                []MarketMail
	Gold                map[int64]int64
	History             []MarketHistory
	Sales               []MarketSale
	Bans                map[int64]time.Time // zero: permanent
	OfferHigh, MailHigh int64
}

// MarketOp is one market change of a Transfer.
type MarketOp struct {
	Kind        MarketOpKind
	ID          int64
	CharacterID int64
	Units       int
	Gold        int64
	Offer       MarketOffer
	Mail        MarketMail
	History     MarketHistory
}

// Transfer is what SaveTransfer writes in one transaction: the characters' states,
// then the market changes in order, then the id high-water marks.
type Transfer struct {
	Characters          []CharacterState
	Market              []MarketOp
	OfferHigh, MailHigh int64
}

// transferHook, when set (tests), runs inside the transaction after step n (0: after
// the snapshots, i: after market change i); an error aborts the transaction.
var transferHook func(step int) error

// SaveTransfer writes t in one transaction: all of it or nothing.
func (s *Store) SaveTransfer(ctx context.Context, t Transfer) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		for _, c := range t.Characters {
			if err := saveCharacterState(ctx, q, c); err != nil {
				return err
			}
		}
		if transferHook != nil {
			if err := transferHook(0); err != nil {
				return err
			}
		}
		for i, op := range t.Market {
			if err := applyMarketOp(ctx, q, op); err != nil {
				return fmt.Errorf("market change %d (kind %d): %w", i, op.Kind, err)
			}
			if transferHook != nil {
				if err := transferHook(i + 1); err != nil {
					return err
				}
			}
		}
		if len(t.Market) > 0 {
			if err := q.BumpMarketHigh(ctx, db.BumpMarketHighParams{OfferHigh: t.OfferHigh, MailHigh: t.MailHigh}); err != nil {
				return fmt.Errorf("market ids: %w", err)
			}
		}
		return nil
	})
}

func applyMarketOp(ctx context.Context, q *db.Queries, op MarketOp) error {
	switch op.Kind {
	case MarketOfferAdd:
		o := op.Offer
		return q.InsertMarketOffer(ctx, db.InsertMarketOfferParams{ID: o.ID, CharacterID: o.CharacterID,
			Side: int16(o.Side), ItemID: int32(o.ItemID), Amount: int32(o.Amount), Price: o.Price,
			CreatedAt: ts(o.Created), ExpiresAt: ts(o.Expires)})
	case MarketOfferFill:
		_, err := q.FillMarketOffer(ctx, db.FillMarketOfferParams{ID: op.ID, Units: int32(op.Units)})
		if errors.Is(err, pgx.ErrNoRows) {
			n, err := q.DeleteFilledMarketOffer(ctx, db.DeleteFilledMarketOfferParams{ID: op.ID, Units: int32(op.Units)})
			if err != nil {
				return err
			}
			if n == 0 {
				return ErrMarketConflict
			}
			return nil
		}
		return err
	case MarketOfferRemove:
		n, err := q.DeleteMarketOffer(ctx, op.ID)
		if err == nil && n == 0 {
			err = ErrMarketConflict
		}
		return err
	case MarketMailAdd:
		m := op.Mail
		raw, err := json.Marshal(m.Item)
		if err != nil {
			return err
		}
		return q.InsertMarketMailItem(ctx, db.InsertMarketMailItemParams{ID: m.ID, CharacterID: m.CharacterID,
			ItemID: int32(m.Item.ItemID), Count: int32(m.Item.Count), Item: raw, CreatedAt: ts(m.Created)})
	case MarketMailRemove:
		n, err := q.DeleteMarketMailItem(ctx, db.DeleteMarketMailItemParams{ID: op.ID, CharacterID: op.CharacterID})
		if err == nil && n == 0 {
			err = ErrMarketConflict
		}
		return err
	case MarketGoldAdd:
		return q.AddMarketMailGold(ctx, db.AddMarketMailGoldParams{CharacterID: op.CharacterID, Amount: op.Gold})
	case MarketHistoryAdd:
		h := op.History
		return q.InsertMarketHistory(ctx, db.InsertMarketHistoryParams{CharacterID: h.CharacterID,
			OtherCharacterID: h.Other, Side: int16(h.Side), ItemID: int32(h.ItemID), Amount: int32(h.Amount),
			Price: h.Price, At: ts(h.At)})
	}
	return fmt.Errorf("unknown market change %d: %w", op.Kind, ErrMarketConflict)
}

// LoadMarket reads the whole market: every offer, mailbox and id mark, the history of
// the last historyDays (at most perCharacter rows each) and the sales of the last
// salesDays, and the active bans of the accounts with offers.
func (s *Store) LoadMarket(ctx context.Context, now time.Time, historyDays, perCharacter, salesDays int) (MarketData, error) {
	var d MarketData
	err := s.inTx(ctx, func(q *db.Queries) error {
		high, err := q.LoadMarketHigh(ctx)
		if err != nil {
			return fmt.Errorf("market ids: %w", err)
		}
		d.OfferHigh, d.MailHigh = high.OfferHigh, high.MailHigh
		offers, err := q.LoadMarketOffers(ctx)
		if err != nil {
			return fmt.Errorf("market offers: %w", err)
		}
		for _, o := range offers {
			d.Offers = append(d.Offers, MarketOffer{ID: o.ID, CharacterID: o.CharacterID, AccountID: o.AccountID,
				Name: o.Name, Side: int(o.Side), ItemID: int(o.ItemID), Amount: int(o.Amount), Price: o.Price,
				Created: o.CreatedAt.Time, Expires: o.ExpiresAt.Time})
		}
		mail, err := q.LoadMarketMailItems(ctx)
		if err != nil {
			return fmt.Errorf("market mail: %w", err)
		}
		for _, m := range mail {
			var it InventoryItem
			if err := json.Unmarshal(m.Item, &it); err != nil {
				return fmt.Errorf("market mail %d: %w", m.ID, err)
			}
			d.Mail = append(d.Mail, MarketMail{ID: m.ID, CharacterID: m.CharacterID, Item: it, Created: m.CreatedAt.Time})
		}
		gold, err := q.LoadMarketMailGold(ctx)
		if err != nil {
			return fmt.Errorf("market gold: %w", err)
		}
		d.Gold = make(map[int64]int64, len(gold))
		for _, g := range gold {
			d.Gold[g.CharacterID] = g.Gold
		}
		hist, err := q.LoadMarketHistory(ctx, db.LoadMarketHistoryParams{
			Since: ts(now.AddDate(0, 0, -historyDays)), PerCharacter: int64(perCharacter)})
		if err != nil {
			return fmt.Errorf("market history: %w", err)
		}
		for _, h := range hist {
			d.History = append(d.History, MarketHistory{CharacterID: h.CharacterID, Other: h.OtherCharacterID,
				Side: int(h.Side), ItemID: int(h.ItemID), Amount: int(h.Amount), Price: h.Price, At: h.At.Time})
		}
		sales, err := q.LoadMarketSales(ctx, ts(now.AddDate(0, 0, -salesDays)))
		if err != nil {
			return fmt.Errorf("market sales: %w", err)
		}
		for _, x := range sales {
			d.Sales = append(d.Sales, MarketSale{ItemID: int(x.ItemID), Day: x.Day.Time, Units: x.Units, Total: x.Total})
		}
		bans, err := q.LoadMarketBans(ctx, ts(now))
		if err != nil {
			return fmt.Errorf("market bans: %w", err)
		}
		d.Bans = make(map[int64]time.Time, len(bans))
		for _, b := range bans {
			d.Bans[b.AccountID] = tsTime(b.Until)
		}
		return nil
	})
	return d, err
}

func tsTime(t pgtype.Timestamptz) time.Time {
	if !t.Valid {
		return time.Time{}
	}
	return t.Time
}
