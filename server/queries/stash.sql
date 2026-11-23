-- Account stash (migration 00025, docs/02 "Baúl de la cuenta").

-- name: LoadAccountStash :many
SELECT slot, item FROM account_stash_items WHERE account_id = @account_id ORDER BY slot;

-- name: DeleteAccountStash :exec
DELETE FROM account_stash_items WHERE account_id = @account_id;

-- name: InsertAccountStashItems :exec
-- Every cell of a stash in one statement (parallel arrays, cell i at index i).
INSERT INTO account_stash_items (account_id, slot, item_id, item)
SELECT sqlc.arg(account_id)::bigint, unnest(sqlc.arg(slots)::smallint[]),
       unnest(sqlc.arg(item_ids)::int[]), unnest(sqlc.arg(items)::jsonb[]);
