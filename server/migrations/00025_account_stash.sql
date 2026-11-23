-- +goose Up
-- Account stash (docs/02-game-design.md "Baúl de la cuenta", docs/01 "Persistencia"): one
-- chest per account, shared by all of its characters. The game loop owns the stash of an
-- account in memory while a character of it is online (read with the character at login)
-- and every change is written by the persistence goroutine inside a transfer: in ONE
-- transaction with the snapshot of the character whose inventory it changed, so an item is
-- always in exactly one of the two. The rows are replaced as a whole on each change.
-- slot is the cell (0 first); item is the saved instance (session.ItemState as JSON,
-- containers with their content), like house_items.item.
CREATE TABLE account_stash_items (
    account_id BIGINT   NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    slot       SMALLINT NOT NULL CHECK (slot BETWEEN 0 AND 1023),
    item_id    INTEGER  NOT NULL CHECK (item_id > 0),
    item       JSONB    NOT NULL,
    PRIMARY KEY (account_id, slot)
);

-- +goose Down
DROP TABLE account_stash_items;
