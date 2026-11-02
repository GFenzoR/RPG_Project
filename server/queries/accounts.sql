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
