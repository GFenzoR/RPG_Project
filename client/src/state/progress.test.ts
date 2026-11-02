import {
  MessageKind,
  MessageSchema,
  PlayerSkillsSchema,
  PlayerStatsSchema,
  TextParamSchema,
  create,
} from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import { formatMessage } from "./messages.ts";
import { WorldState } from "./world.ts";

const content: ClientContent = {
  items: {},
  monsterSprites: {},
  vocations: [],
  spells: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100 },
  i18n: {},
};

describe("progress (T1.7)", () => {
  it("keeps skills, stats and the last level-up", () => {
    const w = new WorldState(content);
    w.apply(
      {
        case: "playerSkills",
        value: create(PlayerSkillsSchema, {
          skills: [
            { skillId: "fist", level: 10, percent: 0 },
            { skillId: "sword", level: 12, percent: 40 },
          ],
        }),
      },
      0,
    );
    expect(w.skills).toEqual([
      { id: "fist", level: 10, percent: 0 },
      { id: "sword", level: 12, percent: 40 },
    ]);
    w.apply(
      {
        case: "playerStats",
        value: create(PlayerStatsSchema, {
          health: 150,
          maxHealth: 159,
          mana: 20,
          maxMana: 24,
          level: 2,
          experience: 30n,
          levelPercent: 5,
        }),
      },
      0,
    );
    expect(w.stats).toMatchObject({ level: 2, mana: 20, maxMana: 24, levelPercent: 5 });
    expect(w.levelUp).toBeUndefined();
    w.apply(
      {
        case: "chatMessage",
        value: create(MessageSchema, {
          kind: MessageKind.SYSTEM,
          body: {
            case: "localized",
            value: {
              key: "progress.level_up",
              params: [
                create(TextParamSchema, { name: "from", value: { case: "number", value: 1n } }),
                create(TextParamSchema, { name: "level", value: { case: "number", value: 2n } }),
              ],
            },
          },
        }),
      },
      1234,
    );
    expect(w.levelUp).toEqual({ level: 2, at: 1234 });
  });

  it("translates the skill parameter of skill_up", () => {
    const t = translator({
      "progress.skill_up": "You advanced to {skill} level {level}.",
      "skill.sword.name": "Sword",
    });
    const text = formatMessage(
      {
        key: "progress.skill_up",
        params: [
          create(TextParamSchema, { name: "skill", value: { case: "contentId", value: "sword" } }),
          create(TextParamSchema, { name: "level", value: { case: "number", value: 11n } }),
        ],
        at: 0,
      },
      content,
      t,
    );
    expect(text).toBe("You advanced to Sword level 11.");
  });
});
