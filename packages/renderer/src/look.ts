// The paper doll of the engine humanoids (docs/17 "Humanoides del motor"): which layers draw
// a player, an NPC or a humanoid monster, in which order, with which tint. Pure, no Pixi:
// the client's CreatureBody stacks one pooled sprite per layer from this, and spritegen
// composes its review sheets with the same order (tools/spritegen engine/specs/humanoid).
//
// A look is the body (build, skin, hair, hair colour, beard) and the visible equipment: one
// worn piece per slot, each a shape the sprite engine drew (data/looks.yaml `shapes`) and a
// tint (data/looks.yaml `tints`). Layers are drawn in a neutral ramp and tinted at runtime
// (a multiply), so a piece of the catalog costs no atlas space of its own (docs/07).
import type { AnimAction, AnimDir } from "./anim.ts";

/** The slots of the paper doll, the body's own and the worn ones. */
export type LayerSlot =
  "body" | "legs" | "feet" | "torso" | "hair" | "beard" | "head" | "shield" | "weapon";

/** The slots that show a worn piece (data/items `worn`). */
export type WornSlot = "head" | "torso" | "legs" | "feet" | "shield" | "weapon";
export const WORN_SLOTS: readonly WornSlot[] = [
  "head",
  "torso",
  "legs",
  "feet",
  "shield",
  "weapon",
];

/**
 * Draw order per facing, back to front. The body hides what is behind it inside each layer
 * (spritegen draws every layer with the body as occluder), so the order only has to settle
 * what lies outside the body: facing east the shield on the far (left) arm goes under the
 * body and the weapon in the near (right) hand over everything; facing west the other way
 * round; facing north both hands are in front of the body, away from the camera; facing
 * south both come toward it. The hair goes under the torso facing south (what hangs down
 * the back) and over it the other ways; the beard goes under everything facing north.
 */
export const LAYER_ORDER: Readonly<Record<AnimDir, readonly LayerSlot[]>> = {
  s: ["body", "legs", "feet", "hair", "torso", "beard", "head", "shield", "weapon"],
  n: ["weapon", "shield", "beard", "body", "legs", "feet", "torso", "hair", "head"],
  e: ["shield", "body", "legs", "feet", "torso", "hair", "beard", "head", "weapon"],
  w: ["weapon", "body", "legs", "feet", "torso", "hair", "beard", "head", "shield"],
};

/** The body: build, skin tone, hair style and colour, beard (ids of data/looks.yaml). */
export interface Look {
  body: string;
  skin: string;
  hair: string;
  hairColor: string;
  beard: string;
}

/** A worn piece as drawn: its shape and its tint (ids of data/looks.yaml). */
export interface WornPiece {
  shape: string;
  tint: string;
}

export type Worn = Partial<Record<WornSlot, WornPiece>>;

/** The colours and rules of data/looks.yaml the layers need (the client's content). */
export interface LookTables {
  /** Skin tone id -> 0xrrggbb. */
  skins: Readonly<Record<string, number>>;
  /** Hair colour id -> 0xrrggbb. */
  hairColors: Readonly<Record<string, number>>;
  /** Material tint id -> 0xrrggbb (the worn pieces). */
  tints: Readonly<Record<string, number>>;
  /** Head shape -> the body slots it hides (a hood hides the hair; a full helm, the beard too). */
  hides?: Readonly<Record<string, readonly LayerSlot[]>>;
}

/** Styles that draw nothing: a bald head, a shaven face. */
export const NO_HAIR = "bald";
export const NO_BEARD = "none";

/** One layer to draw: its slot, its atlas sprite and frame, and its tint. */
export interface LayerDraw {
  slot: LayerSlot;
  sprite: string;
  /** The atlas frame: <sprite>/<action>_<dir>_<n> (docs/17 ANI-4). */
  frame: string;
  tint: number;
}

/** Death is drawn facing south (like today's player): every layer falls the same way. */
export const actionDir = (action: AnimAction, dir: AnimDir): AnimDir =>
  action === "death" ? "s" : dir;

/** The atlas path of a layer: humans/... for the body's own, worn/... for the pieces. */
export function layerSprite(slot: LayerSlot, shape: string, build: string): string {
  if (slot === "body") return `humans/body_${shape}`;
  if (slot === "hair" || slot === "beard") return `humans/${slot}_${shape}`;
  if (slot === "torso") return `worn/torso_${shape}_${build}`;
  return `worn/${slot}_${shape}`;
}

/** Multiply tint that leaves a sprite as drawn. */
const WHITE = 0xffffff;

/**
 * The layers of a look and what it wears, as the sprite of each slot and its tint, in no
 * particular order (LAYER_ORDER orders them). Unknown ids draw untinted; a bald head and a
 * shaven face draw no layer; a head piece hides what data/looks.yaml says it hides.
 */
export function lookSprites(
  look: Look,
  worn: Worn,
  tables: LookTables,
): Partial<Record<LayerSlot, { sprite: string; tint: number }>> {
  const out: Partial<Record<LayerSlot, { sprite: string; tint: number }>> = {};
  const build = look.body;
  out.body = { sprite: layerSprite("body", build, build), tint: tables.skins[look.skin] ?? WHITE };
  const hidden = new Set<LayerSlot>(worn.head ? (tables.hides?.[worn.head.shape] ?? []) : []);
  const hair = tables.hairColors[look.hairColor] ?? WHITE;
  if (look.hair !== NO_HAIR && !hidden.has("hair"))
    out.hair = { sprite: layerSprite("hair", look.hair, build), tint: hair };
  if (look.beard !== NO_BEARD && !hidden.has("beard"))
    out.beard = { sprite: layerSprite("beard", look.beard, build), tint: hair };
  for (const slot of WORN_SLOTS) {
    const piece = worn[slot];
    if (!piece) continue;
    out[slot] = {
      sprite: layerSprite(slot, piece.shape, build),
      tint: tables.tints[piece.tint] ?? WHITE,
    };
  }
  return out;
}

/**
 * The layers to draw for one frame, back to front: the paper doll of `look` wearing `worn`,
 * facing `dir`, in frame `frame` of `action`. Pure; the client calls it when a look or a
 * facing changes and draws every frame from what it built (CreatureBody, no allocation).
 */
export function lookLayers(
  look: Look,
  worn: Worn,
  dir: AnimDir,
  action: AnimAction,
  frame: number,
  tables: LookTables,
): LayerDraw[] {
  const sprites = lookSprites(look, worn, tables);
  const d = actionDir(action, dir);
  const out: LayerDraw[] = [];
  for (const slot of LAYER_ORDER[d]) {
    const s = sprites[slot];
    if (s)
      out.push({
        slot,
        sprite: s.sprite,
        frame: `${s.sprite}/${action}_${d}_${frame}`,
        tint: s.tint,
      });
  }
  return out;
}

/** The clip an attack plays with a weapon class in hand (docs/17 ANI-7 and ART-2). */
export type WeaponAction = "attack" | "shoot" | "cast";

/**
 * Which clip a humanoid's attack plays: a spell always casts; otherwise the weapon decides
 * (a bow or a crossbow shoots, a wand or a staff casts, a blade, an axe, a mace, a spear or
 * the bare fist swings). `weaponShape` is the worn shape in the weapon slot, if any.
 */
export function attackActionFor(
  kind: "melee" | "ranged" | "spell",
  weaponShape: string | undefined,
): WeaponAction {
  if (kind === "spell") return "cast";
  if (weaponShape === "bow" || weaponShape === "crossbow") return "shoot";
  if (weaponShape === "wand" || weaponShape === "staff") return "cast";
  // A blow, or a throw without a bow (the overhand swing reads as one).
  return "attack";
}
