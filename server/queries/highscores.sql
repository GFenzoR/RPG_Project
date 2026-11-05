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

-- name: HighscoresBySkill :many
-- A character without a row for the skill is at its base level (data/balance.yaml), which
-- the caller passes as base_level.
SELECT c.name, c.vocation, COALESCE(s.level, sqlc.arg(base_level)::int)::bigint AS value
FROM characters c
JOIN accounts a ON a.id = c.account_id
LEFT JOIN character_skills s ON s.character_id = c.id AND s.skill = sqlc.arg(skill)
WHERE a.role = 'player' AND a.disabled_at IS NULL
  AND (sqlc.narg(vocation)::text IS NULL OR c.vocation = sqlc.narg(vocation)::text)
  AND NOT EXISTS (
      SELECT 1 FROM account_bans b
      WHERE b.account_id = a.id AND b.lifted_at IS NULL
        AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
  )
ORDER BY COALESCE(s.level, sqlc.arg(base_level)::int) DESC, COALESCE(s.tries, 0) DESC, c.id
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);
