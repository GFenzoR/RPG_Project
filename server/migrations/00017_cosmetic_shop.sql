-- +goose Up
-- Cosmetic shop with a payment gateway (T5.7, docs/02 "Tienda cosmética", docs/01
-- "Pagos"). The premium currency belongs to the account, is never traded, never goes
-- through the market and never turns into gold. Every change of a balance is one row of
-- premium_ledger written in the same transaction as the balance.

-- Premium balance of the account (never negative: a refund larger than the balance
-- debits what there is and flags the account, see premium_ledger.shortfall).
ALTER TABLE accounts
    ADD COLUMN premium_balance BIGINT NOT NULL DEFAULT 0 CHECK (premium_balance >= 0),
    -- Set when a refund or chargeback could not be fully debited (or by staff): a
    -- flagged account cannot buy packs nor cosmetics until staff clears it.
    ADD COLUMN shop_flagged_at TIMESTAMPTZ;

-- Equipped cosmetics of the character, one per kind (content ids of data/cosmetics.yaml;
-- '' = default look). characters.outfit (00001) is the outfit slot.
ALTER TABLE characters
    ADD COLUMN outfit_color TEXT NOT NULL DEFAULT '' CHECK (length(outfit_color) <= 64),
    ADD COLUMN name_effect  TEXT NOT NULL DEFAULT '' CHECK (length(name_effect) <= 64);

-- Payment provider notifications already processed: (provider, event_id) is the
-- idempotency key, so a retried or duplicated webhook never credits twice. event_id is
-- the provider's payment id plus the state it confirmed (payments.Event.ID; a partial
-- refund also carries the refunded amount, so each new refunded amount is one event).
-- Every event of a payment carries the same signed account id, and store.ApplyPayment
-- locks that account row before reading or writing anything of the payment: the events
-- of one payment are applied one after the other, never interleaved.
CREATE TABLE payment_events (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider       TEXT        NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
    event_id       TEXT        NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
    -- paid; refunded (refunded_minor = 0: the whole payment, else that much of it);
    -- chargeback; dispute (in mediation: the account is flagged, nothing is debited).
    type           TEXT        NOT NULL CHECK (type IN ('paid', 'refunded', 'chargeback', 'dispute')),
    payment_id     TEXT        NOT NULL CHECK (length(payment_id) BETWEEN 1 AND 200),
    -- 0 for an unmatched payment whose reference could not be verified.
    account_id     BIGINT      NOT NULL,
    pack_id        TEXT        NOT NULL,
    -- Real money confirmed by the provider, in the minor unit of currency.
    amount_minor   BIGINT      NOT NULL,
    currency       TEXT        NOT NULL DEFAULT '',
    -- A partial refund: the total refunded so far, in the same minor unit.
    refunded_minor BIGINT      NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
    -- What processing did: credited, debited, ignored (nothing to do), flagged (a
    -- dispute), pending_reversal (a refund or chargeback of a payment not credited yet:
    -- the credit, when it arrives, is reversed at once; it then becomes debited) or
    -- unmatched (an approved payment that could not be credited: bad reference, unknown
    -- currency or pack, amount mismatch; staff reconciles it, see note).
    result         TEXT        NOT NULL,
    -- Why an event is unmatched (a fixed code, never provider text).
    note           TEXT        NOT NULL DEFAULT '' CHECK (length(note) <= 64),
    received_at    TIMESTAMPTZ NOT NULL,
    processed_at   TIMESTAMPTZ NOT NULL,
    UNIQUE (provider, event_id)
);
CREATE INDEX payment_events_payment_idx ON payment_events (provider, payment_id);
-- Staff reconciliation: the approved payments nobody was credited for.
CREATE INDEX payment_events_unmatched_idx ON payment_events (received_at) WHERE result = 'unmatched';

-- Append-only audit log of every premium balance change (like economy_log). Account ids
-- are not foreign keys: the log must survive the deletion of the account.
CREATE TABLE premium_ledger (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at               TIMESTAMPTZ NOT NULL,
    account_id       BIGINT      NOT NULL,
    -- pack: currency bought with money; purchase: a cosmetic bought with currency;
    -- refund / chargeback: the provider reversed a pack; grant: staff (+ or -).
    reason           TEXT        NOT NULL CHECK (reason IN ('pack', 'purchase', 'refund', 'chargeback', 'grant')),
    delta            BIGINT      NOT NULL,
    balance_after    BIGINT      NOT NULL CHECK (balance_after >= 0),
    -- Refund/chargeback: the part of the pack that could not be debited (the balance was
    -- already spent). > 0 flags the account.
    shortfall        BIGINT      NOT NULL DEFAULT 0 CHECK (shortfall >= 0),
    cosmetic_id      TEXT,
    pack_id          TEXT,
    provider         TEXT,
    payment_id       TEXT,
    -- Staff grants: who (account and character name) and why.
    actor_account_id BIGINT,
    actor_name       TEXT,
    note             TEXT        NOT NULL DEFAULT '' CHECK (length(note) <= 200)
);
CREATE INDEX premium_ledger_account_idx ON premium_ledger (account_id, at);
CREATE INDEX premium_ledger_payment_idx ON premium_ledger (provider, payment_id) WHERE payment_id IS NOT NULL;

-- +goose StatementBegin
CREATE FUNCTION premium_ledger_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'premium_ledger is append-only';
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER premium_ledger_no_update_delete
    BEFORE UPDATE OR DELETE ON premium_ledger
    FOR EACH ROW EXECUTE FUNCTION premium_ledger_append_only();
CREATE TRIGGER premium_ledger_no_truncate
    BEFORE TRUNCATE ON premium_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION premium_ledger_append_only();

-- The catalog is synced from data/cosmetics.yaml at every start (upsert): a cosmetic
-- removed from the file stays here (accounts may own it) but is no longer sold.
ALTER TABLE cosmetics
    ADD COLUMN on_sale BOOLEAN NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE cosmetics DROP COLUMN on_sale;
DROP TABLE premium_ledger;
DROP FUNCTION premium_ledger_append_only();
DROP TABLE payment_events;
ALTER TABLE characters DROP COLUMN name_effect, DROP COLUMN outfit_color;
ALTER TABLE accounts DROP COLUMN shop_flagged_at, DROP COLUMN premium_balance;
