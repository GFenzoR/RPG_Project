-- name: CreateSession :exec
INSERT INTO sessions (token_hash, account_id, kind, character_id, created_at, last_seen_at, expires_at)
VALUES (sqlc.arg(token_hash), sqlc.arg(account_id), sqlc.arg(kind),
        sqlc.narg(character_id), sqlc.arg(created_at), sqlc.arg(created_at), sqlc.arg(expires_at));

-- name: GetActiveSession :one
-- The caller passes "now" (injected clock) so expiry is testable. A banned account has
-- no active session (T2.6).
SELECT s.account_id, s.character_id, s.created_at, s.last_seen_at, s.expires_at
FROM sessions s
JOIN accounts a ON a.id = s.account_id
WHERE s.token_hash = sqlc.arg(token_hash)
  AND s.kind = sqlc.arg(kind)
  AND s.expires_at > sqlc.arg(now)
  AND a.disabled_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM account_bans b
      WHERE b.account_id = a.id AND b.lifted_at IS NULL
        AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
  );

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = sqlc.arg(token_hash);

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at <= sqlc.arg(now);

-- name: ConsumeSession :one
-- Deletes a token and returns it if it was active: play tokens are single-use.
DELETE FROM sessions s
USING accounts a
WHERE s.token_hash = sqlc.arg(token_hash)
  AND s.kind = sqlc.arg(kind)
  AND s.expires_at > sqlc.arg(now)
  AND a.id = s.account_id
  AND a.disabled_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM account_bans b
      WHERE b.account_id = a.id AND b.lifted_at IS NULL
        AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))
  )
RETURNING s.account_id, s.character_id, s.expires_at;

-- name: TouchSession :exec
-- Records authenticated activity (the idle timeout slides). Never moves backwards.
UPDATE sessions SET last_seen_at = sqlc.arg(now)
WHERE token_hash = sqlc.arg(token_hash) AND last_seen_at < sqlc.arg(now);

-- name: DeleteIdleSessions :execrows
-- Account sessions without authenticated activity since before (lote 17 idle timeout).
DELETE FROM sessions WHERE kind = 'account' AND last_seen_at <= sqlc.arg(before);

-- name: DeleteOtherAccountSessions :execrows
-- Revokes every token of an account but keep (a password change keeps its own session).
DELETE FROM sessions
WHERE account_id = sqlc.arg(account_id) AND token_hash <> sqlc.arg(keep);

-- name: LockAccountSession :one
-- The account session a password change keeps, locked for the change's transaction: a
-- "sign out everywhere" that deleted it first makes the change fail; one that comes
-- after waits for the change and then deletes it too.
SELECT token_hash FROM sessions
WHERE token_hash = sqlc.arg(token_hash) AND account_id = sqlc.arg(account_id) AND kind = 'account'
FOR UPDATE;
