-- Cosmetic shop and premium currency (T5.7, migration 00017).

-- name: UpsertCosmetic :exec
-- Syncs one entry of data/cosmetics.yaml at startup.
INSERT INTO cosmetics (id, kind, price_premium, on_sale)
VALUES (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(price), true)
ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, price_premium = EXCLUDED.price_premium, on_sale = true;

-- name: RetireCosmetics :exec
-- Cosmetics no longer in data/cosmetics.yaml stay (accounts may own them) but are not sold.
UPDATE cosmetics SET on_sale = false WHERE on_sale AND NOT (id = ANY(sqlc.arg(ids)::text[]));

-- name: GetShopAccount :one
-- The shop state of an account. blocked: disabled or with an active ban.
SELECT a.premium_balance, a.shop_flagged_at,
       (a.disabled_at IS NOT NULL OR EXISTS (
           SELECT 1 FROM account_bans b
           WHERE b.account_id = a.id AND b.lifted_at IS NULL
             AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
       ))::boolean AS blocked
FROM accounts a
WHERE a.id = sqlc.arg(id);

-- name: LockShopAccount :one
-- Same as GetShopAccount, locking the account row: every balance change of an account
-- runs after this in its transaction, so concurrent purchases are serialized.
SELECT a.premium_balance, a.shop_flagged_at,
       (a.disabled_at IS NOT NULL OR EXISTS (
           SELECT 1 FROM account_bans b
           WHERE b.account_id = a.id AND b.lifted_at IS NULL
             AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
       ))::boolean AS blocked
FROM accounts a
WHERE a.id = sqlc.arg(id)
FOR UPDATE OF a;

-- name: SetPremiumBalance :exec
UPDATE accounts SET premium_balance = sqlc.arg(balance) WHERE id = sqlc.arg(id);

-- name: FlagShopAccount :exec
UPDATE accounts SET shop_flagged_at = COALESCE(shop_flagged_at, sqlc.arg(at)) WHERE id = sqlc.arg(id);

-- name: ClearShopFlag :exec
UPDATE accounts SET shop_flagged_at = NULL WHERE id = sqlc.arg(id);

-- name: InsertPremiumLedger :one
INSERT INTO premium_ledger (at, account_id, reason, delta, balance_after, shortfall, cosmetic_id, pack_id,
                            provider, payment_id, actor_account_id, actor_name, note)
VALUES (sqlc.arg(at), sqlc.arg(account_id), sqlc.arg(reason), sqlc.arg(delta), sqlc.arg(balance_after),
        sqlc.arg(shortfall), sqlc.narg(cosmetic_id), sqlc.narg(pack_id), sqlc.narg(provider), sqlc.narg(payment_id),
        sqlc.narg(actor_account_id), sqlc.narg(actor_name), sqlc.arg(note))
RETURNING id;

-- name: ListPremiumLedger :many
-- The newest balance changes of an account.
SELECT id, at, reason, delta, balance_after, shortfall, cosmetic_id, pack_id, actor_name, note
FROM premium_ledger
WHERE account_id = sqlc.arg(account_id)
ORDER BY id DESC
LIMIT sqlc.arg(n);

-- name: PremiumBoughtSince :one
-- Premium credited from packs since a time (the daily purchase limit).
SELECT COALESCE(sum(delta), 0)::bigint
FROM premium_ledger
WHERE account_id = sqlc.arg(account_id) AND reason = 'pack' AND at >= sqlc.arg(since);

-- name: ListAccountCosmetics :many
SELECT cosmetic_id FROM account_cosmetics WHERE account_id = sqlc.arg(account_id) ORDER BY cosmetic_id;

-- name: InsertAccountCosmetic :execrows
INSERT INTO account_cosmetics (account_id, cosmetic_id, source, acquired_at)
VALUES (sqlc.arg(account_id), sqlc.arg(cosmetic_id), sqlc.arg(source), sqlc.arg(at))
ON CONFLICT DO NOTHING;

-- name: GetCosmeticForSale :one
SELECT kind, price_premium FROM cosmetics WHERE id = sqlc.arg(id) AND on_sale;

-- name: InsertPaymentEvent :one
-- The idempotency key of a webhook: a duplicate (provider, event_id) inserts nothing
-- (no row). ApplyPayment runs it after locking the account, so two events of one payment
-- never race here; a duplicate of another account's event id still waits on the unique
-- index for the first one's transaction and then inserts nothing either.
INSERT INTO payment_events (provider, event_id, type, payment_id, account_id, pack_id, amount_minor, currency,
                            refunded_minor, result, note, received_at, processed_at)
VALUES (sqlc.arg(provider), sqlc.arg(event_id), sqlc.arg(type), sqlc.arg(payment_id), sqlc.arg(account_id),
        sqlc.arg(pack_id), sqlc.arg(amount_minor), sqlc.arg(currency), sqlc.arg(refunded_minor), sqlc.arg(result),
        sqlc.arg(note), sqlc.arg(at), sqlc.arg(at))
ON CONFLICT (provider, event_id) DO NOTHING
RETURNING id;

-- name: SetPaymentEventResult :exec
UPDATE payment_events SET result = sqlc.arg(result), note = sqlc.arg(note) WHERE id = sqlc.arg(id);

-- name: PaymentCredit :one
-- The pack credit of a payment (none: no row).
SELECT account_id, delta FROM premium_ledger
WHERE provider = sqlc.arg(provider) AND payment_id = sqlc.arg(payment_id) AND reason = 'pack'
LIMIT 1;

-- name: PaymentReversedTotal :one
-- How much of the payment's credit refunds and chargebacks already took back (what was
-- debited plus what could not be: the shortfall is owed too).
SELECT COALESCE(sum(shortfall - delta), 0)::bigint
FROM premium_ledger
WHERE provider = sqlc.arg(provider) AND payment_id = sqlc.arg(payment_id) AND reason IN ('refund', 'chargeback');

-- name: PendingReversals :many
-- Refunds and chargebacks that arrived before the payment was credited, oldest first.
SELECT id, type, amount_minor, refunded_minor FROM payment_events
WHERE provider = sqlc.arg(provider) AND payment_id = sqlc.arg(payment_id) AND result = 'pending_reversal'
ORDER BY id;
