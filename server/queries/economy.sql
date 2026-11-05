-- name: InsertEconomy :copyfrom
-- Economy log batches (T4.1), written by the persistence goroutine.
INSERT INTO economy_log (at, kind, character_id, other_character_id, item_id, count, amount, details)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: ListEconomy :many
-- Newest entries of a character first (tests and the operator).
SELECT id, at, kind, character_id, other_character_id, item_id, count, amount, details
FROM economy_log
WHERE character_id = sqlc.arg(character_id)
ORDER BY id DESC
LIMIT sqlc.arg(max_rows);
