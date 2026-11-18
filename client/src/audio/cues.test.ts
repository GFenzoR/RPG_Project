import { create, MessageKind, ServerMessageSchema } from "@rpg/protocol";
import type { MessageInitShape, ServerMessage } from "@rpg/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blowAt, cuesOf, effectEvents, islandAt, loopFor, musicFor } from "./cues.ts";
import type { CueContext } from "./cues.ts";
import { loadSounds, repoRoot, soundFiles } from "../../vite/content.ts";

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
    ...rules,
    title: "menu",
    combat: "fight",
    combatHoldMs: 8000,
    bosses: { slagbound_warden: "forge" },
  };
  const forest = { x: 210, y: 110, z: 7 };

  it("plays a boss's loop while one is in view, over a fight and the zone", () => {
    expect(musicFor(forest, islands, music, ["wolf", "slagbound_warden"], true)).toBe("forge");
    expect(musicFor(forest, islands, music, ["slagbound_warden"], false)).toBe("forge");
    expect(musicFor(forest, islands, music, ["wolf"], true)).toBe("fight");
    expect(musicFor(forest, islands, music, ["wolf"], false)).toBe("b");
    expect(musicFor({ ...forest, z: 8 }, islands, music, [], false)).toBe("cave");
  });

  it("keeps the zone's loop in a fight when there is no fight music", () => {
    const quiet = { ...music, combat: undefined, bosses: {} };
    expect(musicFor(forest, islands, quiet, ["slagbound_warden"], true)).toBe("b");
  });

  it("a blow on the player's own tile is a fight; a heal there or a blow elsewhere is not", () => {
    const effect = (effectId: number, pos = at): Msg =>
      msg({ case: "effect", value: { pos, effectId } });
    expect(blowAt(effect(1), at)).toBe(true); // hit
    expect(blowAt(effect(2), at)).toBe(true); // block or miss
    expect(blowAt(effect(11), at)).toBe(true); // fire
    expect(blowAt(effect(3), at)).toBe(false); // heal
    expect(blowAt(effect(5), at)).toBe(false); // gather
    expect(blowAt(effect(1, { ...at, x: at.x + 1 }), at)).toBe(false);
    expect(blowAt(effect(1, { ...at, z: 8 }), at)).toBe(false);
    expect(blowAt(system("combat.cannot_attack"), at)).toBe(false);
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

  it("every island has music and the caves have their own", () => {
    for (const island of ["puerto", "bosque", "testisle"]) {
      expect(m.sounds[m.music.islands[island] ?? ""]?.channel).toBe("music");
      expect(m.sounds[m.ambient.islands[island] ?? ""]?.channel).toBe("ambient");
    }
    expect(m.music.underground).toBe("music_cueva");
  });

  it("the title screen's, a fight's and the bosses' music are music loops", () => {
    // Which of them play is the owner's pick (assets/sounds/music/gemini.yaml); the ones
    // there must be music, and a boss is a monster's content id.
    for (const id of [m.music.title, m.music.combat, ...Object.values(m.music.bosses)])
      if (id !== undefined) expect(m.sounds[id]?.channel, id).toBe("music");
    expect(m.music.combatHoldMs).toBeGreaterThan(0);
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
