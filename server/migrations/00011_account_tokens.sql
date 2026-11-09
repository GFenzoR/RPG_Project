-- +goose Up
-- Email verification and password reset (T2.1, docs/01-architecture.md "Cuentas"). A
-- link carries a random single-use token; only its SHA-256 is stored, so a database
-- leak gives no usable link. Using a token deletes its row; issuing a new one of the
-- same purpose deletes the older ones, so only the latest link works.
CREATE TABLE account_tokens (
    token_hash BYTEA       PRIMARY KEY CHECK (length(token_hash) = 32),
    account_id BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    purpose    TEXT        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
    -- The address the link was sent to: a verification only verifies that address, so a
    -- later email change (if it ever exists) cannot be verified with an old link.
    email      TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at)
);
CREATE INDEX account_tokens_account_idx ON account_tokens (account_id, purpose);
CREATE INDEX account_tokens_expires_idx ON account_tokens (expires_at);

-- Language of the account's emails ('' = not chosen yet: the server's default). Taken
-- from the request that created the account or asked for the email.
ALTER TABLE accounts ADD COLUMN locale TEXT NOT NULL DEFAULT '' CHECK (length(locale) <= 8);

-- +goose Down
ALTER TABLE accounts DROP COLUMN locale;
DROP TABLE account_tokens;
