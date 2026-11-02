-- +goose Up
-- Append-only economy log (trades, NPC sales, rare drops) to detect duplication and bots.
-- Character ids are not foreign keys: the log must survive character deletion.
CREATE TABLE economy_log (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                 TIMESTAMPTZ NOT NULL,
    kind               TEXT        NOT NULL,
    character_id       BIGINT,
    other_character_id BIGINT,
    item_id            INTEGER,
    count              INTEGER,
    -- Money moved, in the smallest coin.
    amount             BIGINT,
    details            JSONB       NOT NULL DEFAULT '{}'
);
CREATE INDEX economy_log_character_idx ON economy_log (character_id, at);
CREATE INDEX economy_log_at_idx ON economy_log (at);

-- +goose StatementBegin
CREATE FUNCTION economy_log_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'economy_log is append-only';
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER economy_log_no_update_delete
    BEFORE UPDATE OR DELETE ON economy_log
    FOR EACH ROW EXECUTE FUNCTION economy_log_append_only();
CREATE TRIGGER economy_log_no_truncate
    BEFORE TRUNCATE ON economy_log
    FOR EACH STATEMENT EXECUTE FUNCTION economy_log_append_only();

-- Cosmetics catalog and ownership (docs/00-vision.md). Cosmetics belong to the account.
-- No payment gateway yet: price_premium is only the future shop price.
CREATE TABLE cosmetics (
    id            TEXT PRIMARY KEY,
    kind          TEXT    NOT NULL CHECK (kind IN ('outfit', 'outfit_color', 'mount', 'name_effect')),
    price_premium INTEGER CHECK (price_premium >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE account_cosmetics (
    account_id  BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    cosmetic_id TEXT        NOT NULL REFERENCES cosmetics (id),
    -- 'game' (earned playing), 'shop' (future) or 'grant' (admin/event).
    source      TEXT        NOT NULL CHECK (source IN ('game', 'shop', 'grant')),
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, cosmetic_id)
);
CREATE INDEX account_cosmetics_cosmetic_idx ON account_cosmetics (cosmetic_id);

-- +goose Down
DROP TABLE account_cosmetics;
DROP TABLE cosmetics;
DROP TABLE economy_log;
DROP FUNCTION economy_log_append_only();
