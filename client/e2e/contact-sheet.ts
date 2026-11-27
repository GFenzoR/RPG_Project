// Contact sheets of screenshots (docs/08 "Hojas de contacto"): many captures on one image,
// each with its name, to review a whole run at a glance before opening the ones that look
// wrong. A plain script, not a Playwright test.
//
//   node --experimental-strip-types client/e2e/contact-sheet.ts <dir> <name part> [--per 12] [--cols 6] [--out <dir>]
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string =>
  args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback;
const dir = resolve(args[0] ?? ".");
const part = args[1] ?? "";
const per = Number(flag("--per", "12"));
const cols = Number(flag("--cols", "6"));
const out = resolve(flag("--out", join(dir, "sheets")));
const width = Number(flag("--width", "1560"));

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".png") && f.includes(part))
  .sort();
if (files.length === 0) throw new Error(`no screenshot in ${dir} has "${part}" in its name`);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  for (let i = 0; i * per < files.length; i++) {
    const cells = files
      .slice(i * per, (i + 1) * per)
      .map(
        (f) =>
          `<figure><img src="${pathToFileURL(join(dir, f)).href}"><figcaption>${f.replace(".png", "")}</figcaption></figure>`,
      )
      .join("");
    // From a file: a page without an origin may not load file:// images.
    const html = join(out, "sheet.html");
    writeFileSync(
      html,
      `<style>body{margin:0;background:#222;color:#eee;font:11px sans-serif}
       main{display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px;padding:4px}
       figure{margin:0}img{width:100%;display:block}figcaption{padding:2px 0;overflow-wrap:anywhere}</style>
       <main>${cells}</main>`,
    );
    await page.goto(pathToFileURL(html).href);
    rmSync(html);
    await page.waitForFunction(() =>
      Array.from(document.images).every((im) => im.complete && im.naturalWidth > 0),
    );
    const file = join(out, `${part || "all"}-${String(i + 1).padStart(2, "0")}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
  }
} finally {
  await browser.close();
}
