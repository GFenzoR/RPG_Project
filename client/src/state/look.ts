// What a creature looks like, as the server says (docs/05 "Apariencia y equipo visible"):
// the body of an engine humanoid (BodyLook, ids of data/looks.yaml), a player's visible
// equipment (item ids) and an NPC's or monster's worn pieces. Pure: WorldState keeps them
// per creature and render/look.ts dresses the paper doll from them.
import type {
  BodyLook,
  VisibleEquipment,
  Worn as WornMsg,
  WornPiece as WornPieceMsg,
} from "@rpg/protocol";
import type { Look, Worn, WornPiece, WornSlot } from "@rpg/renderer/look";

/** A player's visible slots: the item id in each (0 = empty). */
export interface EquipmentView {
  head: number;
  torso: number;
  legs: number;
  feet: number;
  leftHand: number;
  rightHand: number;
}

export const NO_EQUIPMENT: Readonly<EquipmentView> = Object.freeze({
  head: 0,
  torso: 0,
  legs: 0,
  feet: 0,
  leftHand: 0,
  rightHand: 0,
});

/** The body of a BodyLook; undefined when none came (not a humanoid, or an old server). */
export function lookView(m: BodyLook | undefined): Look | undefined {
  if (!m || m.body === "") return undefined;
  return { body: m.body, skin: m.skin, hair: m.hair, hairColor: m.hairColor, beard: m.beard };
}

/** The item ids of a VisibleEquipment (unset: nothing shows). */
export function equipmentView(m: VisibleEquipment | undefined): EquipmentView {
  if (!m) return NO_EQUIPMENT;
  return {
    head: m.head,
    torso: m.torso,
    legs: m.legs,
    feet: m.feet,
    leftHand: m.leftHand,
    rightHand: m.rightHand,
  };
}

const piece = (p: WornPieceMsg | undefined): WornPiece | undefined =>
  p && p.shape !== "" ? { shape: p.shape, tint: p.tint } : undefined;

/** An NPC's or monster's worn pieces (undefined when it wears nothing). */
export function wornView(m: WornMsg | undefined): Worn | undefined {
  if (!m) return undefined;
  const out: Worn = {};
  const slots: [WornSlot, WornPieceMsg | undefined][] = [
    ["head", m.head],
    ["torso", m.torso],
    ["legs", m.legs],
    ["feet", m.feet],
    ["shield", m.shield],
    ["weapon", m.weapon],
  ];
  for (const [slot, p] of slots) {
    const v = piece(p);
    if (v) out[slot] = v;
  }
  return out;
}

/** Whether two looks are the same body. */
export const sameLook = (a: Look | undefined, b: Look | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.body === b.body &&
    a.skin === b.skin &&
    a.hair === b.hair &&
    a.hairColor === b.hairColor &&
    a.beard === b.beard);

/** Whether two players show the same item in every visible slot. */
export const sameEquipment = (a: EquipmentView, b: EquipmentView): boolean =>
  a === b ||
  (a.head === b.head &&
    a.torso === b.torso &&
    a.legs === b.legs &&
    a.feet === b.feet &&
    a.leftHand === b.leftHand &&
    a.rightHand === b.rightHand);

const samePiece = (a: WornPiece | undefined, b: WornPiece | undefined): boolean =>
  a === b || (!!a && !!b && a.shape === b.shape && a.tint === b.tint);

/** Whether two creatures wear the same pieces (an NPC's or monster's). */
export function sameWorn(a: Worn | undefined, b: Worn | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const slots: WornSlot[] = ["head", "torso", "legs", "feet", "shield", "weapon"];
  return slots.every((s) => samePiece(a[s], b[s]));
}

/**
 * `prev` while it wears the same pieces as `next`, else `next`: a figure built from a new
 * object on every render (the Apariencia window) keeps one reference, so it is drawn
 * again only when what it wears changed.
 */
export function stableWorn(prev: Worn | undefined, next: Worn): Worn {
  return prev && sameWorn(prev, next) ? prev : next;
}

/** The choices of a player's look (ClientContent.lookOptions, data/looks.yaml order). */
export interface LookChoices {
  builds: readonly string[];
  skins: readonly string[];
  hairStyles: readonly string[];
  hairColors: readonly string[];
  beards: readonly string[];
}

/** Whether every id of `look` is a player's choice. */
export function choosable(o: LookChoices, look: Look): boolean {
  return (
    o.builds.includes(look.body) &&
    o.skins.includes(look.skin) &&
    o.hairStyles.includes(look.hair) &&
    o.hairColors.includes(look.hairColor) &&
    o.beards.includes(look.beard)
  );
}

/**
 * The look a picker starts from: `preferred` part by part when it is a choice (the default
 * outfit's body on the creation screen, the player's own in the Apariencia window), else
 * the first choice of each list.
 */
export function startingLook(o: LookChoices, preferred: Look | undefined): Look {
  const pick = (list: readonly string[], want: string | undefined): string =>
    want !== undefined && list.includes(want) ? want : (list[0] ?? "");
  return {
    body: pick(o.builds, preferred?.body),
    skin: pick(o.skins, preferred?.skin),
    hair: pick(o.hairStyles, preferred?.hair),
    hairColor: pick(o.hairColors, preferred?.hairColor),
    beard: pick(o.beards, preferred?.beard),
  };
}

/** A look picked at random (rand: [0, 1), like Math.random), every part a choice. */
export function randomLook(o: LookChoices, rand: () => number): Look {
  const pick = (list: readonly string[]): string =>
    list[Math.min(list.length - 1, Math.floor(rand() * list.length))] ?? "";
  return {
    body: pick(o.builds),
    skin: pick(o.skins),
    hair: pick(o.hairStyles),
    hairColor: pick(o.hairColors),
    beard: pick(o.beards),
  };
}
