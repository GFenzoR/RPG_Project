-- +goose Up
-- Global market (T5.3, docs/02-game-design.md "Economía", docs/01 "Transacciones"). The
-- game loop owns the order book and the mailboxes in memory (loaded once at start, like
-- the guilds). Every change that moves items or gold between a character and the market
-- is written by the persistence goroutine in ONE transaction together with the snapshot
-- of every online character it touched, in order with their autosaves. The constraints
-- are the safety net: a fill of more units than an offer has left fails the whole
-- transaction (no unit is sold twice).

-- Offers. Ids are issued by the loop (the next after market_id_high.offer_high), so an
-- id is never reused. side: 1 sell (the items are in the deposit), 2 buy (the gold,
-- amount × price, is in the deposit). price: smallest coin per unit.
CREATE TABLE market_offers (
    id           BIGINT      PRIMARY KEY CHECK (id > 0),
    character_id BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    side         SMALLINT    NOT NULL CHECK (side IN (1, 2)),
    item_id      INTEGER     NOT NULL CHECK (item_id > 0),
    amount       INTEGER     NOT NULL CHECK (amount > 0),
    price        BIGINT      NOT NULL CHECK (price > 0),
    created_at   TIMESTAMPTZ NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at)
);
-- The listing of one item: sells cheapest first, buys dearest first (id breaks ties).
CREATE INDEX market_offers_listing_idx ON market_offers (item_id, side, price, id);
CREATE INDEX market_offers_character_idx ON market_offers (character_id);
CREATE INDEX market_offers_expires_idx ON market_offers (expires_at);

-- Mailbox of items: what a character bought, or got back from a cancelled or expired
-- sell offer, waiting to be withdrawn at a market board. item is the saved instance
-- (session.ItemState as JSON: item id, count and content), so nothing about the
-- instance is lost on the way.
CREATE TABLE market_mail_items (
    id           BIGINT      PRIMARY KEY CHECK (id > 0),
    character_id BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    item_id      INTEGER     NOT NULL CHECK (item_id > 0),
    count        INTEGER     NOT NULL CHECK (count > 0),
    item         JSONB       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX market_mail_items_character_idx ON market_mail_items (character_id, id);

-- Mailbox of gold (smallest coin), one row per character that ever had some.
CREATE TABLE market_mail_gold (
    character_id BIGINT PRIMARY KEY REFERENCES characters (id) ON DELETE CASCADE,
    gold         BIGINT NOT NULL CHECK (gold >= 0)
);

-- Every completed operation, once per side: side 1 the character sold, 2 it bought.
-- other_character_id has no foreign key: the history survives the other's deletion.
CREATE TABLE market_history (
    id                 BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    character_id       BIGINT      NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
    other_character_id BIGINT      NOT NULL,
    side               SMALLINT    NOT NULL CHECK (side IN (1, 2)),
    item_id            INTEGER     NOT NULL CHECK (item_id > 0),
    amount             INTEGER     NOT NULL CHECK (amount > 0),
    price              BIGINT      NOT NULL CHECK (price > 0),
    at                 TIMESTAMPTZ NOT NULL
);
CREATE INDEX market_history_character_idx ON market_history (character_id, id DESC);
-- Reference prices: the sales of the last days, by item.
CREATE INDEX market_history_item_idx ON market_history (item_id, at) WHERE side = 1;

-- The highest offer and mail item ids ever issued (one row), and the last transfer
-- written: transfer ids grow (the loop continues from transfer_high after a restart) and
-- the persistence goroutine writes them in order, so a retry of a transfer whose COMMIT
-- went through but whose answer was lost finds its id already taken and applies nothing.
CREATE TABLE market_id_high (
    one           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (one),
    offer_high    BIGINT NOT NULL CHECK (offer_high >= 0),
    mail_high     BIGINT NOT NULL CHECK (mail_high >= 0),
    transfer_high BIGINT NOT NULL DEFAULT 0 CHECK (transfer_high >= 0)
);
INSERT INTO market_id_high (offer_high, mail_high) VALUES (0, 0);

-- +goose Down
DROP TABLE market_id_high;
DROP TABLE market_history;
DROP TABLE market_mail_gold;
DROP TABLE market_mail_items;
DROP TABLE market_offers;
