// PgQueue against a real Postgres (make test-integration sets MAP_PR_WORKER_DATABASE_URL):
// the server's migrations in a schema of their own, then the queue contract of migration
// 00010 end to end, including two workers that never get the same submission and the
// worker against the fake GitHub.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHub } from "./github.ts";
import { PgQueue } from "./queue.ts";
import { runOnce } from "./worker.ts";
import { startFakeGitHub } from "../test/fake-github.ts";
import { ROOT, plotSubmission, readRepo } from "../test/fixtures.ts";

const url = process.env["MAP_PR_WORKER_DATABASE_URL"];
const SCHEMA = "it_map_pr_worker";

/** The Up part of every goose migration, in order (annotations are SQL comments). */
function migrations(): string[] {
  const dir = join(ROOT, "server", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      const up = sql.split("-- +goose Down")[0] ?? "";
      return up.replace("-- +goose Up", "");
    });
}

describe.skipIf(!url)("PgQueue (Postgres)", () => {
  let pool: pg.Pool;
  const at = new Date("2026-11-06T10:00:00Z");

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}`, max: 4 });
    for (const sql of migrations()) await pool.query(sql);
  });
  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool?.end();
  });

  async function approved(id: number, patch = plotSubmission(id).patch): Promise<number> {
    const r = await pool.query(
      `INSERT INTO map_submissions (created_at, updated_at, account_id, author_character_id, author_name, title,
         description, license, status, sha256, size_bytes, base_ref, files, patch, reviewed_at, reviewed_by)
       VALUES ($1, $1, 1, 1, 'Cartographer Aria', $2, '', 'cc-by-4.0', 'approved', $3, $4, 'HEAD',
         '[{"path":"world/x","action":"modify"}]', $5, $1, 9) RETURNING id`,
      [at, `Envío ${String(id)}`, "b".repeat(64), Buffer.byteLength(patch), Buffer.from(patch)],
    );
    return Number(r.rows[0]?.["id"]);
  }

  it("claims each approved submission once, leases it and records the outcome", async () => {
    const q = new PgQueue(pool);
    const a = await approved(1);
    const b = await approved(2);
    // Two workers at once never get the same row.
    const [x, y] = await Promise.all([
      q.claim(at, new Date(at.getTime() + 600_000)),
      q.claim(at, new Date(at.getTime() + 600_000)),
    ]);
    expect(new Set([x?.id, y?.id])).toEqual(new Set([a, b]));
    expect(x?.attempts).toBe(1);
    expect(x?.patch).toContain("rpg-map-patch");
    expect(x?.author).toBe("Cartographer Aria");
    // Leased: nothing due until the lease ends.
    expect(await q.claim(at, at)).toBeNull();
    expect(await q.opened(a, at, "https://github.com/acme/rpg/pull/5", 5)).toBe(true);
    expect(await q.opened(a, at, "https://github.com/acme/rpg/pull/6", 6)).toBe(false); // not approved any more
    expect(await q.failed(b, at, "conflict")).toBe(true);
    const rows = await pool.query(
      `SELECT id, status, pr_url, pr_number, failure FROM map_submissions ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      {
        id: String(a),
        status: "pr_opened",
        pr_url: "https://github.com/acme/rpg/pull/5",
        pr_number: 5,
        failure: null,
      },
      { id: String(b), status: "failed", pr_url: null, pr_number: null, failure: "conflict" },
    ]);
    // A failure code outside the contract is refused by the table.
    const c = await approved(3);
    await expect(q.failed(c, at, "Not A Code")).rejects.toThrow();
    await q.retryAt(c, new Date(at.getTime() + 60_000), true);
    expect(
      (await pool.query(`SELECT attempts FROM map_submissions WHERE id = $1`, [c])).rows[0],
    ).toEqual({ attempts: 0 });
    expect(await q.claim(at, at)).toBeNull();
    expect((await q.claim(new Date(at.getTime() + 60_000), at, c))?.id).toBe(c);
  });

  it("runs end to end against the fake GitHub", async () => {
    await pool.query(
      `UPDATE map_submissions SET status = 'failed', failure = 'github' WHERE status = 'approved'`,
    );
    const id = await approved(10);
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "rpg",
      token: "t",
      readBase: readRepo,
    });
    try {
      const gh = new GitHub({ apiUrl: fake.url, token: "t", owner: "acme", repo: "rpg" });
      const out = await runOnce(gh, new PgQueue(pool), { base: "main", now: () => at });
      expect(out.map((o) => o.kind)).toEqual(["opened"]);
      const r = await pool.query(`SELECT status, pr_number FROM map_submissions WHERE id = $1`, [
        id,
      ]);
      expect(r.rows[0]).toEqual({ status: "pr_opened", pr_number: 1 });
      expect(fake.pulls[0]?.head).toBe(`map-submission/${String(id)}-${"b".repeat(12)}`);
    } finally {
      await fake.close();
    }
  });
});
