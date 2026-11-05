-- Highscores (T4.3, GET /api/highscores). Only players' characters are ranked: staff
-- (gm/admin), disabled accounts and accounts with an active ban are left out. Ties keep
-- the older character first. A page is limit rows from offset; callers ask for one more
-- row than they show to know whether there is a next page.

-- name: HighscoresByLevel :many
SELECT c.name, c.vocation, c.level::bigint AS value
FROM characters c
JOIN accounts a ON a.id = c.account_id
WHERE a.role = 'player' AND a.disabled_at IS NULL
  AND (sqlc.narg(vocation)::text IS NULL OR c.vocation = sqlc.narg(vocation)::text)
  AND NOT EXISTS (
      SELECT 1 FROM account_bans b
      WHERE b.account_id = a.id AND b.lifted_at IS NULL
        AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
  )
ORDER BY c.level DESC, c.experience DESC, c.id
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- A skill ranking is two ordered parts (store.Highscores joins them):
--   1. characters with a row for the skill, in the order of character_skills_highscore_idx
--      (skill, level DESC, tries DESC, character_id): HighscoresBySkillRows;
--   2. after them, characters without a row, at the base level of data/balance.yaml,
--      oldest first: HighscoresBySkillBase, only when part 1 does not fill the page.
-- Skill rows are never stored below the base level, so a character with a row ranks at
-- least as high as one without (a row at exactly the base level with 0 tries ties with
-- them and is listed first). Neither query sorts every character.

-- name: HighscoresBySkillRows :many
SELECT c.name, c.vocation, s.level::bigint AS value
FROM character_skills s
JOIN characters c ON c.id = s.character_id
JOIN accounts a ON a.id = c.account_id
WHERE s.skill = sqlc.arg(skill)
  AND a.role = 'player' AND a.disabled_at IS NULL
  AND (sqlc.narg(vocation)::text IS NULL OR c.vocation = sqlc.narg(vocation)::text)
  AND NOT EXISTS (
      SELECT 1 FROM account_bans b
      WHERE b.account_id = a.id AND b.lifted_at IS NULL
        AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
  )
ORDER BY s.level DESC, s.tries DESC, s.character_id
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: HighscoresBySkillBase :many
SELECT c.name, c.vocation
FROM characters c
JOIN accounts a ON a.id = c.account_id
WHERE NOT EXISTS (
      SELECT 1 FROM character_skills s
      WHERE s.character_id = c.id AND s.skill = sqlc.arg(skill)
  )
  AND a.role = 'player' AND a.disabled_at IS NULL
  AND (sqlc.narg(vocation)::text IS NULL OR c.vocation = sqlc.narg(vocation)::text)
  AND NOT EXISTS (
      SELECT 1 FROM account_bans b
      WHERE b.account_id = a.id AND b.lifted_at IS NULL
        AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
  )
ORDER BY c.id
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);
