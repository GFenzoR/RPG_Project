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
