-- +goose Up
-- The sex of a character (docs/02 "Apariencia", docs/06 "Looks"): an id of data/looks.yaml
-- `sexes` (male, female), chosen when it is created and changed for free in the game
-- (SetLook) like the rest of the look. '' = none yet: every character created before this
-- migration. As with 00021, the server never trusts what is here: at login a look whose
-- only fault is an empty or unknown sex keeps its other fields and takes the sex picked
-- from the character's id (content.Looks.SavedLook, always the same for the same id; the
-- other fields of that pick are the ones they were before the sex existed), and the next
-- save writes it here. So existing characters get their sex from their id
-- deterministically, and the player changes it for free in Apariencia.
ALTER TABLE characters
    ADD COLUMN look_sex TEXT NOT NULL DEFAULT '' CHECK (length(look_sex) <= 32);

-- +goose Down
ALTER TABLE characters
    DROP COLUMN look_sex;
