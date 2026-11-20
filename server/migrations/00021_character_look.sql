-- +goose Up
-- The body of a character (docs/02 "Apariencia", docs/06 "Looks"): ids of data/looks.yaml
-- chosen when it is created and changed for free in the game (SetLook). '' = no look yet:
-- every character created before this migration. The server never trusts what is here:
-- a value that is empty or not a player's choice of data/looks.yaml is replaced at login
-- by the look picked from the character's id (content.DefaultLook, always the same for
-- the same id), which the next save writes here. So existing characters get their look
-- from their id deterministically, and a choice removed from data/ later falls back the
-- same way.
ALTER TABLE characters
    ADD COLUMN look_body       TEXT NOT NULL DEFAULT '' CHECK (length(look_body) <= 32),
    ADD COLUMN look_skin       TEXT NOT NULL DEFAULT '' CHECK (length(look_skin) <= 32),
    ADD COLUMN look_hair       TEXT NOT NULL DEFAULT '' CHECK (length(look_hair) <= 32),
    ADD COLUMN look_hair_color TEXT NOT NULL DEFAULT '' CHECK (length(look_hair_color) <= 32),
    ADD COLUMN look_beard      TEXT NOT NULL DEFAULT '' CHECK (length(look_beard) <= 32);

-- +goose Down
ALTER TABLE characters
    DROP COLUMN look_body,
    DROP COLUMN look_skin,
    DROP COLUMN look_hair,
    DROP COLUMN look_hair_color,
    DROP COLUMN look_beard;
