import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHUNK_SIZE, HOUSE_ISSUE_CODES } from "@rpg/map-format/ops";
import type { House, Island, World } from "@rpg/map-format/ops";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  HOUSE_MODES,
  MAX_DRAFT_TILES,
  draftHouse,
  draftIssues,
  draftOf,
  housePos,
  issueText,
  newDraft,
  newHouseId,
  paintTiles,
  setExit,
  toggleDoor,
} from "./draft.ts";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key} ${JSON.stringify(params)}` : key;

const HOUSE: House = {
  id: "a_house_1",
  name: "house.a_house_1.name",
  rent: 700,
  rects: [
    { x: 4, y: 4, z: 7, w: 3, h: 2 },
    { x: 5, y: 6, z: 7, w: 1, h: 1 },
  ],
  doors: [{ x: 5, y: 6, z: 7 }],
  exit: { x: 5, y: 7, z: 7 },
  notes: "old",
};

function island(id: string, x: number, houses: House[] = []): Island {
  return {
    meta: {
      id,
      name: `island.${id}.name`,
      rect: { x, y: 0, w: CHUNK_SIZE, h: CHUNK_SIZE },
      floors: [7],
      temple: { x: x + 5, y: 6, z: 7 },
      level_hint: [1, 1],
    },
    chunks: new Map(),
    spawns: [],
    npcs: [],
    zones: [],
    portals: [],
    texts: [],
    houses,
  };
}

function world(): World {
  return {
    meta: { format: 1, islands: [] },
    islands: new Map([
      ["a", island("a", 0, [HOUSE])],
      ["b", island("b", 64)],
    ]),
  };
}

const p = (x: number, y: number, z = 7) => ({ x, y, z });

describe("house drafts", () => {
  it("opens a house with its tiles and names, and builds back the same house", () => {
    const d = draftOf(HOUSE, { es: "Casa", en: "House" });
    expect(d.key).toBe("a_house_1");
    expect(d.tiles).toHaveLength(7);
    expect(draftHouse(d)).toEqual(HOUSE);
    expect(housePos(HOUSE)).toEqual(p(5, 5));
  });

  it("starts a new house with a free id and an empty name per language", () => {
    expect(newHouseId(world(), "a")).toBe("a_house_2");
    const d = newDraft(world(), "b", ["es", "en"]);
    expect(d).toMatchObject({ key: undefined, id: "b_house_1", tiles: [], doors: [] });
    expect(d.names).toEqual({ es: "", en: "" });
  });

  it("paints and erases tiles; erasing a door tile drops the door", () => {
    let d = newDraft(world(), "b", []);
    d = paintTiles(d, { x: 70, y: 2, w: 3, h: 2 }, 7, false) ?? d;
    expect(d.tiles).toHaveLength(6);
    // Painting again over the same tiles changes nothing (same draft).
    expect(paintTiles(d, { x: 70, y: 2, w: 2, h: 1 }, 7, false)).toBe(d);
    d = toggleDoor(d, p(71, 3));
    expect(d.doors).toEqual([p(71, 3)]);
    d = paintTiles(d, { x: 71, y: 3, w: 1, h: 1 }, 7, true) ?? d;
    expect(d.tiles).toHaveLength(5);
    expect(d.doors).toEqual([]);
    // keep() filters tiles (the controller drops those outside the islands).
    const kept = paintTiles(d, { x: 60, y: 0, w: 10, h: 1 }, 7, false, (q) => q.x >= 64);
    expect(kept?.tiles.filter((q) => q.y === 0).map((q) => q.x)).toEqual([64, 65, 66, 67, 68, 69]);
    expect(paintTiles(d, { x: 0, y: 0, w: 100, h: 100 }, 7, false)).toBeUndefined();
    expect(MAX_DRAFT_TILES).toBeLessThan(100 * 100);
  });

  it("toggles doors and sets or clears the exit", () => {
    let d = newDraft(world(), "a", []);
    d = toggleDoor(d, p(1, 1));
    d = toggleDoor(d, p(2, 1));
    expect(toggleDoor(d, p(1, 1)).doors).toEqual([p(2, 1)]);
    expect(toggleDoor(d, p(3, 1), true)).toBe(d); // remove-only on a tile without a door
    d = setExit(d, p(1, 2));
    expect(d.exit).toEqual(p(1, 2));
    expect(setExit(d, undefined).exit).toBeUndefined();
  });

  it("computes rects from the tiles and drops empty notes", () => {
    let d = newDraft(world(), "b", []);
    d = paintTiles(d, { x: 70, y: 2, w: 4, h: 3 }, 7, false) ?? d;
    d = paintTiles(d, { x: 71, y: 5, w: 2, h: 1 }, 7, false) ?? d;
    d = { ...d, notes: "  " };
    const h = draftHouse(d);
    expect(h.rects).toEqual([
      { x: 70, y: 2, z: 7, w: 4, h: 3 },
      { x: 71, y: 5, z: 7, w: 2, h: 1 },
    ]);
    expect(h.name).toBe("house.b_house_1.name");
    expect("notes" in h).toBe(false);
  });

  it("lists the house problems and a missing name per language", () => {
    let d = newDraft(world(), "b", ["es", "en"]);
    expect(draftIssues(world(), d, ["es", "en"]).map((i) => i.code)).toEqual([
      "no_tiles",
      "no_doors",
      "no_exit",
      "name",
      "name",
    ]);
    d = paintTiles(d, { x: 70, y: 2, w: 4, h: 3 }, 7, false) ?? d;
    d = toggleDoor(d, p(71, 3)); // inside, not on the edge
    d = setExit(d, p(71, 5));
    d = { ...d, names: { es: "Casa del Faro", en: "{bad}" } };
    const issues = draftIssues(world(), d, ["es", "en"]);
    expect(issues.map((i) => i.code)).toEqual([
      "door_not_on_edge",
      "exit_far",
      "no_ground",
      "name",
    ]);
    expect(issueText(t, issues[0] as (typeof issues)[number])).toBe(
      'editor.house.err.door_not_on_edge {"max":0,"x":71,"y":3,"z":7}',
    );
    expect(issueText(t, issues[3] as (typeof issues)[number])).toBe(
      'editor.house.err.name {"max":80,"lang":"en"}',
    );
    // Editing a house: its own tiles and id are not "taken".
    const own = draftOf(HOUSE, { es: "Casa", en: "House" });
    expect(draftIssues(world(), own, ["es", "en"]).map((i) => i.code)).toEqual(["no_ground"]);
  });

  it("has a text in both languages for every problem, mode and hint", () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const keys = [
      ...HOUSE_ISSUE_CODES.map((c) => `editor.house.err.${c}`),
      "editor.house.err.name",
      ...HOUSE_MODES.flatMap((m) => [`editor.house.mode.${m}`, `editor.house.hint.${m}`]),
    ];
    for (const lang of ["es", "en"]) {
      const texts = parse(readFileSync(`${repo}i18n/${lang}/editor.yaml`, "utf8")) as Record<
        string,
        string
      >;
      for (const k of keys) expect(texts[k], `${lang} ${k}`).toBeTypeOf("string");
    }
  });
});
