-- +goose Up
-- Lote 17 (owner decision 2026-11-23): the game never keeps the login. Account sessions
-- last 12 hours at most and die after 30 minutes without authenticated activity, so
-- each one records when it was last used (refreshed at most once a minute).
ALTER TABLE sessions ADD COLUMN last_seen_at TIMESTAMPTZ;
UPDATE sessions SET last_seen_at = created_at;
ALTER TABLE sessions ALTER COLUMN last_seen_at SET NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_last_seen_check CHECK (last_seen_at >= created_at);
-- The 30-day account sessions issued before this rule end here: every player logs in
-- again once, and the old persistent cookies stop working.
DELETE FROM sessions WHERE kind = 'account';
-- The purge job deletes idle account sessions by last use.
CREATE INDEX sessions_idle_idx ON sessions (last_seen_at) WHERE kind = 'account';

-- +goose Down
DROP INDEX sessions_idle_idx;
ALTER TABLE sessions DROP CONSTRAINT sessions_last_seen_check;
ALTER TABLE sessions DROP COLUMN last_seen_at;
