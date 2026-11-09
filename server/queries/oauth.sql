-- name: CreateOAuthState :exec
INSERT INTO oauth_states (state_hash, binding_hash, provider, verifier, nonce, mode,
                          account_id, session_hash, return_to, expires_at)
VALUES (sqlc.arg(state_hash), sqlc.arg(binding_hash), sqlc.arg(provider), sqlc.arg(verifier),
        sqlc.arg(nonce), sqlc.arg(mode), sqlc.narg(account_id), sqlc.narg(session_hash),
        sqlc.arg(return_to), sqlc.arg(expires_at));

-- name: ConsumeOAuthState :one
-- Single use: the row is deleted whether or not the rest of the callback works.
DELETE FROM oauth_states
WHERE state_hash = sqlc.arg(state_hash) AND expires_at > sqlc.arg(now)
RETURNING binding_hash, provider, verifier, nonce, mode, account_id, session_hash, return_to;

-- name: DeleteExpiredOAuth :one
WITH s AS (DELETE FROM oauth_states WHERE oauth_states.expires_at <= sqlc.arg(now) RETURNING 1),
     p AS (DELETE FROM oauth_pending WHERE oauth_pending.expires_at <= sqlc.arg(now) RETURNING 1)
SELECT ((SELECT count(*) FROM s) + (SELECT count(*) FROM p))::bigint AS deleted;

-- name: GetIdentity :one
SELECT account_id FROM account_identities
WHERE provider = sqlc.arg(provider) AND subject = sqlc.arg(subject);

-- name: InsertIdentity :exec
INSERT INTO account_identities (provider, subject, account_id, email, email_verified, created_at)
VALUES (sqlc.arg(provider), sqlc.arg(subject), sqlc.arg(account_id), sqlc.arg(email),
        sqlc.arg(email_verified), sqlc.arg(created_at));

-- name: ListIdentities :many
SELECT provider, email, created_at FROM account_identities
WHERE account_id = sqlc.arg(account_id)
ORDER BY provider;

-- name: CountIdentities :one
SELECT count(*) FROM account_identities WHERE account_id = sqlc.arg(account_id);

-- name: DeleteIdentity :execrows
DELETE FROM account_identities
WHERE account_id = sqlc.arg(account_id) AND provider = sqlc.arg(provider);

-- name: CreateOAuthAccount :one
-- An account without a password (it logs in with its identity).
INSERT INTO accounts (email, password_hash, email_verified_at)
VALUES (sqlc.arg(email), NULL, sqlc.narg(email_verified_at))
RETURNING id;

-- name: CreateOAuthPending :exec
INSERT INTO oauth_pending (token_hash, provider, subject, email, email_verified, return_to, expires_at)
VALUES (sqlc.arg(token_hash), sqlc.arg(provider), sqlc.arg(subject), sqlc.arg(email),
        sqlc.arg(email_verified), sqlc.arg(return_to), sqlc.arg(expires_at));

-- name: GetOAuthPending :one
SELECT provider, subject, email, email_verified, return_to FROM oauth_pending
WHERE token_hash = sqlc.arg(token_hash) AND expires_at > sqlc.arg(now);

-- name: DeleteOAuthPending :execrows
DELETE FROM oauth_pending WHERE token_hash = sqlc.arg(token_hash);

-- name: LockAccountForIdentities :one
-- Serializes changes to an account's login methods (unlinking the last one).
SELECT id, password_hash FROM accounts WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: DeleteUnprovenIdentities :execrows
-- After a password reset (the mailbox owner is in control): identities that never proved
-- the account's email go, so one linked by whoever squatted the address cannot stay.
DELETE FROM account_identities
WHERE account_id = sqlc.arg(account_id)
  AND (NOT email_verified OR email <> sqlc.arg(email));

-- name: DeleteAccountOAuthStates :exec
-- Cancels the account's links in flight (password reset, ban, role change).
DELETE FROM oauth_states WHERE account_id = sqlc.arg(account_id);
