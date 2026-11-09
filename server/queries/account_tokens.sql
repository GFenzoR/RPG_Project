-- name: CreateAccountToken :exec
INSERT INTO account_tokens (token_hash, account_id, purpose, email, created_at, expires_at)
VALUES (sqlc.arg(token_hash), sqlc.arg(account_id), sqlc.arg(purpose), sqlc.arg(email),
        sqlc.arg(created_at), sqlc.arg(expires_at));

-- name: DeleteAccountTokens :exec
-- Drops every token of one purpose of an account (a new link replaces the old ones).
DELETE FROM account_tokens
WHERE account_id = sqlc.arg(account_id) AND purpose = sqlc.arg(purpose);

-- name: ConsumeAccountToken :one
-- Deletes a token and returns it if it was still valid: tokens are single-use.
DELETE FROM account_tokens
WHERE token_hash = sqlc.arg(token_hash)
  AND purpose = sqlc.arg(purpose)
  AND expires_at > sqlc.arg(now)
RETURNING account_id, email;

-- name: DeleteExpiredAccountTokens :execrows
DELETE FROM account_tokens WHERE expires_at <= sqlc.arg(now);

-- name: MarkEmailVerified :execrows
-- Only verifies the address the link was sent to.
UPDATE accounts SET email_verified_at = sqlc.arg(at)
WHERE id = sqlc.arg(id) AND email = sqlc.arg(email) AND email_verified_at IS NULL;

-- name: SetPasswordHash :exec
UPDATE accounts SET password_hash = sqlc.arg(password_hash) WHERE id = sqlc.arg(id);

-- name: GetAccountProfile :one
SELECT id, email, password_hash, email_verified_at, locale, disabled_at
FROM accounts
WHERE id = sqlc.arg(id);

-- name: SetAccountLocale :exec
UPDATE accounts SET locale = sqlc.arg(locale) WHERE id = sqlc.arg(id);

-- name: GetAccountProfileByEmail :one
SELECT id, email, password_hash, email_verified_at, locale, disabled_at
FROM accounts
WHERE email = sqlc.arg(email);
