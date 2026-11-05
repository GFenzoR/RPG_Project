-- +goose Up
-- Player reports (T4.1, docs/02-game-design.md "Moderación"): the queue GMs read with
-- /reports and close with /closereport. The server fills context itself (positions and
-- the reported character's recent events); the client only sends the reason. Ids are not
-- foreign keys: a report must survive the deletion of the accounts it names.
CREATE TABLE player_reports (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at            TIMESTAMPTZ NOT NULL,
    reporter_account_id   BIGINT      NOT NULL,
    reporter_character_id BIGINT      NOT NULL,
    reporter_name         TEXT        NOT NULL,
    target_account_id     BIGINT      NOT NULL,
    target_character_id   BIGINT      NOT NULL,
    target_name           TEXT        NOT NULL,
    reason                TEXT        NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
    context               JSONB       NOT NULL DEFAULT '{}',
    status                TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    closed_at             TIMESTAMPTZ,
    closed_by             BIGINT,
    closed_by_name        TEXT,
    resolution            TEXT CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 200),
    CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE INDEX player_reports_open_idx ON player_reports (created_at) WHERE status = 'open';
CREATE INDEX player_reports_target_idx ON player_reports (target_account_id, created_at);

-- +goose Down
DROP TABLE player_reports;
