// House ops (add_house, remove_house, set_house): applied to the repository world, undone
// with their inverse and redone with the inverse of the inverse, comparing houses.yaml of
// every island byte for byte.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorld } from "../io.ts";
import type { World } from "../types.ts";
import { formatYaml } from "../yaml.ts";
import { applyOps } from "./index.ts";
import type { AddHouseOp, MapOp } from "./index.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

function loaded(): World {
  return loadWorld(repo).world;
}

function houses(world: World): Map<string, string> {
  return new Map([...world.islands].map(([id, isl]) => [id, formatYaml(isl.houses)]));
}

function roundTrip(world: World, ops: MapOp[]): World {
  const before = houses(world);
  const { world: edited, inverse } = applyOps(world, ops);
  expect(houses(world)).toEqual(before); // input untouched
  expect(houses(edited)).not.toEqual(before);
  const { world: restored, inverse: redo } = applyOps(edited, inverse);
  expect(houses(restored)).toEqual(before);
  expect(houses(applyOps(restored, redo).world)).toEqual(houses(edited));
  return edited;
}

/** A 4x3 house on testisle's grass, north-east of the temple, door in the bottom row. */
const NEW: AddHouseOp = {
  op: "add_house",
  id: "testisle_house_a",
  rent: 600,
  rects: [{ x: 1062, y: 1046, z: 7, w: 4, h: 3 }],
  doors: [{ x: 1063, y: 1048, z: 7 }],
  exit: { x: 1063, y: 1049, z: 7 },
};

describe("house ops", () => {
  it("adds a house with its name key and reports houses.yaml as touched", () => {
    const r = applyOps(loaded(), [{ ...NEW, notes: "test" }]);
    expect(r.world.islands.get("testisle")?.houses).toEqual([
      {
        id: "testisle_house_a",
        name: "house.testisle_house_a.name",
        rent: 600,
        rects: [{ x: 1062, y: 1046, z: 7, w: 4, h: 3 }],
        doors: [{ x: 1063, y: 1048, z: 7 }],
        exit: { x: 1063, y: 1049, z: 7 },
        notes: "test",
      },
    ]);
    expect(r.touchedAux).toEqual([{ island: "testisle", file: "houses" }]);
    expect(r.touched).toEqual([]);
    expect(r.inverse).toEqual([{ op: "remove_house", id: "testisle_house_a" }]);
    roundTrip(loaded(), [NEW]);
  });

  it("removes a house and puts it back at its index", () => {
    const w = roundTrip(loaded(), [{ op: "remove_house", id: "puerto_house_oar" }]);
    expect(w.islands.get("puerto")?.houses.map((h) => h.id)).toEqual([
      "puerto_house_net",
      "puerto_house_anchor",
    ]);
  });

  it("changes fields in place and undoes them, notes included", () => {
    const w = roundTrip(loaded(), [
      {
        op: "set_house",
        id: "puerto_house_oar",
        rent: 900,
        rects: [{ x: 3161, y: 6396, z: 7, w: 6, h: 6 }],
        notes: null,
      },
    ]);
    const oar = w.islands.get("puerto")?.houses[1];
    expect(oar?.rent).toBe(900);
    expect(oar?.rects).toEqual([{ x: 3161, y: 6396, z: 7, w: 6, h: 6 }]);
    expect(oar?.notes).toBeUndefined();
    expect(oar?.doors).toHaveLength(2); // untouched fields stay
    roundTrip(loaded(), [{ op: "set_house", id: "puerto_house_net", notes: "new notes" }]);
  });

  it("does nothing when set_house changes nothing", () => {
    const world = loaded();
    const net = world.islands.get("puerto")?.houses[0];
    const r = applyOps(world, [{ op: "set_house", id: "puerto_house_net", rent: net?.rent ?? 0 }]);
    expect(r.inverse).toEqual([]);
    expect(r.touchedAux).toEqual([]);
  });

  it("rejects what the file or the server cannot hold", () => {
    const fails = (op: MapOp, re: RegExp): void => {
      expect(() => applyOps(loaded(), [op])).toThrow(re);
    };
    fails({ ...NEW, id: "puerto_house_net" }, /already exists/);
    fails({ ...NEW, id: "Bad" }, /house id must be/);
    fails({ ...NEW, name: "house.other.name" }, /name key is house.testisle_house_a.name/);
    fails({ ...NEW, rent: 0 }, /rent must be/);
    fails({ ...NEW, rects: [] }, /1..16 rects/);
    fails({ ...NEW, rects: [{ x: 1062, y: 1046, z: 7, w: 256, h: 1 }] }, /invalid house rect/);
    fails({ ...NEW, rects: [{ x: 1080, y: 1046, z: 7, w: 10, h: 1 }] }, /not inside island/);
    fails({ ...NEW, rects: [{ x: 1062, y: 1046, z: 9, w: 1, h: 1 }] }, /floor 9 is not in/);
    fails(
      {
        ...NEW,
        rects: [
          { x: 1062, y: 1046, z: 7, w: 4, h: 3 },
          { x: 1063, y: 1047, z: 7, w: 1, h: 1 },
        ],
      },
      /overlap each other/,
    );
    fails({ ...NEW, doors: [] }, /1..8 doors/);
    fails({ ...NEW, doors: [{ x: 1070, y: 1048, z: 7 }] }, /not a tile of the house/);
    fails({ ...NEW, exit: { x: 1063, y: 1047, z: 7 } }, /outside the house/);
    fails({ ...NEW, exit: { x: 3153, y: 6402, z: 7 } }, /must be in island "testisle"/);
    fails({ op: "remove_house", id: "nope" }, /no house "nope"/);
    fails({ op: "set_house", id: "nope", rent: 1 }, /no house "nope"/);
    fails(
      {
        op: "set_house",
        id: "puerto_house_net",
        rects: [{ x: 1062, y: 1046, z: 7, w: 4, h: 3 }],
        doors: [{ x: 1063, y: 1048, z: 7 }],
        exit: { x: 1063, y: 1049, z: 7 },
      },
      /cannot move house "puerto_house_net" to island "testisle"/,
    );
  });

  it("applies nothing when a later op fails", () => {
    const w = loaded();
    const before = houses(w);
    expect(() =>
      applyOps(w, [NEW, { op: "remove_house", id: "puerto_house_net" }, { ...NEW }]),
    ).toThrow(/op 2: house "testisle_house_a" already exists/);
    expect(houses(w)).toEqual(before);
  });
});
