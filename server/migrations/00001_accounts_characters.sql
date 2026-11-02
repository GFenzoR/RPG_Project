-- +goose Up
-- Accounts own characters, sessions and cosmetics (docs/01-architecture.md).
CREATE TABLE accounts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Stored lowercased by the auth service; the unique index enforces it too.
    email             TEXT        NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
    -- argon2id PHC string. NULL for accounts that only log in with OAuth (T2.1).
    password_hash     TEXT,
    email_verified_at TIMESTAMPTZ,
    disabled_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX accounts_email_key ON accounts (email);

CREATE TABLE characters (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id    BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    name          TEXT        NOT NULL CHECK (length(name) BETWEEN 3 AND 20),
    -- Content id from data/vocations.yaml (validated by the server, not by the DB).
    vocation      TEXT        NOT NULL,
    level         INTEGER     NOT NULL DEFAULT 1 CHECK (level >= 1),
    experience    BIGINT      NOT NULL DEFAULT 0 CHECK (experience >= 0),
    health        INTEGER     NOT NULL CHECK (health >= 0),
    mana          INTEGER     NOT NULL CHECK (mana >= 0),
    -- Position in the world. NULL until the first login: the game server places a new
    -- character at its residence town's temple (T1.4).
    pos_x         INTEGER CHECK (pos_x BETWEEN 0 AND 65535),
    pos_y         INTEGER CHECK (pos_y BETWEEN 0 AND 65535),
    pos_z         SMALLINT CHECK (pos_z BETWEEN 0 AND 15),
    -- Residence town (content id). Empty = the starting island's town.
    town          TEXT        NOT NULL DEFAULT '',
    blessings     SMALLINT    NOT NULL DEFAULT 0 CHECK (blessings >= 0),
    -- Cosmetic look (content ids). Never gives a gameplay advantage.
    outfit        TEXT        NOT NULL DEFAULT '',
    outfit_colors INTEGER[]   NOT NULL DEFAULT '{}' CHECK (cardinality(outfit_colors) <= 8),
    -- Prepared for PvP (docs/00-vision.md); unused in the PvE MVP.
    skull         SMALLINT    NOT NULL DEFAULT 0 CHECK (skull >= 0),
    skull_until   TIMESTAMPTZ,
    pvp_flags     INTEGER     NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    last_save_at  TIMESTAMPTZ,
    CHECK ((pos_x IS NULL) = (pos_y IS NULL) AND (pos_y IS NULL) = (pos_z IS NULL)),
    -- Target of composite foreign keys that tie rows to "this character of this account".
    UNIQUE (id, account_id)
);
-- Names are unique ignoring case ("Ana" and "ANA" cannot coexist).
CREATE UNIQUE INDEX characters_name_key ON characters (lower(name));
CREATE INDEX characters_account_idx ON characters (account_id);

-- +goose Down
DROP TABLE characters;
DROP TABLE accounts;
