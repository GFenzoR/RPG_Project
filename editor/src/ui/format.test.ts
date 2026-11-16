import { describe, expect, it } from "vitest";
import type { PaletteItem } from "../io/wire.ts";
import { translator } from "../i18n.ts";
import { doorNote } from "./format.ts";

const t = translator({
  "editor.door_locked": "locked with {key}",
  "editor.door_closed": "shut",
  "editor.door_open": "open",
  "editor.key_item": "key {key}",
});

const item = (more: Partial<PaletteItem>): PaletteItem => ({
  id: "x",
  kind: "decoration",
  sprite: "x",
  name: "item.x.name",
  ...more,
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

  it("says nothing of other items or of an unknown one", () => {
    expect(doorNote(item({}), t)).toBeUndefined();
    expect(doorNote(undefined, t)).toBeUndefined();
  });
});
