-- Map submissions (T4.5). Lists never read the patch bytes.

-- name: LockSubmitter :one
-- The author's account, locked for the rest of the transaction so two uploads at once
-- cannot both pass the daily limit.
SELECT a.created_at, a.disabled_at, a.role,
       EXISTS (SELECT 1 FROM account_bans b
               WHERE b.account_id = a.id AND b.lifted_at IS NULL
                 AND (b.expires_at IS NULL OR b.expires_at > sqlc.arg(now))) AS banned
FROM accounts a
WHERE a.id = sqlc.arg(account_id)
FOR UPDATE;

-- name: CountRecentSubmissions :one
SELECT count(*) FROM map_submissions
WHERE account_id = sqlc.arg(account_id) AND created_at > sqlc.arg(since);

-- name: CharacterOfAccount :one
SELECT name FROM characters
WHERE id = sqlc.arg(id) AND account_id = sqlc.arg(account_id);

-- name: InsertMapSubmission :one
INSERT INTO map_submissions (created_at, updated_at, account_id, author_character_id, author_name,
                             title, description, license, sha256, size_bytes, base_ref, files, patch)
VALUES (sqlc.arg(now), sqlc.arg(now), sqlc.arg(account_id), sqlc.arg(author_character_id),
        sqlc.arg(author_name), sqlc.arg(title), sqlc.arg(description), sqlc.arg(license),
        sqlc.arg(sha256), sqlc.arg(size_bytes), sqlc.arg(base_ref), sqlc.arg(files), sqlc.arg(patch))
RETURNING id;

-- name: ListAccountSubmissions :many
-- An author's submissions, newest first.
SELECT id, created_at, updated_at, account_id, author_character_id, author_name, title, description,
       license, status, sha256, size_bytes, base_ref, files, reviewed_at, reviewed_by, reason,
       failure, pr_url, pr_number
FROM map_submissions
WHERE account_id = sqlc.arg(account_id)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(max_rows);

-- name: ListSubmissionsByStatus :many
-- The moderation queue: oldest first, so pending ones are reviewed in arrival order.
SELECT id, created_at, updated_at, account_id, author_character_id, author_name, title, description,
       license, status, sha256, size_bytes, base_ref, files, reviewed_at, reviewed_by, reason,
       failure, pr_url, pr_number
FROM map_submissions
WHERE status = sqlc.arg(status)
ORDER BY created_at, id
LIMIT sqlc.arg(max_rows);

-- name: GetSubmission :one
SELECT id, created_at, updated_at, account_id, author_character_id, author_name, title, description,
       license, status, sha256, size_bytes, base_ref, files, reviewed_at, reviewed_by, reason,
       failure, pr_url, pr_number
FROM map_submissions
WHERE id = sqlc.arg(id);

-- name: GetSubmissionPatch :one
SELECT account_id, sha256, patch FROM map_submissions WHERE id = sqlc.arg(id);

-- name: ReviewSubmission :one
-- Approve or reject a pending submission. No row: it is not pending (or does not exist).
UPDATE map_submissions
SET status = sqlc.arg(status), reviewed_at = sqlc.arg(now), reviewed_by = sqlc.arg(reviewed_by),
    reason = sqlc.narg(reason), updated_at = sqlc.arg(now)
WHERE id = sqlc.arg(id) AND status = 'pending'
RETURNING id, account_id, author_name, sha256;

-- name: SubmissionStatus :one
SELECT status FROM map_submissions WHERE id = sqlc.arg(id);
