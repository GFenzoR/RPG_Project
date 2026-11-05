-- +goose Up
-- Highscores (T4.3, queries/highscores.sql). Each ranking reads characters in index order
-- and stops after the requested page, so a page never sorts every character:
--   - the level ranking walks characters_highscore_level_idx;
--   - a skill ranking walks character_skills_highscore_idx for the characters with a row
--     for that skill, then the characters primary key for those still at the base level.
CREATE INDEX characters_highscore_level_idx ON characters (level DESC, experience DESC, id);
CREATE INDEX character_skills_highscore_idx ON character_skills (skill, level DESC, tries DESC, character_id);

-- +goose Down
DROP INDEX character_skills_highscore_idx;
DROP INDEX characters_highscore_level_idx;
