-- +goose Up
-- Economy log batches (T4.1): every row of a batch carries the batch id and its index, and
-- a retried batch (COPY may commit while the client sees a timeout) is inserted with
-- ON CONFLICT DO NOTHING, so a retry never writes a row twice. Rows of older code have none.
ALTER TABLE economy_log ADD COLUMN batch_id TEXT, ADD COLUMN batch_row INTEGER;
CREATE UNIQUE INDEX economy_log_batch_idx ON economy_log (batch_id, batch_row) WHERE batch_id IS NOT NULL;

-- +goose Down
DROP INDEX economy_log_batch_idx;
ALTER TABLE economy_log DROP COLUMN batch_row, DROP COLUMN batch_id;
