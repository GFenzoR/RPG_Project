// The real device pass (docs/15 "Pasada en un teléfono real"): drives Chrome on an Android
// phone connected by USB, through its DevTools port, and measures what the emulation cannot:
// the real safe areas, the real font sizes, the touch audit (e2e/touch-audit.ts) with real
// insets, and how many frames a second the page draws. A plain script, not a Playwright test.
//
// Before: `adb reverse tcp:<port> tcp:<port>` for the server the pages come from and
// `adb forward tcp:9222 localabstract:chrome_devtools_remote`.
//
//   node --experimental-strip-types client/e2e/device-check.ts --base http://localhost:8090 \
//     --pages "preview/?scene=game,preview/?scene=social" --out <dir> [--tag portrait]
//
// It opens one tab of its own and closes it; it never reads the other tabs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { touchAudit } from "./touch-audit.ts";
import type { Insets, TouchFinding } from "./touch-audit.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string =>
  args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback;
const base = flag("--base", "http://localhost:8090").replace(/\/$/, "");
const pages = flag("--pages", "preview/?scene=game").split(",");
const out = resolve(flag("--out", "device-check"));
const tag = flag("--tag", "device");
const cdpUrl = flag("--cdp", "http://localhost:9222");

interface Report {
  page: string;
  viewport: { width: number; height: number; dpr: number };
  insets: Insets;
  displayMode: string;
  fps: number;
  /** The worst frame of the sample, in ms. */
  worstFrameMs: number;
  findings: TouchFinding[];
}

mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
if (!context) throw new Error("the phone's Chrome has no browser context");
const page = await context.newPage();
const reports: Report[] = [];
try {
  for (const path of pages) {
    await page.goto(`${base}/${path}`);
    await page.waitForSelector(".game, .panel", { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);
    const seen = await page.evaluate(async () => {
      // The safe areas, as CSS sees them.
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
      document.body.append(probe);
      const s = getComputedStyle(probe);
      const insets = {
        top: parseFloat(s.paddingTop),
        right: parseFloat(s.paddingRight),
        bottom: parseFloat(s.paddingBottom),
        left: parseFloat(s.paddingLeft),
      };
      probe.remove();
      // Two seconds of frames.
      const times: number[] = [];
      await new Promise<void>((done) => {
        const start = performance.now();
        const tick = (now: number): void => {
          times.push(now);
          if (now - start < 2000) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      let worst = 0;
      for (let i = 1; i < times.length; i++)
        worst = Math.max(worst, (times[i] ?? 0) - (times[i - 1] ?? 0));
      const span = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
      const mode = ["fullscreen", "standalone", "minimal-ui", "browser"].find(
        (m) => matchMedia(`(display-mode: ${m})`).matches,
      );
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        insets,
        displayMode: mode ?? "?",
        fps: span > 0 ? Math.round(((times.length - 1) * 1000) / span) : 0,
        worstFrameMs: Math.round(worst),
      };
    });
    const findings = await touchAudit(page, { insets: seen.insets });
    const name = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    await page.screenshot({ path: join(out, `${tag}-${name}.png`) });
    reports.push({ page: path, ...seen, findings });
  }
} finally {
  await page.close();
  await browser.close();
}
writeFileSync(join(out, `${tag}.json`), JSON.stringify(reports, null, 1));
for (const r of reports)
  console.log(
    `${r.page}: ${r.viewport.width}x${r.viewport.height}@${r.viewport.dpr} ` +
      `insets ${r.insets.top}/${r.insets.right}/${r.insets.bottom}/${r.insets.left} ` +
      `${r.displayMode} ${r.fps} fps (worst ${r.worstFrameMs} ms) ` +
      `${r.findings.length} finding(s)` +
      r.findings.map((f) => `\n  ${f.kind}: ${f.what}: ${f.detail}`).join(""),
  );
