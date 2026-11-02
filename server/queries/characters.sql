-- name: ListCharactersByAccount :many
SELECT id, name, vocation, level
FROM characters
WHERE account_id = sqlc.arg(account_id)
ORDER BY id;

-- name: CountCharactersByAccount :one
SELECT count(*) FROM characters WHERE account_id = sqlc.arg(account_id);

-- name: CreateCharacter :one
INSERT INTO characters (account_id, name, vocation, health, mana)
VALUES (sqlc.arg(account_id), sqlc.arg(name), sqlc.arg(vocation), sqlc.arg(health), sqlc.arg(mana))
RETURNING id, name, vocation, level;

-- name: GetCharacterForPlay :one
-- Loads what the game server needs to put a character in the world.
SELECT id, account_id, name, vocation, level, experience, health, mana,
       pos_x, pos_y, pos_z, town
FROM characters
WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id);

-- name: CharacterBelongsToAccount :one
SELECT EXISTS (
    SELECT 1 FROM characters WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id)
);

-- name: TouchCharacterLogin :exec
UPDATE characters SET last_login_at = sqlc.arg(at) WHERE id = sqlc.arg(id);

-- name: SaveCharacterState :execrows
-- Written by the persistence goroutine from an immutable snapshot of the game loop.
UPDATE characters
SET level        = sqlc.arg(level),
    experience   = sqlc.arg(experience),
    health       = sqlc.arg(health),
    mana         = sqlc.arg(mana),
    pos_x        = sqlc.arg(pos_x),
    pos_y        = sqlc.arg(pos_y),
    pos_z        = sqlc.arg(pos_z),
    last_save_at = sqlc.arg(saved_at)
WHERE id = sqlc.arg(id);

-- name: GetCharacterSkills :many
-- Skills without a row are at their base level (data/balance.yaml).
SELECT skill, level, tries
FROM character_skills
WHERE character_id = sqlc.arg(character_id)
ORDER BY skill;

-- name: SaveCharacterSkills :exec
-- Upserts every skill of a snapshot in one statement (parallel arrays).
INSERT INTO character_skills (character_id, skill, level, tries)
SELECT sqlc.arg(character_id)::bigint, unnest(sqlc.arg(skills)::text[]),
       unnest(sqlc.arg(levels)::int[]), unnest(sqlc.arg(tries)::bigint[])
ON CONFLICT (character_id, skill)
DO UPDATE SET level = EXCLUDED.level, tries = EXCLUDED.tries;

-- name: GetCharacterInventory :many
-- Every item of a character; the server rebuilds the tree from container_id.
SELECT id, container_id, slot, item_id, count
FROM inventory_items
WHERE character_id = sqlc.arg(character_id)
ORDER BY container_id NULLS FIRST, slot;

-- name: DeleteCharacterInventory :exec
-- A snapshot replaces the whole inventory in the same transaction as the character row.
DELETE FROM inventory_items WHERE character_id = sqlc.arg(character_id);

-- name: InsertInventoryItem :one
INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
VALUES (sqlc.arg(character_id), sqlc.narg(container_id), sqlc.arg(slot), sqlc.arg(item_id), sqlc.arg(count))
RETURNING id;
