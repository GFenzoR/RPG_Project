-- +goose Up
-- OAuth login with Google and Discord, and linked identities (T2.1 2/2,
-- docs/01-architecture.md "Cuentas").

-- One row per external identity linked to an account. (provider, subject) is the
-- identity; the email is only what the provider reported when it was linked, shown to
-- the account itself and never used to pick an account on its own.
CREATE TABLE account_identities (
    provider       TEXT        NOT NULL CHECK (provider IN ('google', 'discord')),
    subject        TEXT        NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    account_id     BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    email          TEXT        NOT NULL DEFAULT '' CHECK (length(email) <= 254),
    email_verified BOOLEAN     NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (provider, subject),
    -- At most one identity per provider and account.
    UNIQUE (account_id, provider)
);

-- A login or link in flight: created when the browser leaves for the provider, deleted
-- by the callback (single use). The state in the URL is looked up by its SHA-256, and
-- binding_hash is the SHA-256 of a random value in a short HttpOnly cookie, so a state
-- only works in the browser that started it (CSRF). The PKCE verifier and the OIDC nonce
-- are only useful together with the provider's code, for 10 minutes.
CREATE TABLE oauth_states (
    state_hash   BYTEA       PRIMARY KEY CHECK (length(state_hash) = 32),
    binding_hash BYTEA       NOT NULL CHECK (length(binding_hash) = 32),
    provider     TEXT        NOT NULL,
    verifier     TEXT        NOT NULL,
    nonce        TEXT        NOT NULL DEFAULT '',
    -- 'login' or 'link' (then account_id is the account to link to).
    mode         TEXT        NOT NULL CHECK (mode IN ('login', 'link')),
    account_id   BIGINT      REFERENCES accounts (id) ON DELETE CASCADE,
    return_to    TEXT        NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    CHECK ((mode = 'link') = (account_id IS NOT NULL))
);
CREATE INDEX oauth_states_expires_idx ON oauth_states (expires_at);

-- An identity whose reported email belongs to an existing account that it is not linked
-- to: it is never linked on its own (account takeover). The browser holds a random token
-- (cookie) and must either prove the account's password or create another account.
CREATE TABLE oauth_pending (
    token_hash     BYTEA       PRIMARY KEY CHECK (length(token_hash) = 32),
    provider       TEXT        NOT NULL,
    subject        TEXT        NOT NULL,
    email          TEXT        NOT NULL,
    email_verified BOOLEAN     NOT NULL,
    return_to      TEXT        NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX oauth_pending_expires_idx ON oauth_pending (expires_at);

-- +goose Down
DROP TABLE oauth_pending;
DROP TABLE oauth_states;
DROP TABLE account_identities;
