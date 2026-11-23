import { describe, expect, it } from "vitest";
import type { PaletteItem } from "../io/wire.ts";
import { translator } from "../i18n.ts";
import { doorNote, itemNote } from "./format.ts";

const t = translator({
  "editor.door_locked": "locked with {key}",
  "editor.door_closed": "shut",
  "editor.door_open": "open",
  "editor.key_item": "key {key}",
  "editor.surface": "surface {surface}",
  "editor.plant_bend": "bends",
  "editor.plant_rustle": "rustles",
  "editor.living_breakable": "breaks: {by} ({hp} HP)",
  "editor.living_pushable": "pushed",
  "editor.living_plate": "plate {radius}",
});

const item = (more: Partial<PaletteItem>): PaletteItem => ({
  id: "x",
  kind: "decoration",
  sprite: "x",
  name: "item.x.name",
  ...more,
});

describe("itemNote", () => {
  it("names a ground's surface and a plant's reaction (livingworld/README.md)", () => {
    expect(itemNote(item({ kind: "ground", surface: "sand" }), t)).toBe("surface sand");
    expect(itemNote(item({ plant: "bend" }), t)).toBe("bends");
    expect(itemNote(item({ plant: "rustle" }), t)).toBe("rustles");
    expect(itemNote(item({ door: "open", plant: "bend" }), t)).toBe("open");
    expect(itemNote(item({}), t)).toBeUndefined();
  });
});

describe("doorNote", () => {
  it("says which key opens a locked door and which doors a key opens", () => {
    expect(doorNote(item({ door: "closed", lock: "forge_gate" }), t)).toBe(
      "locked with forge_gate",
    );
    expect(doorNote(item({ kind: "material", key: "forge_gate" }), t)).toBe("key forge_gate");
  });

  it("tells shut doors without a lock and open doors apart", () => {
    expect(doorNote(item({ door: "closed" }), t)).toBe("shut");
    expect(doorNote(item({ door: "open" }), t)).toBe("open");
  });

  it("says how a living object breaks, moves or opens (livingworld/README.md)", () => {
    expect(
      doorNote(item({ living: { kind: "breakable", by: ["melee", "tool:axe"], hp: 20 } }), t),
    ).toBe("breaks: melee, tool:axe (20 HP)");
    expect(doorNote(item({ living: { kind: "pushable" } }), t)).toBe("pushed");
    expect(doorNote(item({ living: { kind: "plate", radius: 6 } }), t)).toBe("plate 6");
  });

  it("says nothing of other items or of an unknown one", () => {
    expect(doorNote(item({}), t)).toBeUndefined();
    expect(doorNote(undefined, t)).toBeUndefined();
  });
});
