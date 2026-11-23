-- Account stash (migration 00025, docs/02 "Baúl de la cuenta").

-- name: LoadAccountStash :many
SELECT slot, item FROM account_stash_items WHERE account_id = @account_id ORDER BY slot;

-- name: DeleteAccountStash :exec
DELETE FROM account_stash_items WHERE account_id = @account_id;

-- name: InsertAccountStashItem :exec
INSERT INTO account_stash_items (account_id, slot, item_id, item) VALUES (@account_id, @slot, @item_id, @item);
