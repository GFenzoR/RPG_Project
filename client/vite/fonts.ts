// Vite plugin: the UI fonts (docs/17 UI-3), self-hosted. The original .ttf files of
// https://github.com/google/fonts live untouched in assets/vendor/font-<family>/ with their
// OFL.txt (assets/CREDITS.md); this plugin cuts each one down to the Latin the game writes
// (Spanish and English: Basic Latin, Latin-1, Latin Extended-A and the usual punctuation)
// and turns it into woff2:
//
//   /fonts/<file>.woff2  served by the dev server, built on the first request;
//                        `vite build` emits the same files under fonts/
//
// client.css declares one @font-face per entry of FONTS with its `url`. Nothing is fetched
// from the network: the desktop app's CSP only allows fonts from its own origin.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import subsetFont from "subset-font";

export interface FontFile {
  /** CSS family name (the font's own name: none of these has a Reserved Font Name). */
  family: string;
  /** assets/vendor/font-<pack>/ */
  pack: string;
  /** The original file inside the pack, as google/fonts names it. */
  source: string;
  /** Served and emitted as /fonts/<out>. */
  out: string;
  /** font-weight of the @font-face: one weight, or a "min max" range for a variable font. */
  weight: string;
  style: "normal" | "italic";
}

/** Every font the UI may use. A family the page never asks for is never downloaded. */
export const FONTS: readonly FontFile[] = [
  {
    family: "Cinzel",
    pack: "font-cinzel",
    source: "Cinzel[wght].ttf",
    out: "cinzel.woff2",
    weight: "400 900",
    style: "normal",
  },
  {
    family: "Grenze Gotisch",
    pack: "font-grenzegotisch",
    source: "GrenzeGotisch[wght].ttf",
    out: "grenze-gotisch.woff2",
    weight: "100 900",
    style: "normal",
  },
  {
    family: "Alegreya Sans",
    pack: "font-alegreyasans",
    source: "AlegreyaSans-Regular.ttf",
    out: "alegreya-sans-400.woff2",
    weight: "400",
    style: "normal",
  },
  {
    family: "Alegreya Sans",
    pack: "font-alegreyasans",
    source: "AlegreyaSans-Italic.ttf",
    out: "alegreya-sans-400-italic.woff2",
    weight: "400",
    style: "italic",
  },
  {
    family: "Alegreya Sans",
    pack: "font-alegreyasans",
    source: "AlegreyaSans-Medium.ttf",
    out: "alegreya-sans-500.woff2",
    weight: "500",
    style: "normal",
  },
  {
    family: "Alegreya Sans",
    pack: "font-alegreyasans",
    source: "AlegreyaSans-Bold.ttf",
    out: "alegreya-sans-700.woff2",
    weight: "700",
    style: "normal",
  },
  {
    family: "Alegreya",
    pack: "font-alegreya",
    source: "Alegreya[wght].ttf",
    out: "alegreya.woff2",
    weight: "400 900",
    style: "normal",
  },
  {
    family: "Alegreya",
    pack: "font-alegreya",
    source: "Alegreya-Italic[wght].ttf",
    out: "alegreya-italic.woff2",
    weight: "400 900",
    style: "italic",
  },
  // The canvas labels (names, guilds, damage numbers: client/src/render/canvas-font.ts).
  {
    family: "Pixelify Sans",
    pack: "font-pixelifysans",
    source: "PixelifySans[wght].ttf",
    out: "pixelify-sans.woff2",
    weight: "400 700",
    style: "normal",
  },
];

/** Where the fonts are served and emitted: /fonts/<out>. */
export const FONTS_PREFIX = "fonts/";

/**
 * Code point ranges kept in every subset: Basic Latin, Latin-1 Supplement (¿¡ñáéíóúü and
 * the × of the close buttons), Latin Extended-A, general punctuation (– — ‘ ’ “ ” … ‹ ›)
 * and the euro sign.
 */
export const SUBSET_RANGES: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0xff],
  [0x100, 0x17f],
  [0x2010, 0x2027],
  [0x2030, 0x203a],
  [0x20ac, 0x20ac],
];

/** Every character of SUBSET_RANGES, the text handed to the subsetter. */
export function subsetText(ranges = SUBSET_RANGES): string {
  let s = "";
  for (const [from, to] of ranges) for (let c = from; c <= to; c++) s += String.fromCodePoint(c);
  return s;
}

/** The original .ttf of a font on disk. */
export const fontSource = (root: string, f: FontFile): string =>
  join(root, "assets", "vendor", f.pack, f.source);

/**
 * The `name` table entries every served font keeps. Harfbuzz keeps only 0-6 unless told;
 * the OFL asks each copy to carry its copyright (0) and licence, which the fonts give as
 * the licence description (13) and its URL (14).
 */
export const KEPT_NAME_IDS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 13, 14];

/** Cuts one font down to SUBSET_RANGES as woff2 (or another format, for the tests). */
export async function buildFont(
  root: string,
  f: FontFile,
  format: "woff2" | "truetype" = "woff2",
): Promise<Buffer> {
  const out = await subsetFont(readFileSync(fontSource(root, f)), subsetText(), {
    targetFormat: format,
    preserveNameIds: [...KEPT_NAME_IDS],
  });
  return Buffer.from(out);
}

export function rpgFonts(root: string): Plugin {
  // Built once per dev server, on the first request of each file.
  const cache = new Map<string, Promise<Buffer>>();
  const get = (f: FontFile): Promise<Buffer> => {
    let p = cache.get(f.out);
    if (!p) {
      p = buildFont(root, f);
      cache.set(f.out, p);
    }
    return p;
  };
  return {
    name: "rpg-client-fonts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://client").pathname;
        if (req.method !== "GET" || !path.startsWith("/" + FONTS_PREFIX)) return next();
        // An allowlist: only the names of FONTS, so a "../" reaches nothing else.
        const f = FONTS.find((x) => x.out === path.slice(FONTS_PREFIX.length + 1));
        if (!f) {
          res.statusCode = 404;
          res.end();
          return;
        }
        get(f).then(
          (data) => {
            res.setHeader("content-type", "font/woff2");
            res.end(data);
          },
          (err: unknown) => {
            console.error(`[client] font ${f.out}:`, err);
            res.statusCode = 500;
            res.end();
          },
        );
      });
    },
    async generateBundle() {
      for (const f of FONTS)
        this.emitFile({
          type: "asset",
          fileName: FONTS_PREFIX + f.out,
          source: await get(f),
        });
    },
  };
}
