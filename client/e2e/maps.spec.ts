// E2E of the map submission portal (T4.5): a player exports a real map patch (mapcli, a
// small change inside Puerto's community plot), logs in on the website and submits it; a
// gm (role set with psql) reviews the queue, downloads the patch and approves it; a second
// submission is rejected with a reason the author then sees. A player gets nothing from
// the moderation pages or API.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { databaseUrl, serverURL } from "../playwright.config.ts";

const repo = join(import.meta.dirname, "..", "..");
const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });

function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

const run = `${Date.now()}-${randomLetters(6)}`;
const password = "e2e-password-1";
const author = {
  email: `maps-author-${run}@example.com`,
  name: `Cartographer ${randomLetters(5).replace(/^./, (c) => c.toUpperCase())}`,
};
const gm = { email: `maps-gm-${run}@example.com` };
const player = { email: `maps-player-${run}@example.com` };

const psql = (sql: string): string =>
  execFileSync("psql", [databaseUrl, "-At", "-c", sql], { encoding: "utf8" }).trim();

/**
 * A real map patch: paints a few tiles of Puerto's community plot (zones.yaml,
 * puerto_north_shore_plot) in a throwaway copy of world/ and data/ with mapcli, then
 * exports it with `mapcli patch create`, as a contributor would.
 */
function exportPatch(dir: string, rect: string, ground: string): string {
  const work = mkdtempSync(join(dir, "world-"));
  cpSync(join(repo, "world"), join(work, "world"), { recursive: true });
  cpSync(join(repo, "data"), join(work, "data"), { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", ...args], {
      cwd: work,
      stdio: "ignore",
    });
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
  const mapcli = (...args: string[]): string =>
    execFileSync(
      "node",
      [
        "--experimental-strip-types",
        join(repo, "tools/mapcli/src/cli.ts"),
        ...args,
        "--root",
        work,
      ],
      { encoding: "utf8" },
    );
  mapcli("paint", "puerto", "--floor", "7", "--rect", rect, "--ground", ground);
  const out = join(dir, `plot-${rect.replace(/,/g, "-")}.rpgpatch.json`);
  mapcli("patch", "create", "puerto", "--out", out);
  const patch = JSON.parse(readFileSync(out, "utf8")) as { files: { path: string }[] };
  expect(patch.files.map((f) => f.path)).toEqual([
    "world/islands/puerto/chunks/z07/c0100_0196.json",
  ]);
  return out;
}

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    throw e;
  });
  return page;
}

/** Logs in with the website's own form (shown by a portal page without a session). */
async function siteLogin(page: Page, email: string): Promise<void> {
  await expect(page.locator(".maps-login")).toBeVisible();
  await page.locator('.maps-login input[type="email"]').fill(email);
  await page.locator('.maps-login input[type="password"]').fill(password);
  await page.locator('.maps-login button[type="submit"]').click();
  await expect(page.locator(".maps-login")).toHaveCount(0);
}

test.describe.serial("map submission portal", () => {
  let tmp: string;
  let grassPatch: string;
  let pathPatch: string;

  test.beforeAll(async ({ playwright }) => {
    tmp = mkdtempSync(join(tmpdir(), "rpg-maps-e2e-"));
    // Puerto's plot is sand beach: a patch of grass in one corner, and a second, different
    // change (a strip in another corner) for the rejection.
    grassPatch = exportPatch(tmp, "3202,6298,2,2", "grass");
    pathPatch = exportPatch(tmp, "3210,6300,3,1", "grass");

    const api = await playwright.request.newContext({ baseURL: serverURL });
    for (const a of [author, gm, player]) {
      expect(
        (await api.post("/api/auth/register", { data: { email: a.email, password } })).status(),
      ).toBe(201);
    }
    const login = await api.post("/api/auth/login", {
      data: { email: author.email, password, token_in_body: true },
    });
    const { token } = (await login.json()) as { token: string };
    const created = await api.post("/api/characters", {
      data: { name: author.name, vocation: "druid" },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(created.status()).toBe(201);
    await api.dispose();
    // Accounts must be a day old to submit (-map-submit-min-account-age), and the gm is
    // made gm the way an operator would not: straight in the database, for the test.
    psql(
      `UPDATE accounts SET created_at = now() - interval '2 days' WHERE email IN ('${author.email}', '${player.email}')`,
    );
    psql(`UPDATE accounts SET role = 'gm' WHERE email = '${gm.email}'`);
  });

  test.afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("a player submits a patch and sees it pending", async ({ browser }) => {
    const page = await newPage(browser);
    await page.goto("/maps/submit?lang=es");
    await siteLogin(page, author.email);
    await expect(page.getByTestId("maps-submit-form")).toBeVisible();
    await expect(page.locator(".maps-nav a")).toHaveCount(2); // no moderation link

    await page.getByTestId("maps-file").setInputFiles(grassPatch);
    await expect(page.getByTestId("maps-file-ok")).toContainText(
      "plot-3202-6298-2-2.rpgpatch.json",
    );
    await page.getByTestId("maps-title").fill("Pasto en la playa norte");
    await page
      .getByTestId("maps-description")
      .fill("Un rincón de pasto en la parcela de la comunidad.\nCuatro casillas.");
    await expect(page.getByTestId("maps-character")).toHaveValue(/\d+/);
    await expect(page.getByTestId("maps-send")).toBeDisabled(); // license not accepted yet
    await page.getByTestId("maps-license").check();
    await shot(page, "maps-submit-form");
    await page.getByTestId("maps-send").click();
    await expect(page.getByTestId("maps-submitted")).toContainText("Pasto en la playa norte");
    await shot(page, "maps-submit-done");

    // The same patch again, while the first waits: refused with its own text.
    await page.goto("/maps/submit");
    await page.getByTestId("maps-file").setInputFiles(grassPatch);
    await page.getByTestId("maps-title").fill("Otra vez");
    await page.getByTestId("maps-license").check();
    await page.getByTestId("maps-send").click();
    await expect(page.getByTestId("maps-error")).toHaveText(
      "Ese mismo patch ya está esperando revisión.",
    );

    await page.goto("/maps/mine");
    const item = page.getByTestId("maps-mine").locator("li").first();
    await expect(item).toContainText("Pasto en la playa norte");
    await expect(item.locator(".badge")).toHaveAttribute("data-status", "pending");
    await expect(item).toContainText(author.name);
    await shot(page, "maps-mine-pending");

    const row = psql(
      `SELECT s.status || ' ' || s.author_name || ' ' || s.files::text FROM map_submissions s JOIN accounts a ON a.id = s.account_id WHERE a.email = '${author.email}'`,
    );
    expect(row).toContain(`pending ${author.name}`);
    expect(row).toContain("world/islands/puerto/chunks/z07/c0100_0196.json");
    await page.context().close();
  });

  test("a player gets nothing from moderation", async ({ browser }) => {
    const page = await newPage(browser);
    await page.goto("/maps/review?lang=es");
    await siteLogin(page, player.email);
    await expect(page.getByTestId("maps-error")).toHaveText(
      "No tienes permiso para ver esta página.",
    );
    const queue = await page.request.get("/api/maps/submissions?status=pending");
    expect(queue.status()).toBe(403);
    const id = psql(
      `SELECT s.id FROM map_submissions s JOIN accounts a ON a.id = s.account_id WHERE a.email = '${author.email}'`,
    );
    expect((await page.request.get(`/api/maps/submissions/${id}/patch`)).status()).toBe(404);
    const review = await page.request.post(`/api/maps/submissions/${id}/review`, {
      data: { decision: "approve", reason: "" },
    });
    expect(review.status()).toBe(403);
    await page.context().close();
  });

  test("a gm reviews, downloads and approves; a second one is rejected", async ({ browser }) => {
    const page = await newPage(browser);
    await page.goto("/maps/review?lang=es");
    await siteLogin(page, gm.email);
    await expect(page.locator(".maps-nav a")).toHaveCount(3);
    const link = page.getByTestId("maps-queue").getByRole("link", {
      name: "Pasto en la playa norte",
    });
    await expect(link).toBeVisible();
    await shot(page, "maps-review-queue");
    await link.click();
    const detail = page.getByTestId("maps-detail");
    await expect(detail).toContainText(author.name);
    await expect(detail).toContainText("world/islands/puerto/chunks/z07/c0100_0196.json");
    await expect(page.getByTestId("maps-description-text")).toHaveText(
      "Un rincón de pasto en la parcela de la comunidad.\nCuatro casillas.",
    );
    await expect(page.getByTestId("maps-reject")).toBeDisabled(); // needs a reason
    await shot(page, "maps-review-detail");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("maps-download").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^submission-\d+\.rpgpatch\.json$/);
    const saved = join(tmp, "downloaded.rpgpatch.json");
    await download.saveAs(saved);
    expect(readFileSync(saved, "utf8")).toBe(readFileSync(grassPatch, "utf8"));

    await page.getByTestId("maps-approve").click();
    await expect(detail.locator(".badge").first()).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("maps-approve")).toHaveCount(0);
    await shot(page, "maps-review-approved");

    // The author sends a second change; the gm rejects it with a reason.
    const authorPage = await newPage(browser);
    await authorPage.goto("/maps/submit?lang=es");
    await siteLogin(authorPage, author.email);
    await authorPage.getByTestId("maps-file").setInputFiles(pathPatch);
    await authorPage.getByTestId("maps-title").fill("Sendero al faro");
    await authorPage.getByTestId("maps-license").check();
    await authorPage.getByTestId("maps-send").click();
    await expect(authorPage.getByTestId("maps-submitted")).toBeVisible();

    await page.goto("/maps/review");
    await page.getByTestId("maps-queue").getByRole("link", { name: "Sendero al faro" }).click();
    await page.getByTestId("maps-reason-input").fill("El sendero corta la playa; muévelo al este.");
    await page.getByTestId("maps-reject").click();
    await expect(page.getByTestId("maps-detail").locator(".badge").first()).toHaveAttribute(
      "data-status",
      "rejected",
    );
    await page.goto("/maps/review?status=approved");
    await expect(page.getByTestId("maps-queue")).toContainText("Pasto en la playa norte");

    await authorPage.goto("/maps/mine");
    const items = authorPage.getByTestId("maps-mine").locator("li");
    await expect(items.nth(0).locator(".badge")).toHaveAttribute("data-status", "rejected");
    await expect(items.nth(0).getByTestId("maps-reason")).toContainText(
      "El sendero corta la playa; muévelo al este.",
    );
    await expect(items.nth(1).locator(".badge")).toHaveAttribute("data-status", "approved");
    await shot(authorPage, "maps-mine-reviewed");
    await authorPage.setViewportSize({ width: 375, height: 800 });
    await shot(authorPage, "maps-mine-phone");
    const { scroll, width } = await authorPage.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      width: window.innerWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(width);

    // Everything is in the audit log.
    const actions = psql(
      `SELECT string_agg(action, ',' ORDER BY id) FROM audit_log WHERE source = 'web' AND (actor_name = '${author.name}' OR target_name = '${author.name}')`,
    );
    expect(actions).toBe("map_submit,map_download,map_approve,map_submit,map_reject");
    await authorPage.context().close();
    await page.context().close();
  });
});
