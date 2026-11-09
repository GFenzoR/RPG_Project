-- Player houses (T5.4). The loop owns them in memory: these queries load them at start and
-- write each change inside the transaction of a session.Transfer.

-- name: LoadHouseOwners :many
SELECT h.house_id, h.character_id, h.account_id, c.name, h.paid_until, h.since, h.guild_access
FROM house_owners h JOIN characters c ON c.id = h.character_id
ORDER BY h.house_id;

-- name: LoadHouseGuests :many
SELECT house_id, name FROM house_guests ORDER BY house_id, name_key;

-- name: LoadHouseItems :many
SELECT house_id, x, y, z, seq, item FROM house_items ORDER BY house_id, z, y, x, seq;

-- name: InsertHouseOwner :exec
-- Rents a free house (a row already there is a conflict: the transfer fails).
INSERT INTO house_owners (house_id, character_id, account_id, paid_until, since, guild_access)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: ChangeHouseOwner :execrows
-- Gives a house to another character; no row when the database has another owner.
UPDATE house_owners SET character_id = sqlc.arg(to_character)::bigint, account_id = sqlc.arg(to_account)::bigint,
    paid_until = sqlc.arg(paid_until), since = sqlc.arg(since), guild_access = FALSE
WHERE house_id = sqlc.arg(house_id) AND character_id = sqlc.arg(from_character)::bigint;

-- name: DeleteHouseOwner :execrows
DELETE FROM house_owners WHERE house_id = $1 AND character_id = $2;

-- name: SetHousePaid :execrows
UPDATE house_owners SET paid_until = $3 WHERE house_id = $1 AND character_id = $2;

-- name: SetHouseGuildAccess :execrows
UPDATE house_owners SET guild_access = $3 WHERE house_id = $1 AND character_id = $2;

-- name: DeleteHouseGuests :exec
DELETE FROM house_guests WHERE house_id = $1;

-- name: InsertHouseGuest :exec
INSERT INTO house_guests (house_id, name_key, name) VALUES ($1, lower(sqlc.arg(name)::text), sqlc.arg(name)::text);

-- name: DeleteHouseItems :exec
DELETE FROM house_items WHERE house_id = $1;

-- name: InsertHouseItems :copyfrom
INSERT INTO house_items (house_id, x, y, z, seq, item_id, item) VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: PublicHouses :many
-- Owners for the public list (/api/houses): the name only, and nobody hidden by the
-- ranking's rules (staff, disabled or banned accounts) shows as owner.
SELECT h.house_id, c.name
FROM house_owners h
JOIN characters c ON c.id = h.character_id
JOIN accounts a ON a.id = c.account_id
WHERE a.role = 'player' AND a.disabled_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM account_bans b WHERE b.account_id = a.id AND b.lifted_at IS NULL
                  AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now)))
ORDER BY h.house_id;
