-- name: ListEconomy :many
-- Newest entries of a character first (tests and the operator).
SELECT id, at, kind, character_id, other_character_id, item_id, count, amount, details
FROM economy_log
WHERE character_id = sqlc.arg(character_id)
ORDER BY id DESC
LIMIT sqlc.arg(max_rows);
