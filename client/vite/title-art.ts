// Vite plugin: the title screen's backdrop pictures (docs/17 "Pantalla de entrada"). They live in
// assets/title/ (credited under "Generado con IA" in assets/CREDITS.md) and are served at
// /title/<file> (dev server) and emitted under title/ (`vite build`). Only the .webp files of
// that folder are reachable: the lookup is an allowlist, so a "../" reaches nothing else.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

export const TITLE_PREFIX = "title/";

/** The pictures: file name -> absolute path, read from disk on each call. */
export function titleFiles(root: string): Map<string, string> {
  const dir = join(root, "assets", "title");
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) if (/^[a-z0-9_-]+\.webp$/.test(f)) out.set(f, join(dir, f));
  return out;
}

export function rpgTitleArt(root: string): Plugin {
  return {
    name: "rpg-title-art",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://client").pathname;
        if (req.method !== "GET" || !path.startsWith("/" + TITLE_PREFIX)) return next();
        let name = "";
        try {
          name = decodeURIComponent(path.slice(TITLE_PREFIX.length + 1));
        } catch {
          // malformed escape: 404 below
        }
        const file = titleFiles(root).get(name);
        if (!file) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("content-type", "image/webp");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [name, file] of titleFiles(root))
        this.emitFile({ type: "asset", fileName: TITLE_PREFIX + name, source: readFileSync(file) });
    },
  };
}
