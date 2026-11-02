-- name: CreateSession :exec
INSERT INTO sessions (token_hash, account_id, kind, character_id, created_at, expires_at)
VALUES (sqlc.arg(token_hash), sqlc.arg(account_id), sqlc.arg(kind),
        sqlc.narg(character_id), sqlc.arg(created_at), sqlc.arg(expires_at));

-- name: GetActiveSession :one
-- The caller passes "now" (injected clock) so expiry is testable.
SELECT s.account_id, s.character_id, s.expires_at
FROM sessions s
JOIN accounts a ON a.id = s.account_id
WHERE s.token_hash = sqlc.arg(token_hash)
  AND s.kind = sqlc.arg(kind)
  AND s.expires_at > sqlc.arg(now)
  AND a.disabled_at IS NULL;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = sqlc.arg(token_hash);

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at <= sqlc.arg(now);
