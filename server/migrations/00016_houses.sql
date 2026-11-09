-- +goose Up
-- Player houses (T5.4, docs/02-game-design.md "Casas", docs/01 "Persistencia"). The houses
-- themselves (tiles, doors, rent) are map data (world/islands/<id>/houses.yaml); these
-- tables hold who rents each one, its guests and the items on its floor. The game loop
-- owns them in memory (loaded once at start, like the market) and every change is
-- written by the persistence goroutine inside a transfer: in ONE transaction with the
-- snapshots of the characters whose inventory it changed. The constraints are the
-- safety net: one owner per house and one house per account.

-- house_id is the id of houses.yaml. account_id is the owner's account (one house per
-- account): it follows the character, which never changes account.
CREATE TABLE house_owners (
    house_id     TEXT        PRIMARY KEY CHECK (house_id ~ '^[a-z][a-z0-9_]*$'),
    character_id BIGINT      NOT NULL UNIQUE REFERENCES characters (id) ON DELETE CASCADE,
    account_id   BIGINT      NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
    paid_until   TIMESTAMPTZ NOT NULL,
    since        TIMESTAMPTZ NOT NULL,
    guild_access BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Guests by character name (a name, not an id: the owner may name a character that is
-- offline, and the loop never reads the database). name_key is lower(name).
CREATE TABLE house_guests (
    house_id TEXT NOT NULL REFERENCES house_owners (house_id) ON DELETE CASCADE,
    name_key TEXT NOT NULL CHECK (name_key = lower(name)),
    name     TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
    PRIMARY KEY (house_id, name_key)
);

-- Items on the floor of a house: one row per item lying on a tile (seq: its place in
-- the tile's stack, 0 first); item is the saved instance (session.ItemState as JSON,
-- containers with their content). A house keeps its items whoever rents it: they are
-- replaced as a whole on each change, and moved to the owner's market mailbox when the
-- house is freed (in the same transaction). No foreign key to house_owners.
CREATE TABLE house_items (
    house_id TEXT     NOT NULL,
    x        INTEGER  NOT NULL CHECK (x BETWEEN 0 AND 65535),
    y        INTEGER  NOT NULL CHECK (y BETWEEN 0 AND 65535),
    z        SMALLINT NOT NULL CHECK (z BETWEEN 0 AND 15),
    seq      SMALLINT NOT NULL CHECK (seq >= 0),
    item_id  INTEGER  NOT NULL CHECK (item_id > 0),
    item     JSONB    NOT NULL,
    PRIMARY KEY (house_id, x, y, z, seq)
);

-- +goose Down
DROP TABLE house_items;
DROP TABLE house_guests;
DROP TABLE house_owners;
