-- Global market (T5.3). The loop owns the market in memory: these queries load it at
-- start and write each change inside the transaction of a session.Transfer.

-- name: LoadMarketOffers :many
SELECT o.id, o.character_id, c.account_id, c.name, o.side, o.item_id, o.amount, o.price, o.created_at, o.expires_at
FROM market_offers o JOIN characters c ON c.id = o.character_id
ORDER BY o.id;

-- name: LoadMarketMailItems :many
SELECT id, character_id, item_id, count, item, created_at FROM market_mail_items ORDER BY id;

-- name: LoadMarketMailGold :many
SELECT character_id, gold FROM market_mail_gold WHERE gold > 0;

-- name: LoadMarketHistory :many
-- The newest operations of every character since a time, at most per_character each.
SELECT h.character_id, h.other_character_id, h.side, h.item_id, h.amount, h.price, h.at
FROM (
    SELECT *, row_number() OVER (PARTITION BY character_id ORDER BY id DESC) AS n
    FROM market_history WHERE at >= sqlc.arg(since)
) h
WHERE h.n <= sqlc.arg(per_character)::bigint
ORDER BY h.id;

-- name: LoadMarketSales :many
-- Units sold and money paid by item and day since a time (reference prices).
SELECT item_id, date_trunc('day', at, 'UTC')::timestamptz AS day, sum(amount)::bigint AS units,
    sum(amount * price)::bigint AS total
FROM market_history WHERE side = 1 AND at >= sqlc.arg(since)
GROUP BY item_id, day ORDER BY item_id, day;

-- name: LoadMarketBans :many
-- The active bans of the accounts that own offers (their offers are hidden). until is
-- NULL for a permanent ban.
SELECT b.account_id, CASE WHEN bool_or(b.expires_at IS NULL) THEN NULL ELSE max(b.expires_at) END::timestamptz AS until
FROM account_bans b
WHERE b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
  AND b.account_id IN (SELECT c.account_id FROM market_offers o JOIN characters c ON c.id = o.character_id)
GROUP BY b.account_id;

-- name: LoadMarketHigh :one
SELECT offer_high, mail_high, transfer_high FROM market_id_high;

-- name: ClaimTransfer :execrows
-- Takes transfer id: no row when a transfer with this id (or a later one) was written.
UPDATE market_id_high SET transfer_high = sqlc.arg(id)::bigint WHERE transfer_high < sqlc.arg(id)::bigint;

-- name: BumpMarketHigh :exec
UPDATE market_id_high SET offer_high = GREATEST(offer_high, sqlc.arg(offer_high)::bigint),
    mail_high = GREATEST(mail_high, sqlc.arg(mail_high)::bigint);

-- name: InsertMarketOffer :exec
INSERT INTO market_offers (id, character_id, side, item_id, amount, price, created_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: FillMarketOffer :one
-- Takes units from an offer that keeps some; no row when the offer is gone or does not
-- have more than units left (then DeleteFilledMarketOffer takes the last ones).
UPDATE market_offers SET amount = amount - sqlc.arg(units)::integer
WHERE id = sqlc.arg(id) AND amount > sqlc.arg(units)::integer
RETURNING amount;

-- name: DeleteFilledMarketOffer :execrows
-- Takes the last units of an offer: deletes it only if exactly units are left.
DELETE FROM market_offers WHERE id = sqlc.arg(id) AND amount = sqlc.arg(units)::integer;

-- name: DeleteMarketOffer :execrows
DELETE FROM market_offers WHERE id = $1;

-- name: InsertMarketMailItem :exec
INSERT INTO market_mail_items (id, character_id, item_id, count, item, created_at) VALUES ($1, $2, $3, $4, $5, $6);

-- name: DeleteMarketMailItem :execrows
DELETE FROM market_mail_items WHERE id = $1 AND character_id = $2;

-- name: AddMarketMailGold :exec
-- A negative amount withdraws: the CHECK (gold >= 0) refuses more than there is.
INSERT INTO market_mail_gold (character_id, gold) VALUES ($1, sqlc.arg(amount)::bigint)
ON CONFLICT (character_id) DO UPDATE SET gold = market_mail_gold.gold + EXCLUDED.gold;

-- name: InsertMarketHistory :exec
INSERT INTO market_history (character_id, other_character_id, side, item_id, amount, price, at)
VALUES ($1, $2, $3, $4, $5, $6, $7);
