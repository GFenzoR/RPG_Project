// The queue is the table map_submissions (contract in server/migrations/00010 and docs/04,
// "Contrato con el worker"). Every statement is one short transaction: none stays open
// while the worker talks to GitHub.
import type { Submission } from "./build.ts";

/** What the worker needs from the queue. pg in production, a fake in unit tests. */
export interface Queue {
  /**
   * Claims the oldest approved submission that is due (or that one id, when given): one
   * more attempt, and a lease until `leaseUntil` that keeps other workers away. Null when
   * there is none.
   */
  claim(now: Date, leaseUntil: Date, onlyId?: number): Promise<Claimed | null>;
  /** approved → pr_opened. False if it was not approved any more. */
  opened(id: number, now: Date, url: string, num: number): Promise<boolean>;
  /** approved → failed with a fixed code. */
  failed(id: number, now: Date, code: string): Promise<boolean>;
  /** Stays approved; tried again from `at`. `refund` gives this attempt back. */
  retryAt(id: number, at: Date, refund?: boolean): Promise<void>;
}

export interface Claimed extends Submission {
  /** Attempts so far, this one included. */
  attempts: number;
}

/** The part of pg's Pool the queue uses. */
export interface SqlClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

const CLAIM = `
WITH c AS (
  SELECT id FROM map_submissions
  WHERE status = 'approved' AND patch IS NOT NULL
    AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
    AND ($3::bigint IS NULL OR id = $3::bigint)
  ORDER BY reviewed_at, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE map_submissions s
SET attempts = s.attempts + 1, next_attempt_at = $2
FROM c
WHERE s.id = c.id
RETURNING s.id, s.title, s.description, s.author_name, s.sha256, s.base_ref, s.patch,
          s.reviewed_at, s.attempts`;

export class PgQueue implements Queue {
  private readonly db: SqlClient;
  constructor(db: SqlClient) {
    this.db = db;
  }

  async claim(now: Date, leaseUntil: Date, onlyId?: number): Promise<Claimed | null> {
    const r = await this.db.query(CLAIM, [now, leaseUntil, onlyId ?? null]);
    const row = r.rows[0];
    if (!row) return null;
    const patch = row["patch"];
    return {
      id: Number(row["id"]),
      title: String(row["title"]),
      description: String(row["description"]),
      author: String(row["author_name"]),
      sha256: String(row["sha256"]),
      baseRef: String(row["base_ref"]),
      // bytea → Buffer, decoded strictly (the server checked it is UTF-8). If it is not, the
      // empty text fails as invalid_patch instead of being claimed again forever.
      patch: decodePatch(patch),
      reviewedAt:
        row["reviewed_at"] instanceof Date
          ? row["reviewed_at"]
          : new Date(String(row["reviewed_at"])),
      attempts: Number(row["attempts"]),
    };
  }

  async opened(id: number, now: Date, url: string, num: number): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE map_submissions
       SET status = 'pr_opened', pr_url = $2, pr_number = $3, failure = NULL, next_attempt_at = NULL, updated_at = $4
       WHERE id = $1 AND status = 'approved'`,
      [id, url, num, now],
    );
    return r.rowCount === 1;
  }

  async failed(id: number, now: Date, code: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE map_submissions
       SET status = 'failed', failure = $2, next_attempt_at = NULL, updated_at = $3
       WHERE id = $1 AND status = 'approved'`,
      [id, code, now],
    );
    return r.rowCount === 1;
  }

  async retryAt(id: number, at: Date, refund = false): Promise<void> {
    await this.db.query(
      `UPDATE map_submissions
       SET next_attempt_at = $2, attempts = GREATEST(attempts - CASE WHEN $3 THEN 1 ELSE 0 END, 0)
       WHERE id = $1 AND status = 'approved'`,
      [id, at, refund],
    );
  }
}

function decodePatch(raw: unknown): string {
  if (!Buffer.isBuffer(raw)) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return "";
  }
}
