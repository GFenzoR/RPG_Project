#!/usr/bin/env node
// The map PR worker's process (T4.5 2/2, docs/09 "Worker de PR de mapas"). No port: it only
// talks to Postgres and to the GitHub API. Configuration comes from the environment:
//   DATABASE_URL            Postgres of the game (map_submissions)
//   GITHUB_MAP_PR_TOKEN     fine-grained token: this repository only, Contents and Pull
//                           requests read/write. Without it the worker does not run.
//   GITHUB_REPOSITORY       owner/repo the pull requests go to
//   MAP_PR_BASE             base branch (default main)
//   MAP_PR_POLL_SECONDS     how often to look for approved submissions (default 30)
//   GITHUB_API_URL          API root (default https://api.github.com; tests: a fake)
// Flags: --once (handle what is due and exit), --only <id> (that submission only),
// --self-check (merge a small built-in patch with map-format and exit: the image's smoke
// test, which proves the modules and the map schemas load).
//   MAP_PR_POLL_SECONDS     how often to look for approved submissions (default 30)
// Logs are JSON lines on stdout; the token is never logged.
import { parseArgs } from "node:util";
import pg from "pg";
import { readConfig } from "./config.ts";
import { GitHub } from "./github.ts";
import { PgQueue } from "./queue.ts";
import { runOnce } from "./worker.ts";
import { buildChange } from "./build.ts";

/** Merges a one-zone patch onto a one-zone base: map-format, its schemas and the build load. */
async function selfCheck(): Promise<boolean> {
  const path = "world/islands/check/zones.yaml";
  const zone = (id: string): string =>
    `- id: ${id}\n  type: community_plot\n  floors: [7]\n  rects:\n    - { x: 0, y: 0, w: 4, h: 4 }\n`;
  const base = zone("a");
  const { createHash } = await import("node:crypto");
  const patch = JSON.stringify({
    format: 2,
    kind: "rpg-map-patch",
    base_ref: "check",
    files: [
      {
        path,
        base: `sha256:${createHash("sha256").update(base).digest("hex")}`,
        base_text: base,
        content: base + zone("b").replace("community_plot", "protection"),
      },
    ],
  });
  const r = await buildChange(
    {
      id: 1,
      title: "check",
      description: "",
      author: "Check",
      sha256: "0".repeat(64),
      baseRef: "check",
      patch,
      reviewedAt: new Date(0),
    },
    async (p) => (p === path ? base : null),
  );
  return r.ok && r.writes.has(path);
}

function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`,
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      once: { type: "boolean", default: false },
      only: { type: "string" },
      "self-check": { type: "boolean", default: false },
    },
    strict: true,
  });
  const onlyId = values.only === undefined ? undefined : Number(values.only);
  if (onlyId !== undefined && (!Number.isSafeInteger(onlyId) || onlyId <= 0)) {
    log("error", "--only needs a submission id");
    return 2;
  }
  if (values["self-check"]) {
    const ok = await selfCheck();
    log(ok ? "info" : "error", ok ? "self-check ok" : "self-check failed");
    return ok ? 0 : 1;
  }
  const cfg = readConfig(process.env);
  if (cfg === "disabled") {
    // Not an error: without a token, approved submissions wait and a maintainer opens
    // them by hand with `mapcli patch apply` (docs/04).
    log("warn", "GITHUB_MAP_PR_TOKEN is not set: the map PR worker does not run");
    return 0;
  }
  if ("error" in cfg) {
    log("error", "map PR worker misconfigured", { err: cfg.error });
    return 2;
  }
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
  pool.on("error", (e) => log("warn", "postgres", { err: e.message }));
  const gh = new GitHub({ apiUrl: cfg.apiUrl, token: cfg.token, owner: cfg.owner, repo: cfg.repo });
  const queue = new PgQueue(pool);
  let stop = false;
  let wake: (() => void) | undefined;
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => {
      stop = true;
      wake?.();
    });
  log("info", "map PR worker started", { repo: `${cfg.owner}/${cfg.repo}`, base: cfg.base });
  try {
    do {
      try {
        const done = await runOnce(gh, queue, {
          base: cfg.base,
          log,
          ...(onlyId === undefined ? {} : { onlyId }),
        });
        if (values.once)
          return done.some((o) => o.kind === "retry" || o.kind === "blocked") ? 1 : 0;
      } catch (e) {
        log("warn", "map PR worker: queue unavailable", {
          err: e instanceof Error ? e.message : String(e),
        });
        if (values.once) return 1;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, cfg.pollMs).unref();
      });
    } while (!stop);
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    log("error", "map PR worker crashed", { err: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  },
);
