import { create, MessageKind, ServerMessageSchema } from "@rpg/protocol";
import type { MessageInitShape, ServerMessage } from "@rpg/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cuesOf, effectEvents, islandAt, loopFor, questPoolAt, sceneFor } from "./cues.ts";
import type { CueContext } from "./cues.ts";
import { loadQuestMusic, loadSounds, repoRoot, soundFiles } from "../../vite/content.ts";
import { NO_SOUNDS } from "./cues.ts";

type Msg = ServerMessage["message"];
type Init = MessageInitShape<typeof ServerMessageSchema>;
/** A server message from its plain-object init (protobuf fills the defaults). */
const msg = (m: NonNullable<Init["message"]>): Msg =>
  create(ServerMessageSchema, { message: m } as Init).message;
const ctx: CueContext = { selfId: 7, tool: undefined, craft: undefined };
const at = { x: 3, y: 4, z: 7 };

const system = (key: string): Msg =>
  msg({
    case: "chatMessage",
    value: { kind: MessageKind.SYSTEM, body: { case: "localized", value: { key, params: [] } } },
  });

describe("cuesOf", () => {
  it("names effects by id, elements included, at their tile", () => {
    expect(cuesOf(msg({ case: "effect", value: { pos: at, effectId: 1 } }), ctx)).toEqual([
      { events: ["effect.hit"], pos: at },
    ]);
    expect(effectEvents(2, undefined)).toEqual(["effect.block"]);
    expect(effectEvents(11, undefined)).toEqual(["effect.element.fire"]);
    expect(effectEvents(16, undefined)).toEqual(["effect.element.death"]);
    expect(effectEvents(99, undefined)).toEqual([]);
  });

  it("a gather effect is more specific with the tool that made it", () => {
    expect(effectEvents(5, "mining")).toEqual(["effect.gather.mining", "effect.gather"]);
    expect(effectEvents(5, undefined)).toEqual(["effect.gather"]);
  });

  it("only an effect on the tile the tool was used on sounds like that tool", () => {
    const vein = { x: 10, y: 10, z: 7 };
    const mining = { ...ctx, tool: { use: "mining", pos: vein } };
    const gather = (p: typeof at): Msg => msg({ case: "effect", value: { pos: p, effectId: 5 } });
    expect(cuesOf(gather(vein), mining)).toEqual([
      { events: ["effect.gather.mining", "effect.gather"], pos: vein },
    ]);
    // Another player's harvest a few tiles away, seen by this one.
    expect(cuesOf(gather({ x: 12, y: 10, z: 7 }), mining)).toEqual([
      { events: ["effect.gather"], pos: { x: 12, y: 10, z: 7 } },
    ]);
    // A craft makes the same effect at the station; Game.craft forgets the tool, and even
    // if it did not, the station is not the vein.
    const hearth = { x: 3, y: 4, z: 7 };
    expect(cuesOf(gather(hearth), mining)[0]?.events).toEqual(["effect.gather"]);
    expect(cuesOf(gather(hearth), ctx)[0]?.events).toEqual(["effect.gather"]);
  });

  it("projectiles sound from where they leave", () => {
    const p = msg({
      case: "projectile",
      value: { from: at, to: { x: 5, y: 5, z: 7 }, projectileId: 2 },
    });
    expect(cuesOf(p, ctx)).toEqual([{ events: ["projectile.fire"], pos: at }]);
  });

  it("only the player's own steps make a sound", () => {
    const move = (id: number): Msg =>
      msg({ case: "creatureMove", value: { id, from: at, to: at, durationMs: 200 } });
    expect(cuesOf(move(7), ctx)).toEqual([{ events: ["step.self"] }]);
    expect(cuesOf(move(8), ctx)).toEqual([]);
  });

  it("an own step has no cue when the canvas sounds it at each footfall (living world)", () => {
    const step = msg({ case: "creatureMove", value: { id: 7, from: at, to: at, durationMs: 200 } });
    expect(cuesOf(step, { ...ctx, footfalls: true })).toEqual([]);
    expect(cuesOf(step, { ...ctx, footfalls: false })).toEqual([{ events: ["step.self"] }]);
  });

  it("an own step sounds like the surface it lands on, then like any step (living world)", () => {
    const to = { x: 4, y: 5, z: 7 };
    const step = msg({ case: "creatureMove", value: { id: 7, from: at, to, durationMs: 200 } });
    const seen: unknown[] = [];
    const withSurface = {
      ...ctx,
      stepEvents: (p: unknown) => {
        seen.push(p);
        return ["step.self.sand", "step.self"];
      },
    };
    expect(cuesOf(step, withSurface)).toEqual([{ events: ["step.self.sand", "step.self"] }]);
    expect(seen).toEqual([to]);
  });

  it("system messages by key, with the station's craft or the tool first", () => {
    expect(cuesOf(system("progress.level_up"), ctx)).toEqual([
      { events: ["message.progress.level_up"] },
    ]);
    expect(cuesOf(system("craft.done"), { ...ctx, craft: "cooking" })).toEqual([
      { events: ["message.craft.done.cooking", "message.craft.done"] },
    ]);
    expect(cuesOf(system("gather.got"), { ...ctx, tool: { use: "fishing", pos: at } })).toEqual([
      { events: ["message.gather.got.fishing", "message.gather.got"] },
    ]);
  });

  it("dialogs open with a sound; chat lines and other messages are silent", () => {
    expect(cuesOf(msg({ case: "dialogOpen", value: { dialogId: 1 } }), ctx)).toEqual([
      { events: ["ui.dialog_open"] },
    ]);
    const chat = msg({
      case: "chatMessage",
      value: { kind: MessageKind.SAY, body: { case: "text", value: "hi" } },
    });
    expect(cuesOf(chat, ctx)).toEqual([]);
    expect(cuesOf(msg({ case: "creatureHealth", value: { id: 1 } }), ctx)).toEqual([]);
  });
});

describe("zones", () => {
  const islands = [
    { id: "puerto", x: 100, y: 100, w: 50, h: 50 },
    { id: "bosque", x: 200, y: 100, w: 50, h: 50 },
  ];
  const rules = { fadeMs: 0, islands: { puerto: "p", bosque: "b" }, underground: "cave" };

  it("finds the island of a tile", () => {
    expect(islandAt({ x: 100, y: 149, z: 7 }, islands)).toBe("puerto");
    expect(islandAt({ x: 150, y: 120, z: 7 }, islands)).toBeUndefined();
  });

  it("uses the underground loop below the sea floor, the island's elsewhere", () => {
    expect(loopFor({ x: 210, y: 110, z: 7 }, islands, rules)).toBe("b");
    expect(loopFor({ x: 210, y: 110, z: 6 }, islands, rules)).toBe("b");
    expect(loopFor({ x: 210, y: 110, z: 8 }, islands, rules)).toBe("cave");
    expect(loopFor({ x: 0, y: 0, z: 7 }, islands, rules)).toBeUndefined();
  });

  const music = {
    ...NO_SOUNDS.music,
    islands: { puerto: "town", bosque: "forest" },
    underground: "caves",
    title: "menu",
    bosses: { slagbound_warden: "forge" },
  };
  const forest = { x: 210, y: 110, z: 7 };
  const shrine = {
    quest: "ch3_warden",
    pool: "shrine",
    floors: [7, 8],
    rects: [{ x: 205, y: 105, w: 10, h: 10 }],
  };

  it("finds the quest area the player stands in, on its floors only", () => {
    expect(questPoolAt(forest, [shrine])).toBe("shrine");
    expect(questPoolAt({ ...forest, z: 8 }, [shrine])).toBe("shrine");
    expect(questPoolAt({ ...forest, z: 9 }, [shrine])).toBeUndefined();
    expect(questPoolAt({ x: 215, y: 110, z: 7 }, [shrine])).toBeUndefined(); // w is exclusive
    expect(questPoolAt(forest, [])).toBeUndefined();
  });

  it("gives the director the zone, the quest area and a boss in view, closest first", () => {
    expect(sceneFor(forest, islands, music, [shrine], ["wolf", "slagbound_warden"])).toEqual({
      kind: "world",
      zone: "forest",
      quest: "shrine",
      boss: "forge",
    });
    expect(sceneFor({ ...forest, z: 9 }, islands, music, [shrine], [])).toEqual({
      kind: "world",
      zone: "caves",
      quest: undefined,
      boss: undefined,
    });
  });

  it("an ordinary fight is not part of the scene: the zone's music goes on", () => {
    // Monsters in view that are not bosses (a fight with wolves) leave only the zone.
    expect(sceneFor(forest, islands, music, [], ["wolf", "wolf", "boar"])).toEqual({
      kind: "world",
      zone: "forest",
      quest: undefined,
      boss: undefined,
    });
  });
});

describe("assets/sounds.yaml", () => {
  const m = loadSounds(repoRoot());

  it("maps the events the client names to sounds", () => {
    const required = [
      "ui.click",
      "ui.dialog_open",
      "effect.hit",
      "effect.block",
      "effect.heal",
      "effect.gather.mining",
      "effect.gather.woodcutting",
      "effect.gather.fishing",
      "effect.element.fire",
      "effect.element.ice",
      "effect.element.energy",
      "effect.element.earth",
      "effect.element.holy",
      "effect.element.death",
      "projectile.physical",
      "message.progress.level_up",
      "message.death.died",
      "message.craft.done.smithing",
      "message.craft.done.cooking",
      "message.shop.bought",
    ];
    for (const e of required) expect(m.events[e], e).toBeDefined();
    for (const [e, ids] of Object.entries(m.events))
      for (const id of ids) expect(m.sounds[id]?.channel, `${e} → ${id}`).toMatch(/^(sfx|ui)$/);
  });

  it("every island has a pool of music, and the caves have their own", () => {
    for (const island of ["puerto", "bosque", "testisle", "volcan"]) {
      const pool = m.music.pools[m.music.islands[island] ?? ""] ?? [];
      expect(pool.length, island).toBeGreaterThan(0);
      for (const id of pool) expect(m.sounds[id]?.channel, `${island} ${id}`).toBe("music");
    }
    expect(m.music.underground).toBe("cave");
    // The owner's picks of 2026-11-18: Puerto alternates its three takes (plus the dusk version of 2026-11-26), the caves more.
    expect(m.music.pools[m.music.islands["puerto"] ?? ""]?.length).toBe(4);
    expect(m.music.pools["cave"]?.length ?? 0).toBeGreaterThan(1);
  });

  it("the title screen's and the bosses' music are pools of music, and fights have none", () => {
    for (const pool of [m.music.title, ...Object.values(m.music.bosses)])
      if (pool !== undefined) {
        expect(m.music.pools[pool]?.length, pool).toBeGreaterThan(0);
        for (const id of m.music.pools[pool] ?? []) expect(m.sounds[id]?.channel, id).toBe("music");
      }
    expect(Object.keys(m.music)).not.toContain("combat");
  });

  it("every whole track starts somewhere other than its beginning, with music after it", () => {
    for (const [id, def] of Object.entries(m.sounds)) {
      if (def.channel !== "music" || def.seconds === undefined) continue;
      expect(def.entries?.length, id).toBeGreaterThan(0);
      for (const e of def.entries ?? []) {
        expect(e, id).toBeGreaterThan(0);
        expect(e, id).toBeLessThanOrEqual((def.end ?? 0) - 30);
      }
      const gaps = (def.entries ?? []).slice(1).map((e, i) => e - (def.entries?.[i] ?? 0));
      for (const g of gaps) expect(g, id).toBeGreaterThanOrEqual(15 - 1e-6);
    }
  });

  it("an important quest's music names a pool", () => {
    for (const q of loadQuestMusic(repoRoot()))
      expect(m.music.pools[q.pool]?.length, q.quest).toBeGreaterThan(0);
  });

  it("serves files under audio/", () => {
    expect(m.sounds["hit"]?.url).toBe("audio/sounds/sfx/hit.ogg");
  });
});

describe("audio files served by the Vite plugin", () => {
  it("keeps pack file names as they are and never leaves assets/", () => {
    const root = mkdtempSync(join(tmpdir(), "client-sounds-"));
    try {
      mkdirSync(join(root, "assets"), { recursive: true });
      writeFileSync(
        join(root, "assets", "sounds.yaml"),
        [
          "format: 1",
          "sounds:",
          '  metal: { file: "vendor/kenney-impact/Sound Pack/impactMetal 000.ogg", channel: sfx }',
          '  sneaky: { file: "vendor/p/../../../etc/passwd.ogg", channel: sfx }',
        ].join("\n") + "\n",
      );
      const files = soundFiles(root);
      const url = "audio/vendor/kenney-impact/Sound Pack/impactMetal 000.ogg";
      expect([...files.keys()]).toEqual([url]);
      expect(files.get(url)).toBe(
        join(root, "assets", "vendor", "kenney-impact", "Sound Pack", "impactMetal 000.ogg"),
      );
      // The page fetches encodeURI(url); the plugin decodes the path back to the key.
      expect(decodeURIComponent(encodeURI(url))).toBe(url);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
