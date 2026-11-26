import { describe, expect, it } from "vitest";
import {
  MAX_WIDTH_CROWDED,
  ROLE_LINES,
  fitName,
  labelMaxWidth,
  labelsFull,
  nameBlockHeight,
  placeLabels,
  stackLabel,
  wrapRole,
} from "./labels.ts";
import { SHRINK_MIN, labelFontPx, linePitch, subFontPx } from "./label-style.ts";
import type { LabelBox, MeasureLine } from "./labels.ts";
import { stackBubbles } from "./bubbles.ts";

// Zoom 1: a tile is 32 px; names are ~60 px wide and 12 px tall.
const box = (
  id: number,
  tileX: number,
  tileY: number,
  extra: Partial<LabelBox> = {},
): LabelBox => ({
  id,
  x: tileX * 32 + 16,
  y: tileY * 32 - 4,
  width: 60,
  nameHeight: 12,
  guildHeight: 0,
  self: false,
  target: false,
  distance: Math.max(Math.abs(tileX - 7), Math.abs(tileY - 5)),
  ...extra,
});
const self = box(1, 7, 5, { self: true });

describe("placeLabels", () => {
  it("leaves every label alone when a name is a quarter of a tile or less", () => {
    const boxes = [self, box(2, 8, 5, { guildHeight: 10 }), box(3, 9, 5)];
    const out = placeLabels(boxes, 64, 15);
    expect([...out.values()]).toEqual([
      { show: true, guild: false, lift: 0 },
      { show: true, guild: true, lift: 0 },
      { show: true, guild: false, lift: 0 },
    ]);
  });

  it("keeps labels that do not touch", () => {
    const out = placeLabels([self, box(2, 10, 5), box(3, 7, 8)], 32, 12);
    for (const p of out.values()) expect(p).toEqual({ show: true, guild: false, lift: 0 });
  });

  it("drops a guild line before anything else", () => {
    // Directly below the own creature: its guild line would reach into the name above.
    const below = box(2, 7, 6, { guildHeight: 30 });
    const out = placeLabels([self, below], 32, 12);
    expect(out.get(2)).toEqual({ show: true, guild: false, lift: 0 });
  });

  it("lifts a far label above the one it hits", () => {
    const a = box(2, 10, 5);
    const b = box(3, 11, 5); // 32 px right of a: the 60 px names overlap
    const out = placeLabels([self, a, b], 32, 12);
    expect(out.get(2)).toEqual({ show: true, guild: false, lift: 0 });
    expect(out.get(3)).toEqual({ show: true, guild: false, lift: 13 });
  });

  it("hides a far label with no room, but never the own one, the target or a neighbour", () => {
    const crowd = [
      box(2, 11, 5),
      box(3, 12, 5),
      box(4, 12, 5), // far, on the tile of 3: hidden once 2 and 3 took the room
      box(5, 12, 4, { target: true }),
      box(6, 8, 5), // next to the player: stays
    ];
    const out = placeLabels([self, ...crowd], 32, 12);
    expect(out.get(1)?.show).toBe(true);
    expect(out.get(5)?.show).toBe(true);
    expect(out.get(6)?.show).toBe(true);
    expect(out.get(4)?.show).toBe(false);
  });

  it("puts the own label and the target first", () => {
    // The target overlaps a nearer creature: the target keeps its spot.
    const near = box(2, 9, 5);
    const target = box(3, 10, 5, { target: true });
    const out = placeLabels([near, target, self], 32, 12);
    expect(out.get(3)).toEqual({ show: true, guild: false, lift: 0 });
    expect(out.get(2)?.lift).toBeGreaterThan(0);
  });

  it("is stable for the same input", () => {
    const boxes = [self, box(2, 11, 5), box(3, 12, 5), box(4, 13, 5)];
    expect(placeLabels(boxes, 32, 12)).toEqual(placeLabels([...boxes].reverse(), 32, 12));
  });
});

/** Every character half its font size wide: widths the tests can count. */
const mono: MeasureLine = (text, px) => [...text].length * px * 0.5;

describe("fitName", () => {
  it("keeps a name that fits as it is", () => {
    expect(fitName("Lobo gris", 15, 180, mono)).toEqual({ text: "Lobo gris", fontPx: 15 });
  });

  it("shrinks a long name a little before any cut", () => {
    // 26 characters: 195 px at 15 px, 182 at 14, 169 at 13.
    const name = "Guardian de escoria atado!";
    expect(fitName(name, 15, 180, mono)).toEqual({ text: name, fontPx: 13 });
    expect(fitName(name, 15, 190, mono)).toEqual({ text: name, fontPx: 14 });
  });

  it("cuts only past the hard width, at the smallest size", () => {
    const name = "Sir Bartholomew the Long of the Far Shore";
    const min = Math.ceil(15 * SHRINK_MIN);
    const out = fitName(name, 15, 112, mono);
    expect(out.fontPx).toBe(min);
    expect(out.text.endsWith("…")).toBe(true);
    expect(mono(out.text, out.fontPx)).toBeLessThanOrEqual(112);
    // As much of the name as fits: most of the width is used.
    expect(mono(out.text, min)).toBeGreaterThan(112 - 2 * min);
  });

  it("never cuts an NPC's name", () => {
    const out = fitName("Casia Hollín de los Registros", 15, 100, mono, false);
    expect(out.text).toBe("Casia Hollín de los Registros");
    expect(out.fontPx).toBe(Math.ceil(15 * SHRINK_MIN));
  });
});

describe("wrapRole", () => {
  it("is one line when it fits", () => {
    expect(wrapRole("Provisiones", 12, 180, mono)).toEqual({ lines: ["Provisiones"], fontPx: 12 });
  });

  it("wraps a long role by its words onto two lines, never with an ellipsis", () => {
    const out = wrapRole("Guardiana de los registros", 12, 100, mono);
    expect(out.lines).toEqual(["Guardiana de los", "registros"]);
    expect(out.fontPx).toBe(12);
    expect(out.lines.join(" ")).not.toContain("…");
  });

  it("shrinks before it takes a third line", () => {
    // Three lines at 12 px (max 16 characters a line), two at 10 (max 20).
    const out = wrapRole("Bendiciones y sanación del templo", 12, 100, mono);
    expect(out.lines.length).toBe(ROLE_LINES);
    expect(out.fontPx).toBeLessThan(12);
    expect(out.fontPx).toBeGreaterThanOrEqual(Math.ceil(12 * SHRINK_MIN));
  });

  it("keeps every word of a text too long for two lines", () => {
    const role = "uno dos tres cuatro cinco seis siete ocho nueve diez";
    const out = wrapRole(role, 12, 60, mono);
    expect(out.lines.join(" ")).toBe(role);
  });

  it("has no line without a role", () => {
    expect(wrapRole("", 12, 100, mono).lines).toEqual([]);
  });
});

describe("the hard width", () => {
  it("is roomy when labels show untouched and tight when they crowd", () => {
    expect(labelsFull(64, 15)).toBe(true);
    expect(labelsFull(32, 12)).toBe(false);
    expect(labelMaxWidth(64, 15)).toBe(180);
    expect(labelMaxWidth(32, 12)).toBe(12 * MAX_WIDTH_CROWDED);
  });

  it("crowds at every zoom and pixel density where a name is over a quarter of a tile", () => {
    for (const dpr of [1, 1.25, 1.5, 2])
      for (const zoom of [1, 2, 3, 4, 6, 8]) {
        const px = labelFontPx(zoom, dpr, "large");
        expect(labelsFull(32 * zoom, px)).toBe(32 * zoom >= 4 * px);
      }
    // The fitted desktop view (2x and up at 100 %): untouched.
    for (const zoom of [2, 3, 4])
      expect(labelsFull(32 * zoom, labelFontPx(zoom, 1, "large"))).toBe(true);
    expect(labelsFull(32, labelFontPx(1, 1, "large"))).toBe(false);
  });
});

describe("stackLabel", () => {
  const name = labelFontPx(2, 1, "large");
  const sub = subFontPx(name, 1);

  it("puts a one-line name right over the bar", () => {
    const st = stackLabel(200, { name, role: sub, roleLines: 0, guild: 0 });
    expect(st.name).toBe(200);
    expect(st.top).toBe(200 - linePitch(name));
  });

  it("puts an NPC's role under its name, smaller", () => {
    const lines = { name, role: sub, roleLines: 1, guild: 0 };
    const st = stackLabel(200, lines);
    expect(sub).toBeLessThan(name);
    expect(st.role).toBe(200);
    expect(st.name).toBe(200 - linePitch(sub));
    expect(st.top).toBe(st.name - linePitch(name));
    expect(nameBlockHeight(lines)).toBe(200 - st.top);
  });

  it("makes room for a wrapped role and for a guild line", () => {
    const st = stackLabel(200, { name, role: sub, roleLines: 2, guild: sub });
    expect(st.guild).toBe(200);
    expect(st.role).toBe(200 - linePitch(sub));
    expect(st.name).toBe(st.role - 2 * linePitch(sub));
  });

  it("is whole pixels", () => {
    for (const dpr of [1, 1.25, 1.5, 2])
      for (const zoom of [1, 2, 3, 4, 5, 6, 8]) {
        const n = labelFontPx(zoom, dpr, "large");
        const st = stackLabel(317, { name: n, role: subFontPx(n, dpr), roleLines: 2, guild: 0 });
        for (const v of Object.values(st)) expect(Number.isInteger(v)).toBe(true);
      }
  });

  it("leaves a speech bubble above both lines of an NPC", () => {
    // The canvas anchors a speaker's bubbles one pixel over the label's top.
    const st = stackLabel(200, { name, role: sub, roleLines: 1, guild: 0 });
    const placed = stackBubbles(
      [{ id: 1, x: 300, y: st.top - 1, width: 80, height: 24, self: false, distance: 1 }],
      0,
    );
    // The bubble's box ends above the name, which ends above the role.
    expect(placed.get(1)).toBe(st.top - 1);
    expect(st.top).toBeLessThan(st.name);
    expect(st.name).toBeLessThan(st.role);
  });
});
