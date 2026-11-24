// Fluid movement (client/CLAUDE.md "Movimiento fluido", docs/17 §4): a held arrow key, the
// mouse held on the map and a click-to-walk move the own creature on every frame, with no
// stop between tiles and no jump back; the second test does it through ~150 ms of round
// trip with jitter on the game's WebSocket (docs/17 MOV-9). Reads the positions the client
// recorded (`__rpgClient.trail`): the model's `WorldState.drawPos` in each `frame`, what
// the canvas draws from, in fractional tiles. Not the sprite or the camera on screen:
// their rounding to screen pixels is `render/viewport.test.ts`'s.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { faceKey } from "./keys.ts";
import { serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });

function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

const WAYS = [
  { key: "ArrowRight", dx: 1, dy: 0 },
  { key: "ArrowLeft", dx: -1, dy: 0 },
  { key: "ArrowDown", dx: 0, dy: 1 },
  { key: "ArrowUp", dx: 0, dy: -1 },
] as const;
type Way = { key: string; dx: number; dy: number };
/** The diagonals: two perpendicular arrows held together (docs/02 "Movimiento"). */
const DIAGONALS = [
  { keys: ["ArrowUp", "ArrowRight"], dx: 1, dy: -1, facing: "ne" },
  { keys: ["ArrowDown", "ArrowRight"], dx: 1, dy: 1, facing: "se" },
  { keys: ["ArrowDown", "ArrowLeft"], dx: -1, dy: 1, facing: "sw" },
  { keys: ["ArrowUp", "ArrowLeft"], dx: -1, dy: -1, facing: "nw" },
] as const;
type Tile = { x: number; y: number; z: number };

/** The shortest step at level 1: speed 205 on the fastest ground (100), in whole ticks. */
const MIN_STEP_MS = 500;
/** client/src/state/motion.ts STEP_LEAD_MS: the next step is decided this long before. */
const STEP_LEAD_MS = 50;

/**
 * About 150 ms of round trip plus jitter on the game's WebSocket (docs/17 MOV-9), as a
 * small proxy in Playwright: every message waits `oneWayMs` plus up to `jitterMs` each
 * way, in order (a message never overtakes the one before, like TCP).
 */
async function addLatency(page: Page, oneWayMs = 75, jitterMs = 40): Promise<void> {
  const link = (deliver: (m: string | Buffer) => void): ((m: string | Buffer) => void) => {
    const queue: { at: number; m: string | Buffer }[] = [];
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pump = (): void => {
      timer = undefined;
      const now = Date.now();
      while (queue[0] && queue[0].at <= now) deliver((queue.shift() as { m: string | Buffer }).m);
      if (queue[0]) timer = setTimeout(pump, queue[0].at - now);
    };
    return (m) => {
      last = Math.max(last, Date.now() + oneWayMs + Math.random() * jitterMs);
      queue.push({ at: last, m });
      timer ??= setTimeout(pump, Math.max(0, last - Date.now()));
    };
  };
  await page.routeWebSocket(
    (url) => url.pathname === "/ws",
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage(link((m) => server.send(m)));
      server.onMessage(link((m) => ws.send(m)));
    },
  );
}

/** A new guardian through the HTTP API, logged in on `page` and in the world. */
async function enter(page: Page, request: APIRequestContext, tag: string): Promise<void> {
  const email = `e2e-${tag}-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Fluido ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  expect((await request.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await request.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await request.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/play/?lang=es");
  const form = page.getByTestId("login-form");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Contraseña").fill(password);
  await form.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
}

/** Waits until the own creature stands still with every step confirmed; returns where. */
async function standing(page: Page): Promise<Tile> {
  let at: Tile | undefined;
  await expect
    .poll(
      async () => {
        const { s, drawn } = await page.evaluate(() => {
          const c = window.__rpgClient;
          return { s: c?.self(), drawn: c?.trail(200).at(-1) };
        });
        // The model stands still and a frame has drawn it there: `walking` ends at the
        // step's end time, which can come between two frames, and a trail read before the
        // next frame (motion) would end a fraction of a tile short of the tile.
        at =
          s &&
          !s.pending &&
          !s.walking &&
          drawn &&
          Math.abs(drawn.x - s.x) < 1e-6 &&
          Math.abs(drawn.y - s.y) < 1e-6
            ? { x: s.x, y: s.y, z: s.z }
            : undefined;
        return at !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  if (!at) throw new Error("never stood still");
  return at;
}

/** Portals that move whoever steps on them (docs/02 "Cambiar de piso"): a run stops there. */
const PORTALS = ["stairs_down", "stairs_up", "hole", "teleport"];

/**
 * How many free tiles in a row lie ahead of `from` along `way`, up to `max`: walkable, no
 * creature, no stairs, hole or teleport.
 */
async function freeRun(page: Page, from: Tile, way: Way, max: number): Promise<number> {
  return page.evaluate(
    ({ s, dx, dy, max, portals }) => {
      const c = window.__rpgClient;
      if (!c) return 0;
      const moves = new Set(portals.map((id) => c.itemNumber(id)));
      let i = 0;
      for (; i < max; i++) {
        const x = s.x + dx * (i + 1);
        const y = s.y + dy * (i + 1);
        if (!c.walkable(x, y, s.z) || c.tile(x, y, s.z)?.some((id) => moves.has(id))) break;
      }
      return i;
    },
    { s: from, dx: way.dx, dy: way.dy, max, portals: PORTALS },
  );
}

/**
 * The way with the longest free run from `from` (at least `least` tiles). With `aims`
 * (tiles ahead the mouse may press), only a way with one of them bare (just its ground:
 * no item to drag, so the press walks at once) and on the map's canvas at the screen (no
 * window over it): `aim` is the first such.
 */
async function pickWay(
  page: Page,
  from: Tile,
  least: number,
  max: number,
  aims: number[] = [],
): Promise<{ way: Way; run: number; aim: number; at: { x: number; y: number } }> {
  let best: { way: Way; run: number; aim: number; at: { x: number; y: number } } | undefined;
  for (const way of WAYS) {
    const run = await freeRun(page, from, way, max);
    if (run < least || (best && run <= best.run)) continue;
    if (aims.length === 0) {
      best = { way, run, aim: 0, at: { x: 0, y: 0 } };
      continue;
    }
    for (const aim of aims) {
      const t = tileAt(from, way, aim);
      const bare = await page.evaluate(
        ({ x, y, z }) => window.__rpgClient?.tile(x, y, z)?.length === 1,
        t,
      );
      const at = bare ? await onCanvas(page, t) : undefined;
      if (at) {
        best = { way, run, aim, at };
        break;
      }
    }
  }
  if (!best) throw new Error(`no straight run of ${least} free tiles from ${JSON.stringify(from)}`);
  return best;
}

const tileAt = (from: Tile, way: Way, n: number): Tile => ({
  x: from.x + way.dx * n,
  y: from.y + way.dy * n,
  z: from.z,
});

/** Page coordinates of a tile's centre, if the canvas (not a window) is what is there. */
async function onCanvas(page: Page, t: Tile): Promise<{ x: number; y: number } | undefined> {
  return page.evaluate(({ x, y }) => {
    const p = window.__rpgClient?.tileToClient(x, y);
    const el = p && document.elementFromPoint(p.x, p.y);
    return p && el instanceof HTMLCanvasElement && el.dataset["testid"] === "game-canvas"
      ? p
      : undefined;
  }, t);
}

/** Polls the client's own position (its last prediction) until it is `n` tiles from `from`. */
async function predictedAway(page: Page, from: Tile, n: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.__rpgClient?.self());
        return s ? Math.max(Math.abs(s.x - from.x), Math.abs(s.y - from.y)) : 0;
      },
      { timeout: 20_000, intervals: [20] },
    )
    .toBeGreaterThanOrEqual(n);
}

interface Motion {
  /** The frames from the last one on the start tile to the first on the end tile. */
  frames: number;
  /** Frames that stood still, and that went back. */
  stalls: number;
  back: number;
  biggest: number;
  /** When the drawing left the start (the frame before the first that moved) and reached the end. */
  leftAt: number;
  arrivedAt: number;
  /** The frame gap at the arrival (the arrival is known to within it). */
  lastGap: number;
}

/**
 * Reads the trail of the last `ms` along `way` from `start`: every frame from leaving the
 * first tile to reaching `tiles` tiles away must have moved along the way.
 */
async function motion(
  page: Page,
  ms: number,
  start: Tile,
  way: Way,
  tiles: number,
): Promise<Motion> {
  const trail = await page.evaluate((ms) => window.__rpgClient?.trail(ms) ?? [], ms);
  const along = trail.map((s) => ({
    t: s.t,
    d: (s.x - start.x) * way.dx + (s.y - start.y) * way.dy,
  }));
  // The window can begin on the end of the walk before, which ended on `start` and may have
  // come back along `way` (ArrowRight, the first of WAYS, after ten tiles to the left): the
  // walk measured begins after the drawing first stands at or behind the start.
  const home = along.findIndex((s) => s.d <= 0);
  const first = along.findIndex((s, i) => i > home && s.d > 0);
  const last = along.findIndex((s, i) => i > first && s.d >= tiles);
  expect(first).toBeGreaterThan(0);
  expect(last).toBeGreaterThan(first);
  const walking = along.slice(first - 1, last + 1);
  let stalls = 0;
  let back = 0;
  let biggest = 0;
  for (let i = 1; i < walking.length; i++) {
    const a = walking[i - 1];
    const b = walking[i];
    if (!a || !b || b.t - a.t < 1) continue;
    const step = b.d - a.d;
    if (step <= 1e-9) stalls++;
    if (step < -1e-9) back++;
    biggest = Math.max(biggest, step);
  }
  return {
    frames: walking.length,
    stalls,
    back,
    biggest,
    leftAt: along[first - 1]?.t ?? 0,
    arrivedAt: along[last]?.t ?? 0,
    lastGap: (along[last]?.t ?? 0) - (along[last - 1]?.t ?? 0),
  };
}

const now = (page: Page): Promise<number> => page.evaluate(() => performance.now());

test("a held arrow key walks tile after tile without stopping between them", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const api = await playwright.request.newContext({ baseURL: serverURL });
  await enter(page, api, "walk");
  await api.dispose();
  errors.length = 0; // the 401 of opening the page without a session cookie

  // The longest straight run of free tiles (up to 10) from where the character wakes up;
  // at least 6.
  const start = await standing(page);
  const { way: dir, run } = await pickWay(page, start, 6, 10);
  await page.waitForTimeout(300); // let the atlas textures upload
  // Facing another way, the key would turn first and walk 80 ms later (docs/17 MOV-2).
  await faceKey(page, dir.key);

  // Hold the key 2 s (4 or 5 steps of 500 ms at level 1), then let go. The screenshot is
  // taken after letting go, on the last step: taken while the key is held, a slow capture
  // (software WebGL in the CI) would hold it longer and walk more.
  const t0 = await now(page);
  await page.keyboard.down(dir.key);
  await page.waitForTimeout(2000);
  await page.keyboard.up(dir.key);
  const held = (await now(page)) - t0;
  await page.screenshot({ path: join(shots, "96-movement-held-key.png") });
  const end = await standing(page);
  const t1 = await now(page);
  const tiles = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
  // The first step starts after t0, and each next one is decided STEP_LEAD_MS before the
  // one drawn ends: no more than this many while the key was down (fewer on slower ground),
  // and never past the free run (the client does not predict into a blocked tile).
  const most = Math.min(run, Math.floor((held + STEP_LEAD_MS) / MIN_STEP_MS) + 1);
  expect(tiles).toBeGreaterThanOrEqual(4);
  expect(tiles).toBeLessThanOrEqual(most);
  expect(end.z).toBe(start.z);

  // Every frame from leaving the first tile to reaching the last one moved along the way.
  const m = await motion(page, t1 - t0 + 500, start, dir, tiles);
  console.log(
    `held ${dir.key}: ${tiles} tiles in ${m.frames} frames, ${m.stalls} still, biggest ${m.biggest.toFixed(3)} tile`,
  );
  expect(m.frames).toBeGreaterThan(8 * tiles); // frames were drawn (~30 a tile at 60 fps)
  expect(m.back).toBe(0); // never pulled back
  expect(m.stalls).toBe(0); // never stood still between tiles
  expect(errors).toEqual([]);
});

test("with ~150 ms of latency a held key, the mouse held and a click all walk without a still frame", async ({
  page,
  playwright,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  // 75 ms plus 0–40 ms each way: a round trip of 150 to 230 ms, in order.
  await addLatency(page);
  const api = await playwright.request.newContext({ baseURL: serverURL });
  await enter(page, api, "lag");
  await api.dispose();
  errors.length = 0;
  await page.waitForTimeout(300); // let the atlas textures upload

  // 1. MOV-9: a held arrow, 10 tiles, takes the 10 steps' time to within a frame and never
  //    stands still, although every Walk is confirmed ~150 ms later.
  const a = await standing(page);
  const { way: keyWay } = await pickWay(page, a, 10, 12);
  await faceKey(page, keyWay.key); // so the held key walks at once (MOV-2)
  const ta = await now(page);
  await page.keyboard.down(keyWay.key);
  await predictedAway(page, a, 10); // the 10th step is predicted: let go
  await page.keyboard.up(keyWay.key);
  const aEnd = await standing(page);
  const aTiles = Math.abs(aEnd.x - a.x) + Math.abs(aEnd.y - a.y);
  expect(aTiles).toBeGreaterThanOrEqual(10);
  expect(aTiles).toBeLessThanOrEqual(11); // one more at most, decided before the release
  const key = await motion(page, (await now(page)) - ta + 500, a, keyWay, 10);
  // The ten steps' time, each on its own ground at the player's speed.
  let steps = 0;
  for (let i = 1; i <= 10; i++) {
    const t = tileAt(a, keyWay, i);
    steps += await page.evaluate(({ x, y, z }) => window.__rpgClient?.stepMs(x, y, z) ?? 0, t);
  }
  const took = key.arrivedAt - key.leftAt;
  console.log(
    `lag, held ${keyWay.key}: 10 tiles in ${took.toFixed(0)} ms (steps ${steps} ms), ${key.frames} frames, ${key.stalls} still`,
  );
  expect(key.stalls).toBe(0);
  expect(key.back).toBe(0);
  expect(took).toBeGreaterThanOrEqual(steps - 1);
  expect(took).toBeLessThanOrEqual(steps + key.lastGap + 1);

  // 2. MOV-3: the mouse held 2 to 4 tiles ahead on the screen walks toward it (the camera
  //    follows: it stays ahead), tile after tile, until it is let go; the steps already
  //    sent are taken, no more.
  const b = await standing(page);
  const { way: mouseWay, at: aim } = await pickWay(page, b, 6, 10, [3, 2, 4]);
  await page.mouse.move(aim.x, aim.y);
  const tb = await now(page);
  await page.mouse.down();
  await predictedAway(page, b, 4);
  await page.mouse.up();
  const bEnd = await standing(page);
  const bTiles = Math.abs(bEnd.x - b.x) + Math.abs(bEnd.y - b.y);
  expect(bTiles).toBeGreaterThanOrEqual(4);
  expect(bTiles).toBeLessThanOrEqual(5);
  const held = await motion(page, (await now(page)) - tb + 500, b, mouseWay, bTiles);
  console.log(
    `lag, mouse held ${mouseWay.key}: ${bTiles} tiles, ${held.frames} frames, ${held.stalls} still`,
  );
  expect(held.stalls).toBe(0);
  expect(held.back).toBe(0);
  expect(held.leftAt - tb).toBeLessThan(150); // it walks from the press, not a round trip later
  await page.screenshot({ path: join(shots, "96b-movement-lag-mouse-held.png") });

  // 3. MOV-4, MOV-7: a click 5 to 7 tiles away walks there at once, predicted, without a
  //    stop.
  const c = await standing(page);
  const { way: clickWay, aim: far, at: target } = await pickWay(page, c, 7, 8, [6, 5, 7]);
  const goal = tileAt(c, clickWay, far);
  const tc = await now(page);
  await page.mouse.click(target.x, target.y);
  await page.screenshot({ path: join(shots, "96c-movement-lag-click.png") }); // its ring, if in time
  const cEnd = await standing(page);
  expect(cEnd).toEqual(goal);
  const click = await motion(page, (await now(page)) - tc + 500, c, clickWay, far);
  console.log(
    `lag, click ${clickWay.key} ${far} tiles: left ${(click.leftAt - tc).toFixed(0)} ms after the click, ${click.frames} frames, ${click.stalls} still`,
  );
  expect(click.stalls).toBe(0);
  expect(click.back).toBe(0);
  // Before MOV-4 the first step waited a round trip and a tick (≥ 150 ms here).
  expect(click.leftAt - tc).toBeLessThan(150);
  expect(errors).toEqual([]);
});

test("two arrows walk the diagonal at the straight speed, the person turned to it", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const api = await playwright.request.newContext({ baseURL: serverURL });
  await enter(page, api, "diagonal");
  await api.dispose();
  errors.length = 0; // the 401 of opening the page without a session cookie

  const start = await standing(page);
  let best: { d: (typeof DIAGONALS)[number]; run: number } | undefined;
  for (const d of DIAGONALS) {
    const run = await freeRun(page, start, { key: d.keys[0], dx: d.dx, dy: d.dy }, 6);
    if (!best || run > best.run) best = { d, run };
  }
  if (!best || best.run < 3) throw new Error(`no diagonal run of 3 from ${JSON.stringify(start)}`);
  const { d } = best;
  await page.waitForTimeout(300); // let the atlas textures upload

  // Both keys at once: the first step is the diagonal. Mid-walk, the person is drawn
  // facing it (docs/17 ANI-1: the engine humanoid has eight facings).
  const t0 = await now(page);
  for (const k of d.keys) await page.keyboard.down(k);
  await page.waitForTimeout(1100);
  const drawn = await page.evaluate(() => window.__rpgClient?.drawnFacing());
  await page.screenshot({ path: join(shots, "96d-movement-diagonal.png") });
  for (const k of d.keys) await page.keyboard.up(k);
  const end = await standing(page);
  const held = (await now(page)) - t0;
  expect(drawn).toEqual({ facing: d.facing, eight: true });
  const n = Math.abs(end.x - start.x);
  expect(n).toBeGreaterThanOrEqual(1);
  expect(end.x - start.x).toBe(d.dx * n);
  expect(end.y - start.y).toBe(d.dy * n); // a pure diagonal, never a straight step
  // docs/02: a diagonal step lasts the straight one x sqrt(2), rounded to the tick.
  const straight = await page.evaluate(
    ({ x, y, z }) => window.__rpgClient?.stepMs(x, y, z) ?? 0,
    end,
  );
  console.log(
    `held ${d.keys.join("+")}: ${n} diagonal steps in ${Math.round(held)} ms, straight ${straight} ms`,
  );
  expect(n).toBeLessThanOrEqual(Math.floor(held / (MIN_STEP_MS * 1.4)) + 1);
  expect(errors).toEqual([]);
});
