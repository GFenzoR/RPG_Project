// UI preview screenshots (make ui-preview, docs/08): builds the preview page (RPG_UI_PREVIEW=1,
// src/preview/), draws a piece of Puerto with mapcli for the map, and photographs each
// scene at desktop, tablet and phone sizes into e2e/screenshots/actual/ui-preview/. No game
// server, no Postgres and no HTTP server: Playwright answers every request from the build.
// A plain script, not a Playwright test (it has no .spec in its name).
//
//   node --experimental-strip-types client/e2e/ui-preview.ts [--no-build] [--only <scene>[,<scene>]] [--sizes <part>[,<part>]]
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { BrowserContextOptions } from "@playwright/test";
import { formatFindings, touchAudit } from "./touch-audit.ts";
import type { Insets, TouchFinding } from "./touch-audit.ts";

const client = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(client, "..");
const out = join(root, "build", "ui-preview");
const shots = join(client, "e2e", "screenshots", "actual", "ui-preview");
const args = process.argv.slice(2);
// --only takes one scene or several, comma separated; --sizes keeps the sizes whose name
// has one of its comma separated parts ("phone,tablet": the touch sizes).
const listArg = (flag: string): string[] | undefined =>
  args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? "").split(",").filter(Boolean) : undefined;
const only = listArg("--only");
const sizes = listArg("--sizes");
// --audit: the touch audit (e2e/touch-audit.ts, docs/08) of every scene at the touch sizes;
// findings go to build/ui-preview/touch-audit.json and the script exits 1 with any.
// --lang es|en picks the language; --notch draws each touch size with the safe-area insets
// of a phone with a notch and a home bar (and the audit checks nothing sits under them).
const audit = args.includes("--audit");
const lang = listArg("--lang")?.[0] ?? "es";
const notch = args.includes("--notch");
// --covered: also list big enough controls that something covers in part (to hunt overlaps).
const covered = args.includes("--covered");

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
  ".webp": "image/webp",
  ".ogg": "audio/ogg",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

interface Size {
  name: string;
  opts: BrowserContextOptions;
  /** A touch size: the audit runs here, and --notch gives it these insets. */
  insets?: Insets;
}
const desktop = (w: number, h: number): Size => ({
  name: `${w}x${h}`,
  opts: { viewport: { width: w, height: h } },
});
const touch = (name: string, w: number, h: number): Size => ({
  name,
  opts: { viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  // A notch on the short side at the top (or at the left, on its side) and a home bar.
  insets:
    w < h
      ? { top: 47, right: 0, bottom: 34, left: 0 }
      : { top: 0, right: 47, bottom: 21, left: 47 },
});
const SIZES: Size[] = [
  desktop(1920, 1080),
  desktop(1280, 800),
  desktop(1280, 720),
  desktop(960, 700),
  touch("phone-390x844", 390, 844),
  touch("phone-844x390", 844, 390),
  // A phone on its side inside the browser, as measured on a Galaxy S22 Ultra (lote 21):
  // the address bar and the system buttons leave 298 px of height.
  touch("phone-748x298", 748, 298),
  touch("tablet-768x1024", 768, 1024),
  touch("tablet-1024x768", 1024, 768),
];

/** rpg.windows of each scene (ui/windows.ts format, version 3); absent = the defaults. */
const WINDOWS: Record<string, unknown> = {
  // docs/17 UI-5: every window of the toolbar open at once, none moved: the skills, the
  // trade and the windows over the bar take a factory place that sees the others
  // (ui/windows.ts defaultPlace), and the tutorial's hint gives way to the help.
  allwindows: {
    v: 3,
    z: [],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: false },
      party: { open: true, collapsed: false },
      guild: { open: true, collapsed: false },
      appearance: { open: true, collapsed: false },
      options: { open: true, collapsed: false },
      help: { open: true, collapsed: false },
      skills: { open: true, collapsed: false },
      quests: { open: true, collapsed: false },
    },
  },
  // The quest log (docs/02 "Diario de misiones", key L) at its factory place, beside the
  // equipment: the active tab (a kill step 5/8, a side quest), and in questsdone the
  // finished one (a task cooling down 2 h 14 min, one back already, chapter 1 done).
  quests: {
    v: 3,
    z: ["quests"],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: false },
      quests: { open: true, collapsed: false },
    },
  },
  questsdone: {
    v: 3,
    z: ["quests"],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: false },
      quests: { open: true, collapsed: false },
    },
  },
  // docs/02 "Quests de hito": the quest log's milestones tab (one not started with a missing
  // key, one in progress, one done).
  questsmilestones: {
    v: 3,
    z: ["quests"],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: false },
      quests: { open: true, collapsed: false },
    },
  },
  // docs/02 "Apariencia": the Apariencia window at its factory place with a look being
  // picked (Personalizar: the figure and the pickers over the cosmetics).
  appearance: {
    v: 3,
    z: ["appearance"],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: false },
      appearance: { open: true, collapsed: false },
    },
  },
  // The tutorial's hint gives way to the help at its factory place (docs/17 UI-5).
  tutorialhelp: {
    v: 3,
    z: ["help"],
    win: {
      battle: { open: true, collapsed: false },
      inventory: { open: true, collapsed: false },
      help: { open: true, collapsed: false },
    },
  },
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
  // docs/02 "Bolsillos": the inventory without a backpack, only the pockets.
  pockets: {
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
  // docs/17 UI-5: the corpse's container where the player left it, resized; a second one
  // (container-remains-2: every remains shares one place) at its default place, right under
  // the equipment.
  server: {
    v: 3,
    z: [],
    win: {
      battle: { open: true, collapsed: true },
      inventory: { open: true, collapsed: false },
    },
    others: {
      "container-remains": { collapsed: false, x: 24, y: 300, w: 240 },
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
const INVENTORY_TAB = ["inventory", "pockets", "tooltip", "tooltipcoin"];
/** Scenes about the quest log: on a phone or a tablet they open its tab. */
const QUESTS_TAB = ["quests", "questsdone", "questsmilestones"];
/** Scenes about the Apariencia window: on a phone or a tablet they open its tab. */
const APPEARANCE_TAB = ["appearance"];
/** What the mouse is over in a scene's screenshot. */
const HOVERS: Record<string, string> = {
  tooltip: '[data-testid="slot-right_hand"] [data-tip-item]',
  tooltipcoin: '[data-container][data-docked] [data-item="copper_coin"]',
  // docs/17 UI-5: a slot that does not take the held sword tints red under the pointer.
  inventory: '[data-testid="slot-left_hand"]',
  // docs/02 "Bolsillos": the card of the potion in a pocket.
  pockets: '[data-testid="pocket-1"] [data-tip-item]',
};
const SCENES = [
  "game",
  "status",
  "allwindows",
  "trade",
  "chattabs",
  "tutorialhelp",
  "tutorialshop",
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
  "pockets",
  "itemkeys",
  "inventoryfloat",
  "tooltip",
  "tooltipcoin",
  "guild",
  "quests",
  "questsdone",
  "questsmilestones",
  "forge",
  "forgerisk",
  "forgeresult",
  "book",
  "scroll",
  "danger",
  "death",
  "login",
  "characters",
  // docs/02 "Cuentas": an account without characters goes straight to the form.
  "createfirst",
  "appearance",
  // docs/17 "UI movil": the states of the mobile HUD (on the desktop sizes they show the
  // same things on the floating windows' screen).
  "social", // a party and a guild invitation and the presence check, at once
  "voyage", // the fade of a boat trip
  "mobilemenu", // the menu that replaced the header's hamburger (desktop: Options)
  "mobilechat", // the whole chat, opened from the compact log over the map
  "mobilebattle", // the battle section in the sheet (or drawer)
  "mobilenopad", // without the direction pad (Options): the console is the buttons alone
  "mobilemap", // the minimap unfolded, with the tracked objective
  // Lote 21 (docs/15): the touch controls in their other shapes.
  "touchstick", // the analog stick instead of the pad
  "touchleft", // left-handed and large: the buttons at the left thumb, the stick at the right
];
/**
 * What the touch audit lets through, each with its reason. Keep it short: a finding is a
 * bug until someone decides otherwise.
 */
const AUDIT_ALLOW: { scene?: string; re: RegExp }[] = [
  // The item menu of this scene is the one a mouse opens (30 px rows, at the cursor); a
  // long press opens the 44 px one, which e2e/mobile-qa.spec.ts measures in the game.
  { scene: "itemmenu", re: /^tap button\.touch-menu-action/ },
  // A spell's name in its slot is cut on purpose (the whole name is the slot's label).
  { re: /^clip button "F\d+/ },
  // The title of a narrow floating window, on a tablet on its side (the desktop screen).
  { re: /^clip h2\.gwin-title/ },
];
const findings: { scene: string; size: string; found: TouchFinding[] }[] = [];

/** Scenes of the mobile HUD that are the base scene plus taps of this script. */
const MOBILE_TAPS = [
  "mobilemenu",
  "mobilechat",
  "mobilebattle",
  "mobilenopad",
  "mobilemap",
  "touchstick",
  "touchleft",
];

mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
try {
  for (const scene of SCENES.filter((s) => !only || only.includes(s))) {
    for (const size of SIZES.filter((z) => !sizes || sizes.some((p) => z.name.includes(p)))) {
      const context = await browser.newContext({ ...size.opts, reducedMotion: "no-preference" });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/api/")) {
          if (url.pathname === "/api/characters" && scene === "characters")
            return route.fulfill({
              json: {
                // At the limit: "Crear personaje nuevo" is disabled with its reason.
                max_characters: 2,
                characters: [
                  {
                    id: 1,
                    name: "Aldric Varn",
                    vocation: "guardian",
                    level: 15,
                    look: {
                      sex: "male",
                      body: "sturdy",
                      skin: "tan",
                      hair: "short",
                      hair_color: "brown",
                      beard: "full",
                    },
                  },
                  {
                    id: 2,
                    name: "Brisa Molina",
                    vocation: "ranger",
                    level: 9,
                    look: {
                      sex: "female",
                      body: "slender",
                      skin: "olive",
                      hair: "long",
                      hair_color: "red",
                      beard: "none",
                    },
                  },
                ],
              },
            });
          if (url.pathname === "/api/characters" && scene === "createfirst")
            return route.fulfill({ json: { characters: [], max_characters: 10 } });
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
      const insets = notch ? size.insets : undefined;
      if (insets) {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
      }
      const windows = WINDOWS[scene];
      await page.addInitScript((w) => {
        localStorage.clear();
        if (w) localStorage.setItem("rpg.windows", JSON.stringify(w));
      }, windows ?? null);
      const sceneParam = [
        "allwindows",
        "windows",
        "magnet",
        "migrated",
        "chat",
        "options",
        "tooltip",
        "tooltipcoin",
        "inventoryfloat",
        "guild",
        "quests",
        "questsdone",
        "questsmilestones",
        "scale",
        ...MOBILE_TAPS,
      ].includes(scene)
        ? "game"
        : scene;
      // docs/17 UI-3: the interface at 125 % with the text at 115 %.
      const scales =
        scene === "scale"
          ? "&ui=1.25&text=1.15"
          : scene === "mobilenopad"
            ? "&pad=0"
            : scene === "touchstick"
              ? "&stick=1"
              : scene === "touchleft"
                ? "&stick=1&mirror=1&size=large"
                : "";
      await page.goto(
        `http://ui.preview/preview/?scene=${sceneParam}&mapx=${mapx}&mapy=${mapy}${scales}&lang=${lang}`,
      );
      await page.waitForSelector(".game, .panel");
      await page.evaluate(() => document.fonts.ready);
      // Let the open animations end (and the icons arrive).
      await page.waitForTimeout(700);
      // docs/02 "Apariencia": the live figure walks in place; the shot waits for the atlas.
      if (scene === "characters" || scene === "createfirst" || scene === "appearance")
        await page.waitForTimeout(600);
      // Phones and tablets: the inventory and quest log scenes show their tab.
      if (
        INVENTORY_TAB.includes(scene) ||
        QUESTS_TAB.includes(scene) ||
        APPEARANCE_TAB.includes(scene)
      ) {
        // A phone on its side keeps the panel in a drawer: open it first.
        const drawer = page.getByTestId("panel-toggle");
        if (await drawer.isVisible()) {
          await drawer.click();
          await page.waitForTimeout(300);
        }
        const name = QUESTS_TAB.includes(scene)
          ? "quests"
          : APPEARANCE_TAB.includes(scene)
            ? "appearance"
            : "inventory";
        const tab = page.locator(`[data-testid="panel-tabs"] [data-tab="${name}"]`);
        if (await tab.isVisible()) {
          await tab.click();
          await page.waitForTimeout(150);
        }
      }
      // docs/17 "UI movil": the mobile HUD's own states, by the taps a player gives (on the
      // desktop sizes none of these buttons exists: the scene is the base one).
      if (scene === "mobilemenu") {
        const menu = page.locator('[data-testid="hud-menu"] > summary');
        if (await menu.isVisible()) await menu.click();
        else await page.getByTestId("options-button").click();
        await page.waitForTimeout(300);
      }
      if (scene === "mobilechat") {
        const glance = page.getByTestId("chat-glance");
        if (await glance.isVisible()) {
          await glance.click();
          await page.waitForTimeout(300);
        }
      }
      if (scene === "mobilebattle") {
        const toggle = page.getByTestId("panel-toggle");
        if (await toggle.isVisible()) await toggle.click();
        const tab = page.locator('[data-testid="panel-tabs"] [data-tab="battle"]');
        if (await tab.isVisible()) await tab.click();
        await page.waitForTimeout(300);
      }
      if (scene === "mobilemap") {
        const fold = page.getByTestId("minimap-fold");
        if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
        await page.waitForTimeout(300);
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
      if (scene === "questsdone" || scene === "questsmilestones") {
        // The quest log's finished or milestones tab (in the window, or in the panel's tab
        // on phones).
        const which = scene === "questsdone" ? "finished" : "milestones";
        const tab = page.locator(`[data-quest-tab="${which}"]`).first();
        if (await tab.isVisible()) {
          await tab.click();
          await page.waitForTimeout(150);
        }
      }
      if (scene.startsWith("forge")) {
        // docs/02 "Forja": the anvil's Forge tab. "forge": the +2 sword in hand (a safe
        // level, 100 %); "forgerisk": the +6 helmet (the amber toggle there, off), after
        // "Refine": the confirm step that warns in red that it may break; "forgeresult":
        // the last attempt broke a +7 saber.
        const tab = page.locator('[data-station-tab="forge"]');
        if (await tab.isVisible()) {
          await tab.click();
          await page.waitForTimeout(150);
        }
        const items = page.locator(".forge-item");
        if (scene === "forge" && (await items.count()) > 1) await items.nth(1).click();
        if (scene === "forgerisk" && (await items.count()) > 0) {
          await items.nth(0).click();
          const attempt = page.getByTestId("forge-attempt");
          if (await attempt.isEnabled()) await attempt.click();
        }
        await page.mouse.move(1, 1);
        await page.waitForTimeout(200);
      }
      if (scene === "book") {
        // docs/02 "Libros y cofres": the second page of the lectern's book, both buttons on;
        // "scroll" stays on the first page of the wreck's manifest.
        const next = page.getByTestId("book-next");
        if (await next.isVisible()) await next.click();
        await page.mouse.move(1, 1);
        await page.waitForTimeout(150);
      }
      if (scene === "chattabs") {
        // docs/17 UI-10: the Local tab picked (the line to speak goes to "Decir"); lines of
        // other channels arrive after it (src/preview/main.tsx LATER_CHAT_MS): their dots.
        const local = page.locator('[data-chat-tab="local"]');
        if (await local.isVisible()) await local.click();
        await page.waitForTimeout(1200);
        await page.mouse.move(1, 1);
        await page.waitForTimeout(300);
      }
      if (scene === "status") {
        // docs/17 "Bandeja de estados": ten conditions and statuses at once (two of them in
        // their last seconds, flashing), with the poison's tooltip opened as a tap does it
        // (also on phones, which have no hover).
        const poison = page.locator('[data-testid="conditions"] [data-condition="poison"]');
        if (await poison.isVisible()) {
          await poison.click();
          await page.mouse.move(1, 1);
          await page.waitForTimeout(200);
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
      const suffix = (lang === "es" ? "" : `-${lang}`) + (notch ? "-notch" : "");
      await page.screenshot({ path: join(shots, `${scene}-${size.name}${suffix}.png`) });
      if (audit && size.insets) {
        const found = await touchAudit(page, {
          allow: AUDIT_ALLOW.filter((a) => !a.scene || a.scene === scene).map((a) => a.re),
          insets,
          covered,
        });
        if (found.length > 0) findings.push({ scene, size: size.name, found });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`ui-preview: screenshots in ${shots}`);
if (audit) {
  writeFileSync(
    join(out, `touch-audit-${lang}${notch ? "-notch" : ""}.json`),
    JSON.stringify(findings, null, 1),
  );
  for (const f of findings)
    console.log(`
${f.scene} @ ${f.size}
${formatFindings(f.found)}`);
  const total = findings.reduce((n, f) => n + f.found.length, 0);
  console.log(`
touch audit (${lang}${notch ? ", notch" : ""}): ${total} finding(s)`);
  if (total > 0) process.exitCode = 1;
}
