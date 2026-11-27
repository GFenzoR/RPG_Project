// Vite plugin: the game's name in the files that cannot run t() (docs/17 "Pantalla de entrada").
// The name lives in ONE i18n key, `client.title` (i18n/<lang>/client.yaml); this plugin reads
// the default language's text and fills it into:
//   {{game-name}}            in client/index.html and client/play/index.html (<title>, meta)
//   client/manifest.webmanifest.in -> /manifest.webmanifest (served and emitted by this plugin)
// Anything else that must say the name (the desktop app's tauri.conf.json, the server's email
// subjects) cannot read it at runtime: docs/17 lists them and brand.test.ts compares them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Plugin } from "vite";

export const NAME_KEY = "client.title";
export const NAME_PLACEHOLDER = "{{game-name}}";
const DEFAULT_LANGUAGE = "es";

/** The name in one language's catalog (a missing file or key is an error: no silent default). */
export function gameName(root: string, lang = DEFAULT_LANGUAGE): string {
  const file = join(root, "i18n", lang, "client.yaml");
  const texts = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const name = texts[NAME_KEY];
  if (typeof name !== "string" || name.trim() === "") throw new Error(`${file}: no ${NAME_KEY}`);
  return name;
}

/** `text` with the name in place of every placeholder (HTML-escaped: it goes into markup). */
export function fillName(text: string, name: string): string {
  const html = name
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return text.split(NAME_PLACEHOLDER).join(html);
}

/** The manifest: the template with the name filled in as JSON strings, not as HTML. */
export function renderManifest(template: string, name: string): string {
  const out = template.split(`"${NAME_PLACEHOLDER}"`).join(JSON.stringify(name));
  JSON.parse(out); // fail the build here, not in the browser
  return out;
}

export const MANIFEST_TEMPLATE = join("client", "manifest.webmanifest.in");
export const MANIFEST_URL = "/manifest.webmanifest";

export function rpgBrand(root: string): Plugin {
  const manifest = (): string =>
    renderManifest(readFileSync(join(root, MANIFEST_TEMPLATE), "utf8"), gameName(root));
  return {
    name: "rpg-brand",
    transformIndexHtml: { order: "pre", handler: (html) => fillName(html, gameName(root)) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (
          req.method !== "GET" ||
          new URL(req.url ?? "/", "http://client").pathname !== MANIFEST_URL
        )
          return next();
        res.setHeader("content-type", "application/manifest+json");
        res.end(manifest());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: MANIFEST_URL.slice(1), source: manifest() });
    },
  };
}
