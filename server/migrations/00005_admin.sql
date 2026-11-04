-- +goose Up
-- Staff roles, bans and the audit log (T2.6, docs/01-architecture.md "Moderación").
-- Roles are only assigned by the operator's command-line tool (gameserver admin
-- set-role); the game never changes them. The default is the least privileged one.
ALTER TABLE accounts
    ADD COLUMN role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'gm', 'admin'));

-- Bans are per account. expires_at NULL = permanent. Lifting a ban (unban) sets
-- lifted_at; rows are never deleted, so the history of an account stays visible.
-- A ban is active while lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now).
CREATE TABLE account_bans (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id BIGINT      NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    reason     TEXT        NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
    -- Staff account that banned / lifted it (not foreign keys: survives account deletion).
    banned_by  BIGINT,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    lifted_at  TIMESTAMPTZ,
    lifted_by  BIGINT,
    CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX account_bans_open_idx ON account_bans (account_id) WHERE lifted_at IS NULL;

-- Append-only audit log of every staff command and every role change. The time comes
-- from the server's injected clock. Ids are not foreign keys: the log must survive the
-- deletion of the accounts and characters it names.
CREATE TABLE audit_log (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                  TIMESTAMPTZ NOT NULL,
    -- 'game' (a staff character's command) or 'cli' (the operator's tool).
    source              TEXT        NOT NULL CHECK (source IN ('game', 'cli')),
    actor_account_id    BIGINT,
    actor_character_id  BIGINT,
    -- Character name, or the operator's OS user for the CLI.
    actor_name          TEXT        NOT NULL,
    action              TEXT        NOT NULL,
    target_account_id   BIGINT,
    target_character_id BIGINT,
    target_name         TEXT        NOT NULL DEFAULT '',
    args                JSONB       NOT NULL DEFAULT '{}',
    -- 'ok' or why it failed (not_found, protected, invalid, not_banned...).
    result              TEXT        NOT NULL
);
CREATE INDEX audit_log_at_idx ON audit_log (at);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_account_id, at);
CREATE INDEX audit_log_target_idx ON audit_log (target_account_id, at);

-- +goose StatementBegin
CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TRIGGER audit_log_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- +goose Down
DROP TABLE audit_log;
DROP FUNCTION audit_log_append_only();
DROP TABLE account_bans;
ALTER TABLE accounts DROP COLUMN role;
