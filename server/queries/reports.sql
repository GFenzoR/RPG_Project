-- name: InsertReport :one
INSERT INTO player_reports (created_at, reporter_account_id, reporter_character_id, reporter_name,
                            target_account_id, target_character_id, target_name, reason, context)
VALUES (sqlc.arg(created_at), sqlc.arg(reporter_account_id), sqlc.arg(reporter_character_id),
        sqlc.arg(reporter_name), sqlc.arg(target_account_id), sqlc.arg(target_character_id),
        sqlc.arg(target_name), sqlc.arg(reason), sqlc.arg(context))
RETURNING id;

-- name: ListOpenReports :many
-- The oldest open reports first: the queue order.
SELECT id, created_at, reporter_name, target_name, target_character_id, reason, context
FROM player_reports
WHERE status = 'open'
ORDER BY created_at, id
LIMIT sqlc.arg(max_rows);

-- name: CloseReport :execrows
UPDATE player_reports
SET status = 'closed', closed_at = sqlc.arg(now), closed_by = sqlc.narg(closed_by),
    closed_by_name = sqlc.arg(closed_by_name), resolution = sqlc.arg(resolution)
WHERE id = sqlc.arg(id) AND status = 'open';

-- name: ReportExists :one
SELECT EXISTS (SELECT 1 FROM player_reports WHERE id = sqlc.arg(id));
