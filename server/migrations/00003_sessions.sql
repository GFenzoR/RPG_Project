-- +goose Up
-- Opaque session tokens (docs/01-architecture.md). Only the SHA-256 of the token is
-- stored, so a database leak does not leak usable tokens. Revoking = deleting the row.
CREATE TABLE sessions (
    token_hash   BYTEA       PRIMARY KEY CHECK (length(token_hash) = 32),
    account_id   BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    -- 'account': HTTP API token from login. 'play': short-lived token for one character,
    -- exchanged in the WebSocket Hello (T1.4).
    kind         TEXT        NOT NULL CHECK (kind IN ('account', 'play')),
    character_id BIGINT,
    created_at   TIMESTAMPTZ NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    CHECK ((kind = 'play') = (character_id IS NOT NULL)),
    CHECK (expires_at > created_at),
    -- A play token can only name a character of its own account.
    FOREIGN KEY (character_id, account_id)
        REFERENCES characters (id, account_id) ON DELETE CASCADE
);
CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- +goose Down
DROP TABLE sessions;
