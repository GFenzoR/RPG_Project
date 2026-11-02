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
