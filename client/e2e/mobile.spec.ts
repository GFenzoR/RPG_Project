// T5.6: the game on a phone and a tablet (emulated touch screens), and the 1280x800 header
// with a long name. Every action goes through touch input (pointerType "touch"): taps from
// page.touchscreen; long presses, held fingers and pinches through CDP touch events on
// Chromium, and on WebKit (no CDP) through synthetic touch pointer events. The checks read
// what the server answered (positions, tile items, health, dialogs), not only the local
// UI. Screenshots go to e2e/screenshots/actual/mobile-*.png.
//
// The devices run on Chromium (Pixel 7, iPad Mini) and, in the "webkit-mobile" project of
// playwright.config.ts, on WebKit (iPhone 13, iPad Mini): those titles say "(webkit)".
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { devices, expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { psql } from "./psql.ts";
import { databaseUrl, serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });

/** A device of Playwright's list, on the project's browser (chromium or webkit-mobile). */
function deviceOptions(name: string): Omit<(typeof devices)[string], "defaultBrowserType"> {
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
  // The atlas textures are up and the map is on the canvas before any screenshot (a fixed
  // 300 ms before: not always enough on a slow runner drawing WebGL in software).
  await expect.poll(() => mapDrawn(page)).toBe(true);
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

/** The browser the page runs on ("chromium" or "webkit"). */
const browserOf = (page: Page): string =>
  page.context().browser()?.browserType().name() ?? "chromium";

interface Finger {
  id: number;
  x: number;
  y: number;
}

/**
 * WebKit has no CDP and Playwright only taps there: a held finger or a pinch is a series
 * of synthetic touch pointer events, each sent to the element under its finger when it
 * went down (a real touch is captured there too). Pointer id 1 is the only id
 * setPointerCapture accepts for a synthetic event (the pad captures its finger), so the
 * first finger must use it.
 */
async function fingers(
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup",
  list: Finger[],
): Promise<void> {
  await page.evaluate(
    ({ type, list }) => {
      const w = window as unknown as { e2eFingers?: Map<number, Element> };
      const held = w.e2eFingers ?? new Map<number, Element>();
      w.e2eFingers = held;
      for (const f of list) {
        let el = held.get(f.id);
        if (type === "pointerdown" || !el) {
          el = document.elementFromPoint(f.x, f.y) ?? document.body;
          held.set(f.id, el);
        }
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: f.id,
            pointerType: "touch",
            isPrimary: f.id === 1,
            clientX: f.x,
            clientY: f.y,
            button: type === "pointermove" ? -1 : 0,
            buttons: type === "pointerup" ? 0 : 1,
            width: 10,
            height: 10,
            pressure: type === "pointerup" ? 0 : 0.5,
          }),
        );
        if (type === "pointerup") held.delete(f.id);
      }
    },
    { type, list },
  );
}

/** A finger held still on (x, y) for `ms` (a long press, or a held pad direction). */
async function hold(page: Page, x: number, y: number, ms: number): Promise<void> {
  if (browserOf(page) !== "chromium") {
    await fingers(page, "pointerdown", [{ id: 1, x, y }]);
    await page.waitForTimeout(ms);
    await fingers(page, "pointerup", [{ id: 1, x, y }]);
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Two fingers on a horizontal line through (cx, cy) spread from `from` to `to` px apart. */
async function pinch(page: Page, cx: number, cy: number, from: number, to: number): Promise<void> {
  const at = (d: number): Finger[] => [
    { id: 1, x: cx - d / 2, y: cy },
    { id: 2, x: cx + d / 2, y: cy },
  ];
  const steps = [1, 2, 3, 4, 5].map((i) => from + ((to - from) * i) / 5);
  if (browserOf(page) !== "chromium") {
    await fingers(page, "pointerdown", at(from));
    for (const d of steps) await fingers(page, "pointermove", at(d));
    await fingers(page, "pointerup", at(to));
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const points = (d: number): { x: number; y: number; id: number }[] =>
    at(d).map((f) => ({ x: f.x, y: f.y, id: f.id }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
  for (const d of steps)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(d) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** The map's zoom: the scale drawn and the scales the player may choose. */
const zoomOf = async (page: Page): Promise<{ scale: number; min: number; max: number }> => {
  const z = await page.evaluate(() => window.__rpgClient?.zoom());
  if (!z) throw new Error("no canvas");
  return z;
};

const rememberedZoom = (page: Page): Promise<string | null> =>
  page.evaluate(() => localStorage.getItem("rpg.zoom"));

/**
 * Whether the map's drawing buffer holds a drawn map (a few pixels not of the black
 * background), read in the next animation frame, right after the renderer's (the buffer
 * is not preserved). Playwright's WebKit on Windows shows a WebGL canvas black in
 * screenshots once its size changes (a zoom, or a resize as before zooming existed),
 * although it is drawn: this checks what the screenshot cannot.
 */
const mapDrawn = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid="game-canvas"]');
          const gl = c?.getContext("webgl2") ?? c?.getContext("webgl");
          if (!c || !gl) return resolve(false);
          const px = new Uint8Array(4);
          for (const fx of [0.25, 0.5, 0.75])
            for (const fy of [0.25, 0.5, 0.75]) {
              const x = Math.floor(c.width * fx);
              const y = Math.floor(c.height * fy);
              gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
              if ((px[0] ?? 0) + (px[1] ?? 0) + (px[2] ?? 0) > 0) return resolve(true);
            }
          resolve(false);
        });
      }),
  );

/** Hotbar slots shown whole in the bar (the rest wait behind the slider's arrows). */
const wholeSlots = (page: Page): Promise<number> =>
  page.getByTestId("hotbar").evaluate((bar) => {
    const list = bar.querySelector("ol");
    if (!list) return 0;
    const box = list.getBoundingClientRect();
    return [...list.querySelectorAll("li")].filter((li) => {
      const b = li.getBoundingClientRect();
      return b.width > 0 && b.left >= box.left - 0.5 && b.right <= box.right + 0.5;
    }).length;
  });

/**
 * The map's zoom on a touch screen: the + and − buttons step one whole scale and the
 * choice is remembered on the device; a pinch zooms too. It always comes back to the
 * fitted view (the other steps count on the whole 15x11 tiles).
 */
async function zoomByTouch(page: Page, shot: (name: string) => Promise<Buffer>): Promise<void> {
  const fit = await zoomOf(page);
  // The fitted view is the smallest scale: never below what shows the 15x11 tiles.
  expect(fit.scale).toBe(fit.min);
  expect(fit.max).toBeGreaterThan(fit.min);
  const buttons = page.getByTestId("zoom-buttons");
  await expect(buttons).toBeVisible();
  await expect(page.getByTestId("zoom-out")).toBeDisabled();
  const zoomIn = page.getByTestId("zoom-in");
  for (const b of [zoomIn, page.getByTestId("zoom-out")]) {
    const box = await b.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await zoomIn.tap();
  await expect.poll(async () => (await zoomOf(page)).scale).toBe(fit.min + 1);
  expect(await rememberedZoom(page)).toBe(String(fit.min + 1));
  // Zoomed in, the canvas stays in the map's box: never under the pad or the hotbar.
  const canvas = await page.getByTestId("game-canvas").boundingBox();
  const pad = await page.getByTestId("touch-pad").boundingBox();
  if (!canvas || !pad) throw new Error("no canvas or pad");
  const vp = page.viewportSize();
  expect(canvas.x).toBeGreaterThanOrEqual(-0.5);
  expect(canvas.x + canvas.width).toBeLessThanOrEqual((vp?.width ?? 0) + 0.5);
  if (await page.locator('.game[data-flow="column"][data-pad]').count())
    expect(canvas.y + canvas.height).toBeLessThanOrEqual(pad.y + 0.5);
  // The resized canvas keeps drawing the map (on WebKit its screenshot is black: mapDrawn).
  await expect.poll(() => mapDrawn(page)).toBe(true);
  await shot("08-zoomed");
  await page.getByTestId("zoom-out").tap();
  await expect.poll(async () => (await zoomOf(page)).scale).toBe(fit.min);
  expect(await rememberedZoom(page)).toBeNull();

  // Two fingers spread to twice their distance: about twice the scale (whole, clamped).
  const map = await page.getByTestId("game-canvas").boundingBox();
  if (!map) throw new Error("no canvas");
  const cx = map.x + map.width / 2;
  const cy = map.y + map.height / 2;
  const spread = Math.min(map.width, map.height) / 4;
  await pinch(page, cx, cy, spread, 2 * spread);
  await expect.poll(async () => (await zoomOf(page)).scale).toBeGreaterThan(fit.min);
  // And back to the fitted view with the − button.
  for (let i = 0; i < fit.max - fit.min; i++) {
    if ((await zoomOf(page)).scale <= fit.min) break;
    await page.getByTestId("zoom-out").tap();
  }
  await expect.poll(async () => (await zoomOf(page)).scale).toBe(fit.min);
  expect(await rememberedZoom(page)).toBeNull();
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
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "true") {
    await toggle.tap();
    // Until its slide out ends the drawer still covers the right of the map (the zoom
    // buttons): a tap there meanwhile would hit the drawer.
    await expect(page.locator("#side-panel")).toBeHidden();
  }
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
  if (layout === "phone-portrait") {
    // Under the map, right of the pad: the slots on their own line under the arrows, at
    // least four whole ones on a 390-412 px phone (one fitted beside the arrows before).
    await expect.poll(() => wholeSlots(page)).toBeGreaterThanOrEqual(4);
    const bar = await page.getByTestId("hotbar").boundingBox();
    const map = await page.getByTestId("game-canvas").boundingBox();
    const padBox = await pad.boundingBox();
    if (!bar || !map || !padBox) throw new Error("no hotbar, map or pad");
    expect(bar.y).toBeGreaterThanOrEqual(map.y + map.height - 0.5);
    expect(bar.x).toBeGreaterThanOrEqual(padBox.x + padBox.width - 0.5);
    // Nothing covers the first slot.
    const first = page.getByTestId("hotbar").locator("li").first();
    expect(
      await first.evaluate((li) => {
        const r = li.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && li.contains(hit);
      }),
    ).toBe(true);
  }
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
  if (backpackId === undefined) throw new Error("no backpack item");
  // What the tile holds before: every touch test starts at the same spawn and walks the
  // same way, so one that failed earlier in the run (or a retry's first attempt) may have
  // left its backpack here. The checks compare the whole stack, not just the top item.
  const stack = (): Promise<number[] | undefined> =>
    page.evaluate(({ a, b, c }) => window.__rpgClient?.tile(a, b, c)?.slice(), {
      a: me.x,
      b: me.y,
      c: me.z,
    });
  const ground = await stack();
  if (!ground) throw new Error("own tile unknown");
  await showTab(page, "inventory");
  const slot = page.getByTestId("slot-backpack");
  await slot.locator("[data-item=backpack]").tap();
  await expect(page.getByTestId("pick-banner")).toBeVisible();
  await expect(slot.locator("[data-picked]")).toHaveCount(1);
  await shot("03-picked");
  await closeDrawer(page);
  await tapTile(page, me.x, me.y);
  await expect(page.getByTestId("pick-banner")).toBeHidden();
  await expect.poll(stack).toEqual([...ground, backpackId]);
  await expect(page.getByTestId("slot-backpack").locator("[data-item]")).toHaveCount(0);

  // A long press on the tile opens its menu: "Mover" picks the backpack, a tap on the
  // empty slot equips it again. The finger lifts well after the menu opened, as on a slow
  // runner: Chromium then clicks what is under it, and on a phone on its side that is the
  // menu (it takes the screen's height). The menu ignores that click (menuClickCounts).
  const p = await tileClient(page, me.x, me.y);
  await hold(page, p.x, p.y, 1200);
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
  await expect.poll(stack).toEqual(ground);

  // The chat tab: the input takes the text (the game gets no keys) and the server echoes it.
  await showTab(page, "chat");
  const say = page.getByTestId("say").getByRole("textbox");
  await say.tap();
  await say.fill("hola desde el teléfono");
  await say.press("Enter");
  await expect(page.getByTestId("chat-log")).toContainText("hola desde el teléfono");
  await shot("05-chat");
  await closeDrawer(page);

  // The map zoom: the + and − buttons and a pinch, by whole scales.
  await zoomByTouch(page, shot);
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

/**
 * Each device runs on one browser: Chromium (an Android phone, and the iPad as before) and
 * WebKit (the iPhone and the iPad, as Safari on iOS; the "webkit-mobile" project, which
 * picks the titles with "(webkit)"). Screenshot names of WebKit start with "webkit-".
 */
const DEVICES: { prefix: string; device: string; layout: string; browser: string }[] = [
  { prefix: "pixel7-portrait", device: "Pixel 7", layout: "phone-portrait", browser: "chromium" },
  {
    prefix: "pixel7-landscape",
    device: "Pixel 7 landscape",
    layout: "phone-landscape",
    browser: "chromium",
  },
  { prefix: "ipad-mini", device: "iPad Mini", layout: "tablet", browser: "chromium" },
  {
    prefix: "webkit-iphone13-portrait",
    device: "iPhone 13",
    layout: "phone-portrait",
    browser: "webkit",
  },
  {
    prefix: "webkit-iphone13-landscape",
    device: "iPhone 13 landscape",
    layout: "phone-landscape",
    browser: "webkit",
  },
  { prefix: "webkit-ipad-mini", device: "iPad Mini", layout: "tablet", browser: "webkit" },
];

for (const { prefix, device, layout, browser } of DEVICES) {
  const title = browser === "chromium" ? `T5.6 on ${device}` : `T5.6 on ${device} (${browser})`;
  test.describe(title, () => {
    test.use(deviceOptions(device));

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

/**
 * A notched phone (an iPhone 13's insets, on Chromium: CDP sets them; emulation has none):
 * `.game` keeps the game out of the notch, the rounded corners and the home indicator with
 * its padding, and the touch widgets over the map keep their margin from the map's edges,
 * so the inset counts once. Before, the pad, the hotbar beside it, the zoom buttons and the
 * picked-item banner added it a second time (on a phone on its side, 47 px more).
 */
const NOTCHED: {
  prefix: string;
  device: string;
  /** Portrait: the map on top and the pad in a strip under it. */
  column: boolean;
  insets: { top: number; left: number; right: number; bottom: number };
}[] = [
  {
    prefix: "pixel7-landscape",
    device: "Pixel 7 landscape",
    column: false,
    insets: { top: 0, left: 47, right: 47, bottom: 21 },
  },
  {
    prefix: "pixel7-portrait",
    device: "Pixel 7",
    column: true,
    insets: { top: 47, left: 0, right: 0, bottom: 34 },
  },
];

/** Hotbar offset beside the pad (PAD_RESERVE_PX in src/ui/TouchPad.tsx, touch.css). */
const PAD_RESERVE = 162;

for (const { prefix, device, column, insets } of NOTCHED) {
  test.describe(`T5.6 on ${device} with a notch`, () => {
    test.use(deviceOptions(device));

    test("touch: the safe area counts once, as the padding of the game", async ({
      page,
      playwright,
    }) => {
      const errors = watchErrors(page);
      const who = await newGuardian(playwright, "Notch");
      await enterGame(page, who.email, who.password);
      errors.length = 0;
      // The override lives as long as this CDP session: it stays attached to the end.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
      // The game takes the insets as its padding (env(safe-area-inset-*) in client.css).
      await expect
        .poll(() =>
          page.getByTestId("game").evaluate((g) => {
            const s = getComputedStyle(g);
            return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat);
          }),
        )
        .toEqual([insets.top, insets.right, insets.bottom, insets.left]);
      const box = async (
        testid: string,
      ): Promise<{ l: number; t: number; r: number; b: number }> => {
        const b = await page.getByTestId(testid).boundingBox();
        if (!b) throw new Error(`no ${testid}`);
        return { l: b.x, t: b.y, r: b.x + b.width, b: b.y + b.height };
      };
      /** Within a pixel (device pixels are 1/2.625 of a CSS pixel here). */
      const near = (what: string, actual: number, expected: number): void =>
        expect(Math.abs(actual - expected), `${what}: ${actual} (want ${expected})`).toBeLessThan(
          1,
        );
      const vp = page.viewportSize();
      if (!vp) throw new Error("no viewport size");
      // What the game draws starts and ends where the safe area does: the header at its
      // top, the body (the map, and in portrait the panel under it) at its bottom.
      const hud = await page.locator(".game > .hud").boundingBox();
      if (!hud) throw new Error("no header");
      near("header top", hud.y, insets.top);
      const body = await page.locator(".game-body").boundingBox();
      if (!body) throw new Error("no game body");
      near("body bottom", vp.height - (body.y + body.height), insets.bottom);
      // The map's box (the pad's strip included in portrait) is inside the safe area: on its
      // side the map reaches the bottom one, in portrait the panel lies under it.
      const mapBox = await page.locator(".viewport").boundingBox();
      if (!mapBox) throw new Error("no map box");
      const map = {
        l: mapBox.x,
        t: mapBox.y,
        r: mapBox.x + mapBox.width,
        b: mapBox.y + mapBox.height,
      };
      near("map left", map.l, insets.left);
      near("map right", vp.width - map.r, insets.right);
      if (!column) near("map bottom", vp.height - map.b, insets.bottom);
      // The widgets over it keep 8 px from its edges, not 8 px plus the inset again.
      const pad = await box("touch-pad");
      near("pad left", pad.l - map.l, 8);
      near("pad bottom", map.b - pad.b, 8);
      const hotbar = await box("hotbar");
      near("hotbar left", hotbar.l - map.l, PAD_RESERVE);
      const zoom = await box("zoom-buttons");
      near("zoom right", map.r - zoom.r, 8);
      // Picked, the backpack's banner goes top left of the map (in portrait, in the strip
      // beside the pad, where the zoom buttons were).
      await showTab(page, "inventory");
      await page.getByTestId("slot-backpack").locator("[data-item=backpack]").tap();
      await closeDrawer(page);
      const banner = await box("pick-banner");
      near("banner left", banner.l - map.l, column ? PAD_RESERVE : 8);
      if (column) near("banner right", map.r - banner.r, 8);
      await page.getByTestId("pick-cancel").tap();
      await expect(page.getByTestId("pick-banner")).toBeHidden();
      // Nothing sticks out sideways.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await expect.poll(() => mapDrawn(page)).toBe(true);
      await page.screenshot({ path: join(shots, `mobile-${prefix}-09-safe-area.png`) });
      await cdp.detach();
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
  // No touch pad on a PC with a mouse (the Options switch can still turn it on), and no
  // zoom buttons: a PC zooms with Ctrl+wheel.
  await expect(page.getByTestId("touch-pad")).toHaveCount(0);
  await expect(page.getByTestId("zoom-buttons")).toHaveCount(0);

  // The side column: the chat keeps its place at the bottom and the rest scrolls above it,
  // so the end of the inventory and of the appearance panel can be brought into view
  // (the chat used to stay over them at 1280x800).
  const uncovered = (testid: string): Promise<boolean> =>
    page.getByTestId(testid).evaluate((el) => {
      el.scrollIntoView({ block: "end" });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 3);
      return hit !== null && el.contains(hit);
    });
  expect(await uncovered("capacity")).toBe(true);
  expect(await uncovered("appearance-panel")).toBe(true);
  const chat = await page.getByTestId("say").boundingBox();
  const side = await page.locator("#side-panel").boundingBox();
  if (!chat || !side) throw new Error("no chat or side panel");
  expect(chat.y + chat.height).toBeLessThanOrEqual(side.y + side.height + 0.5);
  await page.screenshot({ path: join(shots, "mobile-desktop-1280-side-end.png") });

  // Ctrl+wheel over the map zooms by whole scales (and is remembered); a plain wheel
  // does not, and Ctrl+wheel the other way comes back to the fitted 2x.
  const map = await page.getByTestId("game-canvas").boundingBox();
  if (!map) throw new Error("no canvas");
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.wheel(0, -100);
  expect((await zoomOf(page)).scale).toBe(2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await zoomOf(page)).scale).toBe(3);
  expect(await rememberedZoom(page)).toBe("3");
  // Zoomed in, the canvas fills the map's box and stays inside it.
  const zoomed = await page.getByTestId("game-canvas").boundingBox();
  const box = await page.locator(".viewport").boundingBox();
  if (!zoomed || !box) throw new Error("no canvas");
  expect(zoomed.width).toBeGreaterThan(map.width);
  expect(zoomed.x).toBeGreaterThanOrEqual(box.x - 0.5);
  expect(zoomed.y + zoomed.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
  await page.screenshot({ path: join(shots, "mobile-desktop-1280-zoom3.png") });
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await zoomOf(page)).scale).toBe(2);
  expect(await rememberedZoom(page)).toBeNull();
  expect(errors).toEqual([]);
});
