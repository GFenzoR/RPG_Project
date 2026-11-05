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

-- Economy log batches (T4.1): every row of a batch carries the batch id and its index, and
-- a retried batch (COPY may commit while the client sees a timeout) is inserted with
-- ON CONFLICT DO NOTHING, so a retry never writes a row twice. Rows of older code have none.
ALTER TABLE economy_log ADD COLUMN batch_id TEXT, ADD COLUMN batch_row INTEGER;
CREATE UNIQUE INDEX economy_log_batch_idx ON economy_log (batch_id, batch_row) WHERE batch_id IS NOT NULL;

-- +goose Down
DROP INDEX economy_log_batch_idx;
ALTER TABLE economy_log DROP COLUMN batch_row, DROP COLUMN batch_id;
DROP TABLE player_reports;
