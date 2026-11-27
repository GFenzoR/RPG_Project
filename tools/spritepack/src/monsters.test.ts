// The game's own monsters against the art rules of docs/17 (ANI-1, ART-2), read from the repo:
// every monster walks with frames (none is a single Dungeon Crawl tile any more), and every
// animal drawn from files stands with its feet on the tile and the contact shadow, at a size
// the atlas takes. Builds nothing: it reads data/, assets/sprites.yaml and the frame files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodePng } from "./image.ts";
import { parseManifest } from "./manifest.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const FRAME = /^(idle|walk|attack|death)_([nesw])_([0-9]+)\.png$/;

/**
 * Monsters still drawn as one frame with the procedural motion of ANI-5. The gull is
 * spritegen art the owner has not decided to swap for its Gemini sheet (docs/14).
 */
const SINGLE_FRAME = new Set(["creatures/thieving_gull"]);

/** sprite path of every monster in data/monsters. */
function monsterSprites(): Map<string, string> {
  const dir = join(root, "data", "monsters");
  const out = new Map<string, string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
    const m = /^sprite:\s*(\S+)\s*$/m.exec(readFileSync(join(dir, f), "utf8"));
    if (m?.[1]) out.set(f.replace(/\.yaml$/, ""), m[1]);
  }
  return out;
}

/** The frame files of a sprite drawn from files (assets/sprites/<sprite>/<action>_<dir>_<n>). */
function frameFiles(sprite: string): string[] {
  const dir = join(root, "assets", "sprites", sprite);
  return existsSync(dir) ? readdirSync(dir).filter((n) => FRAME.test(n)) : [];
}

const { manifest, errors } = parseManifest(
  readFileSync(join(root, "assets", "sprites.yaml"), "utf8"),
);
const monsters = monsterSprites();

describe("the game's monsters (docs/17 ANI-1, ART-2)", () => {
  it("reads the manifest and every monster", () => {
    expect(errors).toEqual([]);
    expect(monsters.size).toBeGreaterThan(15);
  });

  it("all walk with frames, from a pack's layers or from files, but the listed single-frame ones", () => {
    const single: string[] = [];
    for (const [id, sprite] of monsters) {
      const layered = (manifest.animations.get(sprite)?.layers.length ?? 0) > 0;
      const walks = frameFiles(sprite).some((n) => n.startsWith("walk_"));
      if (!layered && !walks) single.push(sprite);
      expect(manifest.sprites.get(sprite)?.kind, `${id}: a vendor tile under the frames`).not.toBe(
        "source",
      );
    }
    expect(single.sort()).toEqual([...SINGLE_FRAME].sort());
  });

  it("drawn from files, stand with their feet on the tile and the contact shadow", () => {
    for (const [id, sprite] of monsters) {
      if (frameFiles(sprite).length === 0) continue;
      const hints = manifest.animations.get(sprite);
      expect(hints?.anchor, `${id}: anchor`).toBe("bc");
      expect(hints?.shadow, `${id}: shadow`).toBe("ellipse");
    }
  });

  it("drawn from files, are square frames of 32, 64 or 96 px, one size per creature", () => {
    const sizes = new Map<string, number>();
    for (const [id, sprite] of monsters) {
      const files = frameFiles(sprite);
      const seen = new Set<string>();
      for (const f of files) {
        const img = decodePng(readFileSync(join(root, "assets", "sprites", sprite, f)));
        seen.add(`${img.width}x${img.height}`);
        sizes.set(id, img.width);
      }
      if (files.length === 0) continue;
      expect([...seen], id).toHaveLength(1);
      const [w, h] = [...seen][0]?.split("x").map(Number) ?? [];
      expect(w, id).toBe(h);
      expect([32, 64, 96], id).toContain(w);
    }
    // The Chapter 3 boss is the one drawn bigger than a person (docs/17 ART-2).
    expect(sizes.get("slagbound_warden")).toBe(96);
    expect([...sizes].filter(([, w]) => w === 96).map(([id]) => id)).toEqual(["slagbound_warden"]);
  });
});

describe('how the game\'s creatures walk (docs/17 "Criaturas al ritmo de su paso")', () => {
  /** The sprites the client draws as one figure (not a paper doll): monsters and NPC spirits. */
  const drawn = [...new Set(monsters.values()), "npcs/forge_echo"];

  it("every drawn creature says its body, and a walker's stride fits its walk frames", () => {
    for (const sprite of drawn) {
      const entry = manifest.animations.get(sprite);
      expect(entry?.body, `${sprite}: body`).toBeDefined();
      const walks = frameFiles(sprite).filter((n) => n.startsWith("walk_w_")).length;
      if (entry?.body === "flyer" || entry?.flying) {
        expect(entry.body, `${sprite}: a flying sprite is a flyer`).toBe("flyer");
        expect(entry.flying, `${sprite}: a flyer hovers`).toBe(true);
        expect(entry.stride, `${sprite}: a flyer has no stride`).toBeUndefined();
        continue;
      }
      // A cycle no shorter than a frame per 2 px, no longer than two tiles: outside that
      // the legs blur or the body skates.
      const stride = entry?.stride;
      expect(stride, `${sprite}: stride`).toBeDefined();
      if (stride === undefined) continue;
      expect(stride).toBeGreaterThanOrEqual(Math.max(8, walks * 2));
      expect(stride).toBeLessThanOrEqual(64);
    }
  });
});
