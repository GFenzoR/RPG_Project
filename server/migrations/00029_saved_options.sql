-- +goose Up
-- Owner decision 2026-11-26: every option the player picks is saved.
-- The game options of a character (docs/02 "Opciones guardadas"): the fight stance (the
-- protocol's FightStance: 1 offensive, 2 balanced, 3 defensive), chasing the target and
-- the PvP safe mode. The defaults are the ones a character had before they were saved.
ALTER TABLE characters
    ADD COLUMN opt_stance SMALLINT NOT NULL DEFAULT 2 CHECK (opt_stance BETWEEN 1 AND 3),
    ADD COLUMN opt_chase  BOOLEAN  NOT NULL DEFAULT false,
    ADD COLUMN opt_safe   BOOLEAN  NOT NULL DEFAULT true;

-- The interface options of an account (docs/05 "Opciones de la cuenta"): one small JSON
-- document the server validates and rewrites in canonical form before storing it (never
-- the bytes the client sent). 16 KiB at most, like the API.
CREATE TABLE account_options (
    account_id BIGINT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
    doc        JSONB NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND pg_column_size(doc) <= 32768),
    updated_at TIMESTAMPTZ NOT NULL
);

-- +goose Down
DROP TABLE account_options;
ALTER TABLE characters
    DROP COLUMN opt_safe,
    DROP COLUMN opt_chase,
    DROP COLUMN opt_stance;
