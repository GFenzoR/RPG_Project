-- +goose Up
-- Map submissions (T4.5, docs/04-map-editor-and-ai.md "Portal de envío de mapas"): a map
-- patch a player uploads from the website, the moderation queue (gm and admin) and,
-- once approved, the worker that opens the pull request (PR B of T4.5).
--
-- Lifecycle: pending → approved | rejected (a moderator); approved → pr_opened | failed
-- (the worker). Ids are not foreign keys: a submission and its history survive the
-- deletion of the accounts and characters it names, like player_reports.
--
-- Contract with the PR worker (no transaction stays open during calls to GitHub):
--   1. Claim, in a short transaction: the oldest approved submission that is due,
--        SELECT ... FROM map_submissions
--        WHERE status = 'approved' AND (next_attempt_at IS NULL OR next_attempt_at <= now)
--        ORDER BY reviewed_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
--      then attempts + 1 and next_attempt_at = now + a lease (minutes), and commit. The
--      lease keeps other workers away; a worker that dies leaves it to expire.
--   2. Work without a transaction. Idempotent by construction: the branch is always
--      map-submission/<id>, and an open PR from that branch is reused, never duplicated.
--   3. Finish, in a short transaction guarded by status = 'approved': pr_opened (pr_url,
--      pr_number) or failed (failure, a fixed code). A retryable error leaves it approved
--      with the lease as the backoff (next_attempt_at).
--
-- Down only works before any website action was audited: audit_log is append-only, so
-- rows with source 'web' cannot be deleted and block the old CHECK.
CREATE TABLE map_submissions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL,
    account_id          BIGINT      NOT NULL,
    -- The character the author is credited as (in the PR and world/CONTRIBUTORS.md);
    -- never the email.
    author_character_id BIGINT      NOT NULL,
    author_name         TEXT        NOT NULL CHECK (length(author_name) BETWEEN 1 AND 20),
    title               TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
    description         TEXT        NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
    -- License the author accepted (an id such as 'cc-by-4.0', docs/04).
    license             TEXT        NOT NULL CHECK (license ~ '^[a-z0-9.-]{1,32}$'),
    status              TEXT        NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'pr_opened', 'failed')),
    -- Hex sha256 and size of the uploaded patch bytes.
    sha256              TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes          INTEGER     NOT NULL CHECK (size_bytes > 0),
    base_ref            TEXT        NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 200),
    -- [{"path": "world/...", "action": "create|modify|delete"}], from the server's check.
    files               JSONB       NOT NULL CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) >= 1),
    patch               BYTEA       NOT NULL,
    -- The moderator's decision.
    reviewed_at         TIMESTAMPTZ,
    reviewed_by         BIGINT,
    -- Why it was rejected (moderator's text, shown to the author).
    reason              TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
    -- The worker: why it failed (a fixed code, never a message from GitHub or the merge),
    -- the pull request, and its retries.
    failure             TEXT CHECK (failure IS NULL OR failure ~ '^[a-z_]{1,32}$'),
    pr_url              TEXT CHECK (pr_url IS NULL OR pr_url ~ '^https://'),
    pr_number           INTEGER,
    attempts            INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at     TIMESTAMPTZ,
    CHECK ((status = 'pending') = (reviewed_at IS NULL)),
    CHECK (status <> 'rejected' OR reason IS NOT NULL),
    CHECK (status <> 'failed' OR failure IS NOT NULL),
    CHECK (status <> 'pr_opened' OR (pr_url IS NOT NULL AND pr_number IS NOT NULL))
);
CREATE INDEX map_submissions_account_idx ON map_submissions (account_id, created_at);
CREATE INDEX map_submissions_pending_idx ON map_submissions (created_at, id) WHERE status = 'pending';
CREATE INDEX map_submissions_approved_idx ON map_submissions (reviewed_at, id) WHERE status = 'approved';
-- The same patch twice from one account while the first is still waiting.
CREATE UNIQUE INDEX map_submissions_pending_sha_key ON map_submissions (account_id, sha256) WHERE status = 'pending';

-- Website actions are audited too (source 'web': the actor is an account, not a character).
ALTER TABLE audit_log DROP CONSTRAINT audit_log_source_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_source_check CHECK (source IN ('game', 'cli', 'web'));

-- +goose Down
ALTER TABLE audit_log DROP CONSTRAINT audit_log_source_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_source_check CHECK (source IN ('game', 'cli'));
DROP TABLE map_submissions;
