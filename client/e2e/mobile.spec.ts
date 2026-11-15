// T5.6: the game on a phone and a tablet (emulated touch screens), and the 1280x800 header
// with a long name. Every action goes through touch input (pointerType "touch"): taps from
// page.touchscreen, long presses and held fingers through CDP touch events (Chromium).
// The checks read what the server answered (positions, tile items, health, dialogs), not
// only the local UI. Screenshots go to e2e/screenshots/actual/mobile-*.png.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { devices, expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { psql } from "./psql.ts";
import { databaseUrl, serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });

/** A device of Playwright's list, on the suite's browser (Chromium: CDP touch events). */
function onChromium(name: string): Omit<(typeof devices)[string], "defaultBrowserType"> {
  const found = devices[name];
  if (!found) throw new Error(`unknown device ${name}`);
  // A describe group cannot switch the browser (that needs another worker): leave it out.
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = found;
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
}

function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

interface Self {
  x: number;
  y: number;
  z: number;
  pending: boolean;
  walking: boolean;
}

const self = async (page: Page): Promise<Self> => {
  const s = await page.evaluate(() => window.__rpgClient?.self());
  if (!s) throw new Error("no own creature");
  return s;
};

/** Waits until the own creature stands still, confirmed by the server, on (x, y). */
async function arrived(page: Page, x: number, y: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.__rpgClient?.self());
        return s && !s.pending && !s.walking ? `${s.x},${s.y}` : "moving";
      },
      { timeout: 20_000 },
    )
    .toBe(`${x},${y}`);
}

/** Waits until the own creature stands still and confirmed, wherever it is. */
async function settled(page: Page): Promise<Self> {
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.__rpgClient?.self());
        return s !== undefined && !s.pending && !s.walking;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return self(page);
}

async function newGuardian(
  playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } },
  tag: string,
  name = `${tag} ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`,
): Promise<{ email: string; password: string; name: string }> {
  const email = `e2e-${tag.toLowerCase()}-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  return { email, password, name };
}

/** Collects console errors and uncaught exceptions (the test fails on any). */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function enterGame(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  await page.waitForTimeout(300); // let the atlas textures upload before a screenshot
}

async function tileClient(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
    a: x,
    b: y,
  });
  if (!p) throw new Error("no canvas");
  return p;
}

/** Taps a map tile; fails if something over the map (a window, the pad) would take it. */
const tapTile = async (page: Page, x: number, y: number): Promise<void> => {
  const p = await tileClient(page, x, y);
  const hit = await page.evaluate(({ a, b }) => document.elementFromPoint(a, b)?.tagName ?? "", {
    a: p.x,
    b: p.y,
  });
  expect(hit, `tile ${x},${y} is covered`).toBe("CANVAS");
  await page.touchscreen.tap(p.x, p.y);
};

/** A finger held still on (x, y) for `ms` (a long press, or a held pad direction). */
async function hold(page: Page, x: number, y: number, ms: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function holdElement(page: Page, selector: string, ms: number): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no ${selector}`);
  await hold(page, box.x + box.width / 2, box.y + box.height / 2, ms);
}

const walkable = (page: Page, x: number, y: number, z: number): Promise<boolean> =>
  page.evaluate(({ a, b, c }) => window.__rpgClient?.walkable(a, b, c) ?? false, {
    a: x,
    b: y,
    c: z,
  });

/** A direction (pad id and step) whose next `n` tiles are walkable. */
async function openDirection(
  page: Page,
  from: Self,
  n: number,
): Promise<{ dir: string; dx: number; dy: number }> {
  const dirs = [
    { dir: "east", dx: 1, dy: 0 },
    { dir: "west", dx: -1, dy: 0 },
    { dir: "south", dx: 0, dy: 1 },
    { dir: "north", dx: 0, dy: -1 },
  ];
  for (const d of dirs) {
    let ok = true;
    for (let i = 1; i <= n && ok; i++)
      ok = await walkable(page, from.x + d.dx * i, from.y + d.dy * i, from.z);
    if (ok) return d;
  }
  throw new Error("no open direction around the player");
}

/** Shows a side panel tab: tabs under the map, or the drawer opened over it. */
async function showTab(page: Page, tab: string): Promise<void> {
  const toggle = page.getByTestId("panel-toggle");
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.tap();
  await page.getByTestId("panel-tabs").locator(`[data-tab="${tab}"]`).tap();
  await expect(page.locator(`[data-pane="${tab}"]`).first()).toBeVisible();
}

/** Closes the drawer (phone landscape) so the map takes taps again; no-op with tabs. */
async function closeDrawer(page: Page): Promise<void> {
  const toggle = page.getByTestId("panel-toggle");
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "true")
    await toggle.tap();
}

/**
 * The touch flow on the test island: walk by tapping a tile and with the pad (a tap is one
 * step, holding keeps walking), move the backpack to the ground with tap + destination and
 * back through the long-press menu, and say something in the chat.
 */
async function touchFlow(page: Page, prefix: string, layout: string): Promise<void> {
  const shot = (name: string): Promise<Buffer> =>
    page.screenshot({ path: join(shots, `mobile-${prefix}-${name}.png`) });
  await expect(page.getByTestId("game")).toHaveAttribute("data-layout", layout);
  // Nothing sticks out sideways (a phone browser would widen the page and zoom out).
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  // The map keeps a whole-number zoom and its 15x11 tiles on any screen.
  const scale = await page.evaluate(() => window.__rpgClient?.scale() ?? 0);
  expect(Number.isInteger(scale) && scale >= 1).toBe(true);
  // A touch screen shows the direction pad by default.
  const pad = page.getByTestId("touch-pad");
  await expect(pad).toBeVisible();
  await shot("01-world");

  // Walk: a tap on a tile two steps away (WalkPath, the server walks it).
  let me = await settled(page);
  let d = await openDirection(page, me, 2);
  await tapTile(page, me.x + 2 * d.dx, me.y + 2 * d.dy);
  await arrived(page, me.x + 2 * d.dx, me.y + 2 * d.dy);

  // The pad: a tap is one step.
  me = await self(page);
  d = await openDirection(page, me, 1);
  await pad.locator(`[data-dir="${d.dir}"]`).tap();
  await arrived(page, me.x + d.dx, me.y + d.dy);
  // Holding keeps walking at the walking speed (two steps or more).
  me = await self(page);
  d = await openDirection(page, me, 3);
  await holdElement(page, `[data-testid="touch-pad"] [data-dir="${d.dir}"]`, 1500);
  const after = await settled(page);
  const steps = Math.abs(after.x - me.x) + Math.abs(after.y - me.y);
  expect(steps).toBeGreaterThanOrEqual(2);
  expect({ x: Math.sign(after.x - me.x), y: Math.sign(after.y - me.y) }).toEqual({
    x: d.dx,
    y: d.dy,
  });
  await shot("02-walked");

  // Items without dragging: tap the backpack, then tap the own tile on the map.
  me = after;
  const backpackId = await page.evaluate(() => window.__rpgClient?.itemNumber("backpack"));
  await showTab(page, "inventory");
  const slot = page.getByTestId("slot-backpack");
  await slot.locator("[data-item=backpack]").tap();
  await expect(page.getByTestId("pick-banner")).toBeVisible();
  await expect(slot.locator("[data-picked]")).toHaveCount(1);
  await shot("03-picked");
  await closeDrawer(page);
  await tapTile(page, me.x, me.y);
  await expect(page.getByTestId("pick-banner")).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(({ a, b, c }) => window.__rpgClient?.tile(a, b, c)?.at(-1), {
        a: me.x,
        b: me.y,
        c: me.z,
      }),
    )
    .toBe(backpackId);
  await expect(page.getByTestId("slot-backpack").locator("[data-item]")).toHaveCount(0);

  // A long press on the tile opens its menu: "Mover" picks the backpack, a tap on the
  // empty slot equips it again.
  const p = await tileClient(page, me.x, me.y);
  await hold(page, p.x, p.y, 800);
  const menu = page.getByTestId("action-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-action="look"]')).toBeVisible();
  await shot("04-action-menu");
  await menu.locator('[data-action="move"]').tap();
  await expect(menu).toBeHidden();
  await expect(page.getByTestId("pick-banner")).toBeVisible();
  await showTab(page, "inventory");
  await page.getByTestId("slot-backpack").tap();
  await expect(page.getByTestId("slot-backpack").locator("[data-item=backpack]")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(({ a, b, c }) => window.__rpgClient?.tile(a, b, c)?.at(-1), {
        a: me.x,
        b: me.y,
        c: me.z,
      }),
    )
    .not.toBe(backpackId);

  // The chat tab: the input takes the text (the game gets no keys) and the server echoes it.
  await showTab(page, "chat");
  const say = page.getByTestId("say").getByRole("textbox");
  await say.tap();
  await say.fill("hola desde el teléfono");
  await say.press("Enter");
  await expect(page.getByTestId("chat-log")).toContainText("hola desde el teléfono");
  await shot("05-chat");
  await closeDrawer(page);
}

/** Walks north to the wolves of testisle and targets one with a tap on the map. */
async function tapWolf(page: Page, prefix: string): Promise<void> {
  const start = await settled(page);
  await tapTile(page, start.x, start.y - 5);
  await arrived(page, start.x, start.y - 5);
  await tapTile(page, start.x, start.y - 9);
  // Wolves move: tap the nearest one's tile until the client targets it.
  let target: number | undefined;
  await expect
    .poll(
      async () => {
        const wolves = await page.evaluate(() =>
          (window.__rpgClient?.monsters() ?? []).filter((m) => m.contentId === "wolf"),
        );
        const me = await self(page);
        // Only the 15x11 tiles drawn can be tapped (the client knows a row more).
        const drawn = wolves.filter((w) => Math.abs(w.x - me.x) <= 6 && Math.abs(w.y - me.y) <= 4);
        const near = drawn.sort(
          (a, b) =>
            Math.max(Math.abs(a.x - me.x), Math.abs(a.y - me.y)) -
            Math.max(Math.abs(b.x - me.x), Math.abs(b.y - me.y)),
        )[0];
        if (!near) return false;
        const before = await page.evaluate(() => window.__rpgClient?.target());
        if (before !== near.id) await tapTile(page, near.x, near.y);
        await page.waitForTimeout(300);
        target = await page.evaluate(() => window.__rpgClient?.target());
        return target !== undefined;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);
  // The server took the target: blows are exchanged (its health or ours goes down).
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const c = window.__rpgClient;
          const s = c?.stats();
          const t = c?.battle().find((b) => b.id === c.target());
          return (s !== undefined && s.health < s.maxHealth) || (t !== undefined && t.health < 100);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.screenshot({ path: join(shots, `mobile-${prefix}-06-combat.png`) });
}

/** In Puerto: a tap on the priestess talks to her; the window fits and closes with ×. */
async function talkToPriestess(page: Page, prefix: string): Promise<void> {
  let priest: { id: number; x: number; y: number } | undefined;
  await expect
    .poll(async () => {
      const list = await page.evaluate(() => window.__rpgClient?.npcs() ?? []);
      priest = list.find((n) => n.contentId === "puerto_priest");
      return priest !== undefined;
    })
    .toBe(true);
  if (!priest) throw new Error("no priestess");
  // A new character in Puerto gets the tutorial: fold its hints (they cover part of a
  // small map) with their button; the tutorial goes on.
  const hide = page.getByTestId("tutorial-hide");
  if (await hide.isVisible()) {
    await hide.tap();
    await expect(page.getByTestId("tutorial-show")).toBeVisible();
  }
  await tapTile(page, priest.x, priest.y);
  const dialog = page.getByTestId("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Hermana Liora");
  // The server's DialogOpen reached the client state, not only the window.
  expect(await page.evaluate(() => window.__rpgClient?.dialog() !== undefined)).toBe(true);
  // The window fits the screen and its close button is a 44 px target.
  const box = await dialog.boundingBox();
  const vp = page.viewportSize();
  if (!box || !vp) throw new Error("no dialog box");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  const close = dialog.getByRole("button", { name: "Cerrar" });
  const closeBox = await close.boundingBox();
  expect(closeBox?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(closeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: join(shots, `mobile-${prefix}-07-dialog.png`) });
  await close.tap();
  await expect(dialog).toBeHidden();
}

const DEVICES: { prefix: string; device: string; layout: string }[] = [
  { prefix: "pixel7-portrait", device: "Pixel 7", layout: "phone-portrait" },
  { prefix: "pixel7-landscape", device: "Pixel 7 landscape", layout: "phone-landscape" },
  { prefix: "ipad-mini", device: "iPad Mini", layout: "tablet" },
];

for (const { prefix, device, layout } of DEVICES) {
  test.describe(`T5.6 on ${device}`, () => {
    test.use(onChromium(device));

    test("touch: walk by tap and pad, move an item with tap + destination, chat", async ({
      page,
      playwright,
    }) => {
      test.setTimeout(150_000);
      const errors = watchErrors(page);
      const who = await newGuardian(playwright, "Touch");
      await enterGame(page, who.email, who.password);
      errors.length = 0; // the 401 of opening the page without a session cookie
      await touchFlow(page, prefix, layout);
      if (prefix === "pixel7-portrait") {
        // Targeting with a tap (once: finding a wolf can take a respawn).
        await tapWolf(page, prefix);
      }
      expect(errors).toEqual([]);
    });

    test("touch: a tap on an NPC talks to it", async ({ page, playwright }) => {
      const errors = watchErrors(page);
      const who = await newGuardian(playwright, "Talk");
      psql([databaseUrl, "-c", `UPDATE characters SET town = 'puerto' WHERE name = '${who.name}'`]);
      await enterGame(page, who.email, who.password);
      errors.length = 0;
      await talkToPriestess(page, prefix);
      expect(errors).toEqual([]);
    });
  });
}

test("T5.6: at 1280x800 a long name and its experience keep the map at 2x", async ({
  page,
  playwright,
}) => {
  const errors = watchErrors(page);
  // 20 characters, the longest name the server takes (auth.MaxNameLen).
  const name = `Longname ${randomLetters(11).replace(/^./, (c) => c.toUpperCase())}`;
  const who = await newGuardian(playwright, "Long", name);
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET level = 15, experience = 35280 WHERE name = '${who.name}'`,
  ]);
  await enterGame(page, who.email, who.password);
  errors.length = 0;
  await expect(page.getByTestId("experience")).toBeVisible();
  await expect(page.getByTestId("game")).toHaveAttribute("data-layout", "desktop");
  await page.screenshot({ path: join(shots, "mobile-desktop-1280-long-name.png") });
  // The header stays one line (the controls help is cut, not wrapped): before T5.6 it grew
  // to 6 lines with a name like this and pushed the map down to 1x.
  const header = await page.locator("header.hud").boundingBox();
  expect(header?.height ?? 999).toBeLessThan(80);
  expect(await page.evaluate(() => window.__rpgClient?.scale())).toBe(2);
  // No touch pad on a PC with a mouse (the Options switch can still turn it on).
  await expect(page.getByTestId("touch-pad")).toHaveCount(0);
  expect(errors).toEqual([]);
});
