-- Guilds (T5.1). The game loop decides; these only load and apply its changes.

-- name: ListGuilds :many
SELECT id, name, motd, created_at FROM guilds ORDER BY id;

-- name: ListGuildMembers :many
SELECT m.guild_id, m.character_id, c.name, c.vocation, c.level, m.rank, m.joined_at
FROM guild_members m
JOIN characters c ON c.id = m.character_id
ORDER BY m.guild_id, m.rank DESC, m.joined_at, m.character_id;

-- name: DeleteExpiredGuildInvites :exec
DELETE FROM guild_invites WHERE expires_at <= sqlc.arg(now);

-- name: ListGuildInvites :many
SELECT i.guild_id, i.character_id, c.name, i.expires_at
FROM guild_invites i
JOIN characters c ON c.id = i.character_id
ORDER BY i.guild_id, i.created_at, i.character_id;

-- name: GuildIDHigh :one
-- The highest guild id ever issued (0 before the first founding).
SELECT high FROM guild_id_high;

-- name: RaiseGuildIDHigh :exec
UPDATE guild_id_high SET high = GREATEST(high, sqlc.arg(id)::bigint);

-- name: InsertGuild :exec
INSERT INTO guilds (id, name, created_at) VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(created_at));

-- name: RenameGuild :execrows
UPDATE guilds SET name = sqlc.arg(name) WHERE id = sqlc.arg(id);

-- name: SetGuildMotd :execrows
UPDATE guilds SET motd = sqlc.arg(motd) WHERE id = sqlc.arg(id);

-- name: DeleteGuild :execrows
DELETE FROM guilds WHERE id = sqlc.arg(id);

-- name: InsertGuildMember :exec
INSERT INTO guild_members (character_id, guild_id, rank, joined_at)
VALUES (sqlc.arg(character_id), sqlc.arg(guild_id), sqlc.arg(rank), sqlc.arg(joined_at));

-- name: SetGuildMemberRank :execrows
UPDATE guild_members SET rank = sqlc.arg(rank)
WHERE guild_id = sqlc.arg(guild_id) AND character_id = sqlc.arg(character_id);

-- name: DeleteGuildMember :execrows
DELETE FROM guild_members WHERE guild_id = sqlc.arg(guild_id) AND character_id = sqlc.arg(character_id);

-- name: UpsertGuildInvite :exec
INSERT INTO guild_invites (guild_id, character_id, invited_by, created_at, expires_at)
VALUES (sqlc.arg(guild_id), sqlc.arg(character_id), sqlc.narg(invited_by), sqlc.arg(created_at), sqlc.arg(expires_at))
ON CONFLICT (guild_id, character_id)
DO UPDATE SET invited_by = EXCLUDED.invited_by, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at;

-- name: DeleteGuildInvite :exec
DELETE FROM guild_invites WHERE guild_id = sqlc.arg(guild_id) AND character_id = sqlc.arg(character_id);

-- name: DeleteCharacterGuildInvites :exec
DELETE FROM guild_invites WHERE character_id = sqlc.arg(character_id);

-- Guild wars (T5.2).

-- name: GuildWarHigh :one
-- The highest war id ever issued (0 before the first declaration).
SELECT war_high FROM guild_id_high;

-- name: ListOpenGuildWars :many
-- Declared and active wars (ended ones are history: the loop does not load them).
SELECT id, guild_id, enemy_id, state, declared_at, started_at, expires_at, kill_limit,
       guild_kills, enemy_kills
FROM guild_wars
WHERE state < 3
ORDER BY id;

-- name: InsertGuildWar :exec
INSERT INTO guild_wars (id, guild_id, enemy_id, state, declared_at, expires_at, kill_limit)
VALUES (sqlc.arg(id), sqlc.arg(guild_id), sqlc.arg(enemy_id), 1, sqlc.arg(declared_at), sqlc.arg(expires_at),
        sqlc.arg(kill_limit));

-- name: RaiseGuildWarHigh :exec
UPDATE guild_id_high SET war_high = GREATEST(war_high, sqlc.arg(id)::bigint);

-- name: StartGuildWar :execrows
UPDATE guild_wars SET state = 2, started_at = sqlc.arg(started_at), expires_at = sqlc.arg(expires_at)
WHERE id = sqlc.arg(id) AND state = 1;

-- name: SetGuildWarKills :execrows
UPDATE guild_wars SET guild_kills = sqlc.arg(guild_kills), enemy_kills = sqlc.arg(enemy_kills)
WHERE id = sqlc.arg(id) AND state = 2;

-- name: EndGuildWar :execrows
UPDATE guild_wars SET state = 3, ended_at = sqlc.arg(ended_at), end_reason = sqlc.arg(end_reason),
       winner_id = sqlc.narg(winner_id)
WHERE id = sqlc.arg(id) AND state < 3;

-- Public website (T5.1, /api/guilds): no private data, only names, ranks, vocation and
-- level (as on the highscores).

-- name: PublicGuilds :many
-- Every guild with its listed member count and leader, by name. Bounded by max_rows. Like
-- the highscores (T4.3), characters of staff, disabled or banned accounts are not shown:
-- they do not count and a hidden leader shows as "".
SELECT g.id, g.name, g.created_at,
       (SELECT count(*) FROM guild_members m JOIN characters c ON c.id = m.character_id
        JOIN accounts a ON a.id = c.account_id
        WHERE m.guild_id = g.id AND a.role = 'player' AND a.disabled_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM account_bans b WHERE b.account_id = a.id AND b.lifted_at IS NULL
                          AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))))::int AS members,
       COALESCE((SELECT c.name FROM guild_members m JOIN characters c ON c.id = m.character_id
                 JOIN accounts a ON a.id = c.account_id
                 WHERE m.guild_id = g.id AND m.rank = 3 AND a.role = 'player' AND a.disabled_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM account_bans b WHERE b.account_id = a.id AND b.lifted_at IS NULL
                          AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now)))), '')::text AS leader
FROM guilds g
ORDER BY lower(g.name)
LIMIT sqlc.arg(max_rows);

-- name: PublicGuild :one
SELECT id, name, created_at FROM guilds WHERE id = sqlc.arg(id);

-- name: PublicGuildMembers :many
-- The same exclusions as PublicGuilds.
SELECT c.name, c.vocation, c.level, m.rank
FROM guild_members m
JOIN characters c ON c.id = m.character_id
JOIN accounts a ON a.id = c.account_id
WHERE m.guild_id = sqlc.arg(guild_id) AND a.role = 'player' AND a.disabled_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM account_bans b WHERE b.account_id = a.id AND b.lifted_at IS NULL
                  AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now)))
ORDER BY m.rank DESC, m.joined_at, c.name;
