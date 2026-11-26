-- name: CreateAccount :one
INSERT INTO accounts (email, password_hash)
VALUES (sqlc.arg(email), sqlc.arg(password_hash))
RETURNING id, created_at;

-- name: GetAccountByEmail :one
SELECT id, email, password_hash, disabled_at
FROM accounts
WHERE email = sqlc.arg(email);

-- name: LockAccount :one
-- Serializes per-account writes (e.g. character creation vs. the per-account limit).
SELECT id, disabled_at
FROM accounts
WHERE id = sqlc.arg(id)
FOR UPDATE;

-- name: TouchAccountLogin :exec
UPDATE accounts SET last_login_at = sqlc.arg(at) WHERE id = sqlc.arg(id);

-- name: GetAccountOptions :one
-- The interface options of an account (migration 00029); no row: it never saved any.
SELECT doc FROM account_options WHERE account_id = sqlc.arg(account_id);

-- name: SaveAccountOptions :exec
INSERT INTO account_options (account_id, doc, updated_at)
VALUES (sqlc.arg(account_id), sqlc.arg(doc), sqlc.arg(updated_at))
ON CONFLICT (account_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at;
