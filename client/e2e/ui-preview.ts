// UI preview screenshots (make ui-preview, docs/08): builds the preview page (RPG_UI_PREVIEW=1,
// src/preview/), draws a piece of Puerto with mapcli for the map, and photographs each
// scene at desktop, tablet and phone sizes into e2e/screenshots/actual/ui-preview/. No game
// server, no Postgres and no HTTP server: Playwright answers every request from the build.
// A plain script, not a Playwright test (it has no .spec in its name).
//
//   node --experimental-strip-types client/e2e/ui-preview.ts [--no-build] [--only <scene>]
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { BrowserContextOptions } from "@playwright/test";

const client = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(client, "..");
const out = join(root, "build", "ui-preview");
const shots = join(client, "e2e", "screenshots", "actual", "ui-preview");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

/**
 * Puerto's temple square (grass, walls, cobbles, a sign and the market board) in the
 * middle of the server's 31x21 window with its margin of one tile: 33x23 tiles
 * (src/preview/main.tsx PICTURE).
 */
const MAP_TILES = { width: 33, height: 23 };
const MAP_AREA = `${3162 - 16},${6381 - 11},${MAP_TILES.width},${MAP_TILES.height}`;

if (!args.includes("--no-build")) {
  // Vite as the client resolves it (hoisted to the workspace root), run by this same node.
  const vite = join(
    dirname(createRequire(join(client, "package.json")).resolve("vite/package.json")),
    "bin",
    "vite.js",
  );
  execFileSync(process.execPath, [vite, "build", "--outDir", out, "--emptyOutDir"], {
    cwd: client,
    stdio: "inherit",
    env: { ...process.env, RPG_UI_PREVIEW: "1" },
  });
}
const mapPng = join(out, "preview-map.png");
execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    join(root, "tools", "mapcli", "src", "cli.ts"),
    "render",
    "puerto",
    "--floor",
    "7",
    "--area",
    MAP_AREA,
    "--tile",
    "32",
    "--no-overlays",
    "--no-grid",
    "--out",
    mapPng,
  ],
  { cwd: root, stdio: "ignore" },
);
// The rulers mapcli draws on the left and the top: whatever exceeds the area's tiles.
const png = readFileSync(mapPng);
const mapx = png.readUInt32BE(16) - MAP_TILES.width * 32;
const mapy = png.readUInt32BE(20) - MAP_TILES.height * 32;

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ogg": "audio/ogg",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

interface Size {
  name: string;
  opts: BrowserContextOptions;
}
const desktop = (w: number, h: number): Size => ({
  name: `${w}x${h}`,
  opts: { viewport: { width: w, height: h } },
});
const touch = (name: string, w: number, h: number): Size => ({
  name,
  opts: { viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
});
const SIZES: Size[] = [
  desktop(1920, 1080),
  desktop(1280, 800),
  desktop(1280, 720),
  desktop(960, 700),
  touch("phone-390x844", 390, 844),
  touch("phone-844x390", 844, 390),
  touch("tablet-768x1024", 768, 1024),
];

/** rpg.windows of each scene (ui/windows.ts format, version 3); absent = the defaults. */
const WINDOWS: Record<string, unknown> = {
  windows: {
    v: 3,
    z: ["guild"],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: true },
      skills: { open: true, collapsed: false },
      party: { open: true, collapsed: false },
      guild: { open: true, collapsed: false },
    },
  },
  guild: {
    v: 3,
    z: ["guild"],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: false },
      guild: { open: true, collapsed: false, x: 300, y: 40 },
    },
  },
  tooltip: {
    v: 3,
    z: [],
    win: {
      inventory: { open: true, collapsed: false },
      battle: { open: true, collapsed: true },
    },
  },
  // docs/17 UI-5: the inventory open, an item held over it.
  inventory: {
    v: 3,
    z: [],
    win: {
      inventory: { open: true, collapsed: false },
      battle: { open: true, collapsed: true },
    },
  },
  // The inventory floating over the map, wider (hud-fullscreen floats every window).
  inventoryfloat: {
    v: 3,
    z: ["inventory"],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: false, x: 300, y: 24, w: 420 },
    },
  },
  options: {
    v: 3,
    z: ["help", "options"],
    win: {
      options: { open: true, collapsed: false },
      help: { open: true, collapsed: false, x: 300, y: 24 },
    },
  },
  // docs/17 UI-5: the corpse's container where the player left it, resized.
  server: {
    v: 3,
    z: [],
    win: {
      battle: { open: true, collapsed: true },
      inventory: { open: true, collapsed: false },
    },
    others: {
      "container-creature_remains": { collapsed: false, x: 24, y: 300, w: 240 },
    },
  },
  // The magnet (docs/17 UI-5): windows dropped edge to edge, as the magnet leaves them —
  // the skills under the battle list, the party beside it.
  magnet: {
    v: 3,
    z: ["party", "skills"],
    win: {
      battle: { open: true, collapsed: false, x: 0, y: 0, h: 300 },
      skills: { open: true, collapsed: false, x: 0, y: 300 },
      party: { open: true, collapsed: false, x: 256, y: 0 },
      inventory: { open: true, collapsed: false },
    },
  },
  // An old save (version 1, the dock): the docked windows float at their default places.
  migrated: {
    v: 1,
    order: ["battle", "inventory", "skills", "party"],
    z: [],
    win: {
      battle: { open: true, dock: true, collapsed: false, h: 400 },
      inventory: { open: true, dock: true, collapsed: false },
      skills: { open: true, dock: true, collapsed: false },
    },
  },
};
/** Scenes about the inventory: on a phone or a tablet they open its tab. */
const INVENTORY_TAB = ["inventory", "tooltip", "tooltipcoin"];
/** What the mouse is over in a scene's screenshot. */
const HOVERS: Record<string, string> = {
  tooltip: '[data-testid="slot-right_hand"] [data-tip-item]',
  tooltipcoin: '[data-container][data-docked] [data-item="copper_coin"]',
  // docs/17 UI-5: a slot that does not take the held sword tints red under the pointer.
  inventory: '[data-testid="slot-left_hand"]',
};
const SCENES = [
  "game",
  "windows",
  "magnet",
  "migrated",
  "chat",
  "server",
  "groundtip",
  "scale",
  "options",
  "dialog",
  "shop",
  "dialog18",
  "itemmenu",
  "inventory",
  "inventoryfloat",
  "tooltip",
  "tooltipcoin",
  "guild",
  "danger",
  "death",
  "login",
  "characters",
];

mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const scene of SCENES.filter((s) => !only || s === only)) {
    for (const size of SIZES) {
      const context = await browser.newContext({ ...size.opts, reducedMotion: "no-preference" });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/api/")) {
          if (url.pathname === "/api/characters" && scene === "characters")
            return route.fulfill({
              json: {
                characters: [
                  { id: 1, name: "Aldric Varn", vocation: "guardian", level: 15 },
                  { id: 2, name: "Brisa Molina", vocation: "ranger", level: 9 },
                ],
              },
            });
          if (url.pathname === "/api/auth/config") return route.fulfill({ json: {} });
          return route.fulfill({ status: 401, json: { error: "unauthorized" } });
        }
        let path = decodeURIComponent(url.pathname);
        if (path.endsWith("/")) path += "index.html";
        const file = join(out, path);
        if (!file.startsWith(out) || !existsSync(file)) return route.fulfill({ status: 404 });
        return route.fulfill({
          body: readFileSync(file),
          contentType: TYPES[extname(file)] ?? "application/octet-stream",
        });
      });
      const page = await context.newPage();
      const windows = WINDOWS[scene];
      await page.addInitScript((w) => {
        localStorage.clear();
        if (w) localStorage.setItem("rpg.windows", JSON.stringify(w));
      }, windows ?? null);
      const sceneParam = [
        "windows",
        "magnet",
        "migrated",
        "chat",
        "options",
        "tooltip",
        "tooltipcoin",
        "inventoryfloat",
        "guild",
        "scale",
      ].includes(scene)
        ? "game"
        : scene;
      // docs/17 UI-3: the interface at 125 % with the text at 115 %.
      const scales = scene === "scale" ? "&ui=1.25&text=1.15" : "";
      await page.goto(
        `http://ui.preview/preview/?scene=${sceneParam}&mapx=${mapx}&mapy=${mapy}${scales}`,
      );
      await page.waitForSelector(".game, .panel");
      await page.evaluate(() => document.fonts.ready);
      // Let the open animations end (and the icons arrive).
      await page.waitForTimeout(700);
      // Phones and tablets: the inventory scenes show the inventory tab.
      if (INVENTORY_TAB.includes(scene)) {
        // A phone on its side keeps the panel in a drawer: open it first.
        const drawer = page.getByTestId("panel-toggle");
        if (await drawer.isVisible()) {
          await drawer.click();
          await page.waitForTimeout(300);
        }
        const tab = page.locator('[data-testid="panel-tabs"] [data-tab="inventory"]');
        if (await tab.isVisible()) {
          await tab.click();
          await page.waitForTimeout(150);
        }
      }
      // docs/17 UI-6: the card of an item under the mouse, at once (the Diablo II idea):
      // the sword in the right hand (stats, a requirement), the coins in the backpack (gold).
      const hover = HOVERS[scene];
      if (hover) {
        const el = page.locator(hover).first();
        if (await el.isVisible()) {
          await el.hover();
          await page.waitForTimeout(150);
        }
      }
      if (scene === "chat") {
        // docs/17 UI-10: the chat floats translucent; under the pointer it turns clear.
        const chat = page.locator('.gwin[data-window="chat"]');
        if (await chat.isVisible()) {
          await chat.hover();
          await page.waitForTimeout(300);
        }
      }
      await page.screenshot({ path: join(shots, `${scene}-${size.name}.png`) });
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`ui-preview: screenshots in ${shots}`);
