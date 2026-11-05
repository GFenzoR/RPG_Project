-- +goose Up
-- Highscores (T4.3): the level ranking reads characters in this order and stops after one
-- page, so the top pages are an index scan instead of a sort of every character.
-- Skill rankings join character_skills by its primary key (character_id, skill).
CREATE INDEX characters_highscore_level_idx ON characters (level DESC, experience DESC, id);

-- +goose Down
DROP INDEX characters_highscore_level_idx;
