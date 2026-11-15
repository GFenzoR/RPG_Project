package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/GFenzoR/RPG_Project/server/internal/store/db"
)

// Shop errors (T5.7). Callers match them with errors.Is.
var (
	// ErrShopBlocked: the account is disabled, banned or flagged after a refund or
	// chargeback it could not cover; it cannot buy.
	ErrShopBlocked = errors.New("store: account cannot buy in the shop")
	// ErrInsufficient: the premium balance does not cover the price.
	ErrInsufficient = errors.New("store: premium balance too low")
	// ErrOwned: the account already owns the cosmetic.
	ErrOwned = errors.New("store: cosmetic already owned")
	// ErrNotForSale: no cosmetic with that id is on sale.
	ErrNotForSale = errors.New("store: cosmetic not for sale")
	// ErrDailyLimit: a pack would take the account over its daily premium limit.
	ErrDailyLimit = errors.New("store: daily premium limit reached")
)

// Premium ledger reasons (premium_ledger.reason).
const (
	LedgerPack       = "pack"
	LedgerPurchase   = "purchase"
	LedgerRefund     = "refund"
	LedgerChargeback = "chargeback"
	LedgerGrant      = "grant"
)

// Payment event types (payment_events.type, payments.EventType).
const (
	PaymentPaid       = "paid"
	PaymentRefunded   = "refunded"
	PaymentChargeback = "chargeback"
	// PaymentDispute: the payment is in mediation (a dispute the provider has not
	// decided): the account is flagged for staff, nothing is debited.
	PaymentDispute = "dispute"
)

// Payment results (PaymentResult.Result, payment_events.result).
const (
	PaymentCredited  = "credited"
	PaymentDebited   = "debited"
	PaymentDuplicate = "duplicate" // the event was processed before: nothing changed
	PaymentIgnored   = "ignored"   // nothing to do (already reversed, the account is gone...)
	PaymentFlagged   = "flagged"   // a dispute: the account was flagged
	// PaymentPendingReversal: a refund or chargeback of a payment not credited yet (it
	// arrived first). The credit, when it arrives, is reversed in the same transaction;
	// the event then becomes debited.
	PaymentPendingReversal = "pending_reversal"
	// PaymentUnmatched: an approved payment that could not be credited (bad reference,
	// unknown currency or pack, amount mismatch), stored for staff reconciliation.
	PaymentUnmatched = "unmatched"
)

// Reasons of an unmatched payment (payment_events.note).
const (
	UnmatchedReference = "bad_reference"
	UnmatchedCurrency  = "unknown_currency"
	UnmatchedPack      = "unknown_pack"
	UnmatchedAmount    = "amount_mismatch"
	UnmatchedAccount   = "account_gone" // the account was deleted before the payment arrived
)

// CosmeticRow is one cosmetic of data/cosmetics.yaml for SyncCosmetics.
type CosmeticRow struct {
	ID    string
	Kind  string
	Price int64
}

// SyncCosmetics upserts the catalog (id, kind, price) and takes the cosmetics that are
// no longer in it off sale (accounts keep the ones they own).
func (s *Store) SyncCosmetics(ctx context.Context, rows []CosmeticRow) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		ids := make([]string, len(rows))
		for i, r := range rows {
			if err := q.UpsertCosmetic(ctx, db.UpsertCosmeticParams{ID: r.ID, Kind: r.Kind,
				Price: pgtype.Int4{Int32: int32(r.Price), Valid: true}}); err != nil {
				return fmt.Errorf("sync cosmetic %s: %w", r.ID, err)
			}
			ids[i] = r.ID
		}
		if err := q.RetireCosmetics(ctx, ids); err != nil {
			return fmt.Errorf("retire cosmetics: %w", err)
		}
		return nil
	})
}

// LedgerEntry is one row of premium_ledger.
type LedgerEntry struct {
	ID           int64
	At           time.Time
	Reason       string
	Delta        int64
	BalanceAfter int64
	Shortfall    int64
	CosmeticID   string
	PackID       string
	ActorName    string
	Note         string
}

// ShopState is an account's balance, flag, cosmetics and recent history.
type ShopState struct {
	Balance int64
	Flagged bool
	// Blocked: disabled or banned (or Flagged): it cannot buy.
	Blocked bool
	Owned   []string
	History []LedgerEntry
}

// ShopHistoryLen is how many ledger rows ShopState returns.
const ShopHistoryLen = 50

// ShopState reads the shop state of an account at now (ErrNotFound if it does not exist).
func (s *Store) ShopState(ctx context.Context, accountID int64, now time.Time) (ShopState, error) {
	row, err := s.q.GetShopAccount(ctx, db.GetShopAccountParams{ID: accountID, Now: ts(now)})
	if err != nil {
		return ShopState{}, fmt.Errorf("shop account: %w", notFound(err))
	}
	owned, err := s.q.ListAccountCosmetics(ctx, accountID)
	if err != nil {
		return ShopState{}, fmt.Errorf("account cosmetics: %w", err)
	}
	hist, err := s.ledger(ctx, s.q, accountID, ShopHistoryLen)
	if err != nil {
		return ShopState{}, err
	}
	flagged := row.ShopFlaggedAt.Valid
	return ShopState{Balance: row.PremiumBalance, Flagged: flagged, Blocked: row.Blocked || flagged,
		Owned: owned, History: hist}, nil
}

func (s *Store) ledger(ctx context.Context, q *db.Queries, accountID int64, n int) ([]LedgerEntry, error) {
	rows, err := q.ListPremiumLedger(ctx, db.ListPremiumLedgerParams{AccountID: accountID, N: int32(n)})
	if err != nil {
		return nil, fmt.Errorf("premium ledger: %w", err)
	}
	out := make([]LedgerEntry, len(rows))
	for i, r := range rows {
		out[i] = LedgerEntry{ID: r.ID, At: r.At.Time, Reason: r.Reason, Delta: r.Delta, BalanceAfter: r.BalanceAfter,
			Shortfall: r.Shortfall, CosmeticID: r.CosmeticID.String, PackID: r.PackID.String,
			ActorName: r.ActorName.String, Note: r.Note}
	}
	return out, nil
}

// PremiumBoughtSince is the premium the account got from packs since a time (the daily
// limit, data/cosmetics.yaml limits.daily_premium).
func (s *Store) PremiumBoughtSince(ctx context.Context, accountID int64, since time.Time) (int64, error) {
	n, err := s.q.PremiumBoughtSince(ctx, db.PremiumBoughtSinceParams{AccountID: accountID, Since: ts(since)})
	if err != nil {
		return 0, fmt.Errorf("premium bought: %w", err)
	}
	return n, nil
}

// Purchase is the outcome of BuyCosmetic.
type Purchase struct {
	Balance int64
	Owned   []string
}

// BuyCosmetic spends the price of cosmetic id from the account's balance and gives it the
// cosmetic, with its ledger row, in one transaction. The account row is locked first, so
// concurrent purchases of one account run one after the other and the balance can never
// go below zero.
func (s *Store) BuyCosmetic(ctx context.Context, accountID int64, id string, now time.Time) (Purchase, error) {
	var out Purchase
	err := s.inTx(ctx, func(q *db.Queries) error {
		acc, err := q.LockShopAccount(ctx, db.LockShopAccountParams{ID: accountID, Now: ts(now)})
		if err != nil {
			return fmt.Errorf("lock account: %w", notFound(err))
		}
		if acc.Blocked || acc.ShopFlaggedAt.Valid {
			return ErrShopBlocked
		}
		c, err := q.GetCosmeticForSale(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !c.PricePremium.Valid) {
			return ErrNotForSale
		}
		if err != nil {
			return fmt.Errorf("cosmetic: %w", err)
		}
		price := int64(c.PricePremium.Int32)
		if acc.PremiumBalance < price {
			return ErrInsufficient
		}
		n, err := q.InsertAccountCosmetic(ctx, db.InsertAccountCosmeticParams{AccountID: accountID, CosmeticID: id,
			Source: "shop", At: ts(now)})
		if err != nil {
			return fmt.Errorf("give cosmetic: %w", err)
		}
		if n == 0 {
			return ErrOwned
		}
		bal := acc.PremiumBalance - price
		if err := q.SetPremiumBalance(ctx, db.SetPremiumBalanceParams{ID: accountID, Balance: bal}); err != nil {
			return fmt.Errorf("set balance: %w", err)
		}
		if _, err := q.InsertPremiumLedger(ctx, db.InsertPremiumLedgerParams{At: ts(now), AccountID: accountID,
			Reason: LedgerPurchase, Delta: -price, BalanceAfter: bal, CosmeticID: text(id)}); err != nil {
			return fmt.Errorf("ledger: %w", err)
		}
		owned, err := q.ListAccountCosmetics(ctx, accountID)
		if err != nil {
			return fmt.Errorf("account cosmetics: %w", err)
		}
		out = Purchase{Balance: bal, Owned: owned}
		return nil
	})
	return out, err
}

// PaymentEvent is a verified notification of the payment provider (payments.Event) with
// the premium amount of its pack (from data/cosmetics.yaml, never from the provider).
type PaymentEvent struct {
	Provider  string
	EventID   string
	Type      string // PaymentPaid, PaymentRefunded, PaymentChargeback or PaymentDispute
	PaymentID string
	AccountID int64
	PackID    string
	// AmountMinor and Currency are what the provider confirmed (recorded).
	AmountMinor int64
	Currency    string
	// RefundedMinor (PaymentRefunded) is the total refunded so far, in the minor unit
	// of Currency; 0 (or AmountMinor or more) means the whole payment. A partial refund
	// takes back floor(credit * RefundedMinor / AmountMinor) in total.
	RefundedMinor int64
	// Premium is the pack's amount: credited when paid (and by a partial refund of a
	// payment that was never credited: the rest of the payment stands). 0 for a
	// reversal of a pack no longer in the catalog (a reversal never needs it).
	Premium int64
	// Unmatched (an Unmatched* code) says this event cannot credit (unknown pack, amount
	// mismatch): where it would credit, it is stored as unmatched instead.
	Unmatched string
	At        time.Time
}

// PaymentResult is the outcome of ApplyPayment.
type PaymentResult struct {
	Result  string // one of the Payment* results
	Balance int64
	// Shortfall is what a reversal could not debit (the account is then flagged).
	Shortfall int64
	// Reversed is what the event debited (a reversal, or a credit that reversed at
	// once the refunds that arrived before it).
	Reversed int64
}

// ApplyPayment processes a verified payment event once, in one transaction:
//   - the account row of the event is locked first. Every event of a payment carries the
//     same signed account, so the events of one payment (a paid and a refund arriving
//     together) run one after the other, and each reads the payment's credit and
//     reversals only after the lock;
//   - its (provider, event id) is recorded next: a duplicate changes nothing;
//   - paid credits the pack's premium (one credit per payment, even under two events),
//     and at once reverses the refunds or chargebacks that arrived before it;
//   - refunded or chargeback debits what that payment credited (a partial refund, its
//     share, floored; the reversals of one payment never take back more than the
//     credit). The balance never goes below zero: what is missing is recorded as the
//     ledger row's shortfall and the account is flagged (it cannot buy until staff
//     clears it). A reversal of a payment not credited yet is kept as pending_reversal;
//   - dispute flags the account for staff and debits nothing.
//
// The daily limit is not checked here: it is checked when the checkout starts, and a
// payment the player already made is always credited.
func (s *Store) ApplyPayment(ctx context.Context, e PaymentEvent) (PaymentResult, error) {
	var res PaymentResult
	err := s.inTx(ctx, func(q *db.Queries) error {
		acc, err := q.LockShopAccount(ctx, db.LockShopAccountParams{ID: e.AccountID, Now: ts(e.At)})
		gone := errors.Is(err, pgx.ErrNoRows)
		if err != nil && !gone {
			return fmt.Errorf("lock account: %w", err)
		}
		evID, err := q.InsertPaymentEvent(ctx, db.InsertPaymentEventParams{Provider: e.Provider, EventID: e.EventID,
			Type: e.Type, PaymentID: e.PaymentID, AccountID: e.AccountID, PackID: e.PackID,
			AmountMinor: e.AmountMinor, Currency: e.Currency, RefundedMinor: e.RefundedMinor,
			Result: PaymentIgnored, At: ts(e.At)})
		if errors.Is(err, pgx.ErrNoRows) {
			res.Result = PaymentDuplicate
			return nil
		}
		if err != nil {
			return fmt.Errorf("record payment event: %w", err)
		}
		if gone {
			// The account was deleted: real money nobody can receive if this event would
			// credit; a reversal has nothing left to take.
			res.Result = PaymentIgnored
			note := ""
			if e.credits() {
				res.Result, note = PaymentUnmatched, UnmatchedAccount
			}
			return q.SetPaymentEventResult(ctx, db.SetPaymentEventResultParams{ID: evID, Result: res.Result, Note: note})
		}
		res, err = applyPayment(ctx, q, e, acc.PremiumBalance)
		if err != nil {
			return err
		}
		note := ""
		if res.Result == PaymentUnmatched {
			note = e.Unmatched
		}
		return q.SetPaymentEventResult(ctx, db.SetPaymentEventResultParams{ID: evID, Result: res.Result, Note: note})
	})
	if err != nil {
		return PaymentResult{}, fmt.Errorf("apply payment: %w", err)
	}
	return res, nil
}

// credits: the event would credit the pack if the payment was never credited (a paid,
// or a partial refund: the rest of the payment stands).
func (e PaymentEvent) credits() bool {
	return e.Type == PaymentPaid || e.partial()
}

// partial: a refund of part of the payment.
func (e PaymentEvent) partial() bool {
	return e.Type == PaymentRefunded && e.RefundedMinor > 0 && e.RefundedMinor < e.AmountMinor
}

// RecordUnmatchedPayment stores an approved payment that could not be credited (reason:
// one of the Unmatched* codes) for staff reconciliation; no balance changes. A duplicate
// (same provider and event id) is a no-op. It returns PaymentUnmatched or
// PaymentDuplicate.
func (s *Store) RecordUnmatchedPayment(ctx context.Context, e PaymentEvent, reason string) (string, error) {
	_, err := s.q.InsertPaymentEvent(ctx, db.InsertPaymentEventParams{Provider: e.Provider, EventID: e.EventID,
		Type: e.Type, PaymentID: e.PaymentID, AccountID: e.AccountID, PackID: e.PackID,
		AmountMinor: e.AmountMinor, Currency: e.Currency, RefundedMinor: e.RefundedMinor,
		Result: PaymentUnmatched, Note: reason, At: ts(e.At)})
	if errors.Is(err, pgx.ErrNoRows) {
		return PaymentDuplicate, nil
	}
	if err != nil {
		return "", fmt.Errorf("record unmatched payment: %w", err)
	}
	return PaymentUnmatched, nil
}

// applyPayment runs after the account row is locked and the event recorded; bal is the
// locked balance.
func applyPayment(ctx context.Context, q *db.Queries, e PaymentEvent, bal int64) (PaymentResult, error) {
	prov, pay := text(e.Provider), text(e.PaymentID)
	credit, err := q.PaymentCredit(ctx, db.PaymentCreditParams{Provider: prov, PaymentID: pay})
	credited := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return PaymentResult{}, fmt.Errorf("payment credit: %w", err)
	}
	if credited && credit.AccountID != e.AccountID {
		// Never: the account travels signed in the reference. Touch nothing.
		return PaymentResult{Result: PaymentIgnored, Balance: bal}, nil
	}
	pv := paymentRef{account: e.AccountID, prov: prov, pay: pay, pack: e.PackID, at: e.At}
	// creditNow credits a payment never credited, then reverses at once the refunds and
	// chargebacks that arrived before it. An event that cannot credit (unknown pack,
	// amount mismatch: e.Unmatched) is unmatched instead.
	creditNow := func() (PaymentResult, error) {
		if e.Unmatched != "" || e.Premium <= 0 {
			return PaymentResult{Result: PaymentUnmatched, Balance: bal}, nil
		}
		b, err := pv.credit(ctx, q, e.Premium, bal)
		if err != nil {
			return PaymentResult{}, err
		}
		res := PaymentResult{Result: PaymentCredited, Balance: b}
		pend, err := q.PendingReversals(ctx, db.PendingReversalsParams{Provider: e.Provider, PaymentID: e.PaymentID})
		if err != nil {
			return PaymentResult{}, fmt.Errorf("pending reversals: %w", err)
		}
		for _, p := range pend {
			r, err := pv.reverse(ctx, q, p.Type, p.RefundedMinor, p.AmountMinor, e.Premium, res.Balance)
			if err != nil {
				return PaymentResult{}, err
			}
			if err := q.SetPaymentEventResult(ctx, db.SetPaymentEventResultParams{ID: p.ID, Result: r.Result}); err != nil {
				return PaymentResult{}, fmt.Errorf("pending reversal result: %w", err)
			}
			res.Balance, res.Shortfall, res.Reversed = r.Balance, res.Shortfall+r.Shortfall, res.Reversed+r.Reversed
		}
		return res, nil
	}
	switch e.Type {
	case PaymentDispute:
		if err := q.FlagShopAccount(ctx, db.FlagShopAccountParams{ID: e.AccountID, At: ts(e.At)}); err != nil {
			return PaymentResult{}, fmt.Errorf("flag account: %w", err)
		}
		return PaymentResult{Result: PaymentFlagged, Balance: bal}, nil
	case PaymentPaid:
		if credited {
			return PaymentResult{Result: PaymentIgnored, Balance: bal}, nil
		}
		return creditNow()
	case PaymentRefunded, PaymentChargeback:
		delta := credit.Delta
		if !credited {
			if !e.partial() {
				return PaymentResult{Result: PaymentPendingReversal, Balance: bal}, nil
			}
			// A partial refund says the rest of the payment stands: credit it first
			// (with the reversals that were waiting), then take this refund's share.
			c, err := creditNow()
			if err != nil || c.Result != PaymentCredited {
				return c, err
			}
			r, err := pv.reverse(ctx, q, e.Type, e.RefundedMinor, e.AmountMinor, e.Premium, c.Balance)
			if err != nil {
				return PaymentResult{}, err
			}
			r.Shortfall += c.Shortfall
			r.Reversed += c.Reversed
			if r.Result == PaymentIgnored && c.Reversed > 0 {
				r.Result = PaymentDebited
			}
			return r, nil
		}
		// A reversal never needs the pack: it takes back what the ledger says was credited.
		return pv.reverse(ctx, q, e.Type, e.RefundedMinor, e.AmountMinor, delta, bal)
	default:
		return PaymentResult{Result: PaymentIgnored, Balance: bal}, nil
	}
}

// paymentRef is what every ledger row of one payment shares.
type paymentRef struct {
	account   int64
	prov, pay pgtype.Text
	pack      string
	at        time.Time
}

// credit adds the pack's premium to bal with its ledger row.
func (p paymentRef) credit(ctx context.Context, q *db.Queries, premium, bal int64) (int64, error) {
	bal += premium
	if err := q.SetPremiumBalance(ctx, db.SetPremiumBalanceParams{ID: p.account, Balance: bal}); err != nil {
		return 0, fmt.Errorf("set balance: %w", err)
	}
	if _, err := q.InsertPremiumLedger(ctx, db.InsertPremiumLedgerParams{At: ts(p.at), AccountID: p.account,
		Reason: LedgerPack, Delta: premium, BalanceAfter: bal, PackID: text(p.pack), Provider: p.prov,
		PaymentID: p.pay}); err != nil {
		return 0, fmt.Errorf("ledger: %w", err)
	}
	return bal, nil
}

// reverse takes back what a refund or chargeback of a payment that credited `credit`
// owes: all of it or, for a partial refund (0 < refunded < amount),
// floor(credit * refunded / amount) in total, minus what earlier reversals of the
// payment already took. Ignored when nothing more is owed.
func (p paymentRef) reverse(ctx context.Context, q *db.Queries, typ string, refunded, amount, credit, bal int64) (PaymentResult, error) {
	target := credit
	if typ == PaymentRefunded && refunded > 0 && amount > 0 && refunded < amount {
		target = credit * refunded / amount
	}
	done, err := q.PaymentReversedTotal(ctx, db.PaymentReversedTotalParams{Provider: p.prov, PaymentID: p.pay})
	if err != nil {
		return PaymentResult{}, fmt.Errorf("payment reversed: %w", err)
	}
	owed := target - done
	if owed <= 0 {
		return PaymentResult{Result: PaymentIgnored, Balance: bal}, nil
	}
	reason := LedgerRefund
	if typ == PaymentChargeback {
		reason = LedgerChargeback
	}
	debit := min(owed, bal)
	short := owed - debit
	bal -= debit
	if err := q.SetPremiumBalance(ctx, db.SetPremiumBalanceParams{ID: p.account, Balance: bal}); err != nil {
		return PaymentResult{}, fmt.Errorf("set balance: %w", err)
	}
	if _, err := q.InsertPremiumLedger(ctx, db.InsertPremiumLedgerParams{At: ts(p.at), AccountID: p.account,
		Reason: reason, Delta: -debit, BalanceAfter: bal, Shortfall: short, PackID: text(p.pack), Provider: p.prov,
		PaymentID: p.pay}); err != nil {
		return PaymentResult{}, fmt.Errorf("ledger: %w", err)
	}
	if short > 0 {
		if err := q.FlagShopAccount(ctx, db.FlagShopAccountParams{ID: p.account, At: ts(p.at)}); err != nil {
			return PaymentResult{}, fmt.Errorf("flag account: %w", err)
		}
	}
	return PaymentResult{Result: PaymentDebited, Balance: bal, Shortfall: short, Reversed: debit}, nil
}

// PremiumGrant is a staff change of a character's account balance (the /premium command).
type PremiumGrant struct {
	// Audit carries the actor, the time and the action; the store fills in the target
	// and the result.
	Audit      AuditEntry
	TargetName string
	// Delta is added to the balance (negative removes; never below zero).
	Delta int64
	Note  string
	// ClearFlag also clears the account's shop flag.
	ClearFlag bool
}

// GrantResult is the outcome of GrantPremium.
type GrantResult struct {
	Result    string // ResultOK, ResultNotFound or ResultInsufficient
	AccountID int64
	Name      string
	Balance   int64
}

// ResultInsufficient is the result of a staff removal larger than the balance (nothing changed).
const ResultInsufficient = "insufficient"

// GrantPremium changes the balance of the account of character TargetName by Delta,
// with its ledger row and the audit entry, in one transaction.
func (s *Store) GrantPremium(ctx context.Context, g PremiumGrant) (GrantResult, error) {
	var res GrantResult
	err := s.inTx(ctx, func(q *db.Queries) error {
		t, err := target(ctx, q, g.TargetName)
		if err != nil {
			return err
		}
		res = GrantResult{Result: t.Result, AccountID: t.AccountID, Name: t.Name}
		if t.Result == ResultOK {
			acc, err := q.LockShopAccount(ctx, db.LockShopAccountParams{ID: t.AccountID, Now: ts(g.Audit.At)})
			if err != nil {
				return fmt.Errorf("lock account: %w", err)
			}
			res.Balance = acc.PremiumBalance
			if acc.PremiumBalance+g.Delta < 0 {
				res.Result = ResultInsufficient
			} else {
				res.Balance += g.Delta
				if err := q.SetPremiumBalance(ctx, db.SetPremiumBalanceParams{ID: t.AccountID, Balance: res.Balance}); err != nil {
					return fmt.Errorf("set balance: %w", err)
				}
				if _, err := q.InsertPremiumLedger(ctx, db.InsertPremiumLedgerParams{At: ts(g.Audit.At),
					AccountID: t.AccountID, Reason: LedgerGrant, Delta: g.Delta, BalanceAfter: res.Balance,
					ActorAccountID: optID(g.Audit.ActorAccountID), ActorName: text(g.Audit.ActorName),
					Note: g.Note}); err != nil {
					return fmt.Errorf("ledger: %w", err)
				}
				if g.ClearFlag {
					if err := q.ClearShopFlag(ctx, t.AccountID); err != nil {
						return fmt.Errorf("clear flag: %w", err)
					}
				}
			}
		}
		e := withTarget(g.Audit, t)
		e.Result = res.Result
		return appendAudit(ctx, q, e)
	})
	if err != nil {
		return GrantResult{}, fmt.Errorf("grant premium: %w", err)
	}
	return res, nil
}

// PremiumHistory returns the newest n ledger rows of the account of character name, and
// writes the audit entry (staff /purchases), in one transaction.
func (s *Store) PremiumHistory(ctx context.Context, name string, n int, audit AuditEntry) (GrantResult, []LedgerEntry, error) {
	var res GrantResult
	var rows []LedgerEntry
	err := s.inTx(ctx, func(q *db.Queries) error {
		t, err := target(ctx, q, name)
		if err != nil {
			return err
		}
		res = GrantResult{Result: t.Result, AccountID: t.AccountID, Name: t.Name}
		if t.Result == ResultOK {
			acc, err := q.GetShopAccount(ctx, db.GetShopAccountParams{ID: t.AccountID, Now: ts(audit.At)})
			if err != nil {
				return fmt.Errorf("shop account: %w", err)
			}
			res.Balance = acc.PremiumBalance
			if rows, err = s.ledger(ctx, q, t.AccountID, n); err != nil {
				return err
			}
		}
		return appendAudit(ctx, q, withTarget(audit, t))
	})
	if err != nil {
		return GrantResult{}, nil, fmt.Errorf("premium history: %w", err)
	}
	return res, rows, nil
}

func text(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }
