// The game's name has ONE source: the i18n key client.title. Everything that shows it in the
// game reads that key; the files that cannot (the HTML pages and the manifest take it from
// vite/brand.ts at build time) are filled from it; the places that cannot read it at all are
// listed in docs/17 "Pantalla de entrada" and compared here, so a rename that forgets one fails.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "./content.ts";
import { NAME_KEY, NAME_PLACEHOLDER, fillName, gameName, renderManifest } from "./brand.ts";

const root = repoRoot();
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const name = gameName(root);

/** Every .ts/.tsx file under `dir` that is not a test. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("the name's source (client.title)", () => {
  it("is the same text in every language, so renaming is one line per catalog", () => {
    for (const lang of readdirSync(join(root, "i18n"))) expect(gameName(root, lang)).toBe(name);
  });

  it("is one key in each catalog, not copied under another", () => {
    const copies = readdirSync(join(root, "i18n", "es")).filter((f) => {
      const texts = parse(read(`i18n/es/${f}`)) as Record<string, string>;
      return Object.entries(texts).some(([k, v]) => v === name && k !== NAME_KEY);
    });
    expect(copies).toEqual([]);
  });

  it("is what the title screen, the document title and the site show", () => {
    const app = read("client/src/ui/App.tsx");
    expect(app).toContain(`t("${NAME_KEY}")`);
    expect(read("client/src/main.tsx")).toContain(`document.title = t("${NAME_KEY}")`);
    expect(read("client/src/site/Site.tsx")).toContain(`t("${NAME_KEY}")`);
  });

  it("is never written into the client's code or pages", () => {
    for (const file of sources(join(root, "client", "src")))
      expect(readFileSync(file, "utf8"), file).not.toContain(name);
    for (const page of ["client/index.html", "client/play/index.html"]) {
      const html = read(page);
      expect(html).not.toContain(name);
      expect(html).toContain(NAME_PLACEHOLDER);
    }
    expect(read("client/manifest.webmanifest.in")).not.toContain(name);
  });
});

describe("fillName and renderManifest", () => {
  it("fills every placeholder, escaping the name for markup", () => {
    expect(fillName(`<title>${NAME_PLACEHOLDER}</title>${NAME_PLACEHOLDER}`, `A&"<B>`)).toBe(
      "<title>A&amp;&quot;&lt;B&gt;</title>A&amp;&quot;&lt;B&gt;",
    );
  });

  it("fills the manifest as JSON strings (quotes and backslashes survive)", () => {
    const tricky = ['Q"', " Realm"].join(String.fromCharCode(92));
    const out = renderManifest(`{"name": "${NAME_PLACEHOLDER}"}`, tricky);
    expect((JSON.parse(out) as { name: string }).name).toBe(tricky);
  });

  it("the real manifest and pages carry the name", () => {
    const manifest = JSON.parse(renderManifest(read("client/manifest.webmanifest.in"), name)) as {
      name: string;
      short_name: string;
    };
    expect(manifest.name).toBe(name);
    expect(manifest.short_name).toBe(name);
    expect(fillName(read("client/play/index.html"), name)).toContain(`<title>${name}</title>`);
  });
});

describe("what cannot read the key at runtime says the same name", () => {
  it("the desktop app's tauri.conf.json", () => {
    const conf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as {
      productName: string;
      app: { windows: { title: string }[] };
      bundle: { shortDescription: string; longDescription: string };
    };
    expect(conf.productName).toBe(name);
    expect(conf.app.windows[0]?.title).toBe(name);
    expect(conf.bundle.shortDescription).toBe(name);
    expect(conf.bundle.longDescription).toContain(name);
  });
});
