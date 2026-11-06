// The worker's process as compose runs it: it stays up between rounds (an idle pg pool
// closes after 10 s and must not let Node exit), stops at once on SIGTERM, idles without a
// token, and refuses a token of the repository's owner.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGitHub } from "../test/fake-github.ts";
import type { FakeGitHub } from "../test/fake-github.ts";

const CLI = join(import.meta.dirname, "cli.ts");
let child: ChildProcess | undefined;
let fake: FakeGitHub | undefined;
afterEach(async () => {
  child?.kill("SIGKILL");
  await fake?.close();
  child = fake = undefined;
});

function start(
  env: Record<string, string>,
  args: string[] = [],
): { out: () => string; exit: Promise<number | null> } {
  let out = "";
  const c = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], {
    // Postgres that does not answer: every round logs "queue unavailable" and sleeps.
    env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: "postgres://127.0.0.1:1/none", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  c.stdout?.on("data", (b: Buffer) => (out += b.toString()));
  child = c;
  return { out: () => out, exit: new Promise((r) => c.on("exit", (code) => r(code))) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (c: ChildProcess | undefined): boolean =>
  c !== undefined && c.exitCode === null && c.signalCode === null;

describe("map PR worker process", () => {
  it("stays up past the pg pool's idle timeout and stops cleanly on SIGTERM", async () => {
    fake = await startFakeGitHub({ owner: "acme", repo: "rpg", token: "t", readBase: () => null });
    const p = start({
      GITHUB_MAP_PR_TOKEN: "t",
      GITHUB_REPOSITORY: "acme/rpg",
      GITHUB_API_URL: fake.url,
      MAP_PR_POLL_SECONDS: "2",
    });
    await sleep(12_000);
    expect(alive(child)).toBe(true);
    expect(p.out()).toContain('"login":"rpg-map-bot"');
    expect(p.out()).not.toContain('"t"'); // the token never appears
    const t0 = Date.now();
    child?.kill("SIGTERM");
    expect(await p.exit).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 30_000);

  it("without a token it idles (compose --wait passes) until SIGTERM; --once just exits", async () => {
    const p = start({});
    await sleep(1_500);
    expect(alive(child)).toBe(true);
    expect(p.out()).toContain("GITHUB_MAP_PR_TOKEN is not set");
    child?.kill("SIGTERM");
    expect(await p.exit).toBe(0);
    expect(await start({}, ["--once"]).exit).toBe(0);
  }, 20_000);

  it("refuses to run with the owner's token, without touching the queue", async () => {
    fake = await startFakeGitHub({
      owner: "acme",
      repo: "rpg",
      token: "t",
      login: "acme",
      readBase: () => null,
    });
    const env = {
      GITHUB_MAP_PR_TOKEN: "t",
      GITHUB_REPOSITORY: "acme/rpg",
      GITHUB_API_URL: fake.url,
    };
    const once = start(env, ["--once"]);
    expect(await once.exit).toBe(2);
    expect(once.out()).toContain("refuses to run with this token");
    expect(once.out()).not.toContain("queue unavailable");
    // As a service it stays paused (no restart loop) until stopped.
    const p = start(env);
    await sleep(1_500);
    expect(alive(child)).toBe(true);
    child?.kill("SIGTERM");
    expect(await p.exit).toBe(0);
  }, 20_000);
});
