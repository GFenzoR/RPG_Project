-- +goose Up
-- Conditions that survive a logout (T3.2, docs/02-game-design.md "Condiciones"): a JSON
-- list of {id, left_ms, ticks, damage}, replaced by every save of the character.
ALTER TABLE characters
    ADD COLUMN conditions JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(conditions) = 'array');

-- +goose Down
ALTER TABLE characters DROP COLUMN conditions;
