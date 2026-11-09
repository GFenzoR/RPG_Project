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

-- Public website (T5.1, /api/guilds): no private data, only names, ranks, vocation and
-- level (as on the highscores).

-- name: PublicGuilds :many
-- Every guild with its member count and leader, by name. Bounded by max_rows.
SELECT g.id, g.name, g.created_at,
       (SELECT count(*) FROM guild_members m WHERE m.guild_id = g.id)::int AS members,
       COALESCE((SELECT c.name FROM guild_members m JOIN characters c ON c.id = m.character_id
                 WHERE m.guild_id = g.id AND m.rank = 3), '')::text AS leader
FROM guilds g
ORDER BY lower(g.name)
LIMIT sqlc.arg(max_rows);

-- name: PublicGuild :one
SELECT id, name, created_at FROM guilds WHERE id = sqlc.arg(id);

-- name: PublicGuildMembers :many
SELECT c.name, c.vocation, c.level, m.rank
FROM guild_members m
JOIN characters c ON c.id = m.character_id
WHERE m.guild_id = sqlc.arg(guild_id)
ORDER BY m.rank DESC, m.joined_at, c.name;
