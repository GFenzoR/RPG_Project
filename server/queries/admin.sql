-- name: GetActiveBan :one
-- The ban that ends last among the account's active bans (a permanent one first).
SELECT id, reason, expires_at
FROM account_bans
WHERE account_id = sqlc.arg(account_id)
  AND lifted_at IS NULL
  AND (expires_at IS NULL OR expires_at > sqlc.arg(now))
ORDER BY expires_at DESC NULLS FIRST
LIMIT 1;

-- name: GetCharacterTarget :one
-- Resolves a character name (ignoring case) for a staff command.
SELECT c.id, c.account_id, c.name, a.role
FROM characters c
JOIN accounts a ON a.id = c.account_id
WHERE lower(c.name) = lower(sqlc.arg(name));

-- name: InsertBan :one
INSERT INTO account_bans (account_id, reason, banned_by, created_at, expires_at)
VALUES (sqlc.arg(account_id), sqlc.arg(reason), sqlc.narg(banned_by), sqlc.arg(created_at), sqlc.narg(expires_at))
RETURNING id;

-- name: LiftBans :execrows
-- Lifts every active ban of the account.
UPDATE account_bans
SET lifted_at = sqlc.arg(now), lifted_by = sqlc.narg(lifted_by)
WHERE account_id = sqlc.arg(account_id)
  AND lifted_at IS NULL
  AND (expires_at IS NULL OR expires_at > sqlc.arg(now));

-- name: DeleteAccountSessions :execrows
-- Revokes every token of an account (ban).
DELETE FROM sessions WHERE account_id = sqlc.arg(account_id);

-- name: InsertAudit :exec
INSERT INTO audit_log (at, source, actor_account_id, actor_character_id, actor_name, action,
                       target_account_id, target_character_id, target_name, args, result)
VALUES (sqlc.arg(at), sqlc.arg(source), sqlc.narg(actor_account_id), sqlc.narg(actor_character_id),
        sqlc.arg(actor_name), sqlc.arg(action), sqlc.narg(target_account_id),
        sqlc.narg(target_character_id), sqlc.arg(target_name), sqlc.arg(args), sqlc.arg(result));

-- name: ListAudit :many
-- Newest entries first (operator tool and tests).
SELECT id, at, source, actor_account_id, actor_character_id, actor_name, action,
       target_account_id, target_character_id, target_name, args, result
FROM audit_log
ORDER BY id DESC
LIMIT sqlc.arg(max_rows);

-- name: SetAccountRole :one
-- Sets the role of the account with that (normalized) email and returns the old one.
UPDATE accounts a
SET role = sqlc.arg(role)
FROM accounts old
WHERE a.email = sqlc.arg(email) AND old.id = a.id
RETURNING a.id, old.role AS old_role;

-- name: GetAccountRole :one
-- The actor's role now (not the one cached at login), for bans in the same transaction.
SELECT role FROM accounts WHERE id = sqlc.arg(id);
