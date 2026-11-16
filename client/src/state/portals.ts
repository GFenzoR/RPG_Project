// Portals of the map (world/islands/<id>/portals.yaml, docs/02 "Cambiar de piso"): the
// server moves the player; the client only needs to know which tiles to keep its paths
// off (stepping onto them moves the player) and which bare tiles are used.

/** The kinds of portals.yaml. */
export type PortalKind = "stairs" | "ladder" | "hole" | "rope_spot" | "teleport" | "boat";

/** Entrance tile ("x,y,z") → kind of its portal (ClientContent.portals). */
export type Portals = Readonly<Record<string, string>>;

/** Key of a tile in ClientContent.portals. */
export const portalKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Kinds that move whoever steps onto their tile. */
const ON_STEP: ReadonlySet<string> = new Set<PortalKind>(["stairs", "hole", "teleport"]);

/** Kinds used by hand: a ladder is climbed, a rope spot answers that it needs a rope. */
const USED: ReadonlySet<string> = new Set<PortalKind>(["ladder", "rope_spot"]);

/** Whether stepping onto (x, y, z) moves the player elsewhere (stairs, hole, teleport). */
export function movesOnStep(
  portals: Portals | undefined,
  x: number,
  y: number,
  z: number,
): boolean {
  const kind = portals?.[portalKey(x, y, z)];
  return kind !== undefined && ON_STEP.has(kind);
}

/** Whether a right click on the bare tile (x, y, z) uses its ground (a ladder, a rope spot). */
export function usedBare(portals: Portals | undefined, x: number, y: number, z: number): boolean {
  const kind = portals?.[portalKey(x, y, z)];
  return kind !== undefined && USED.has(kind);
}

/**
 * Whether (x, y, z) holds a ladder: using the tile climbs it whatever lies on it (a corpse
 * or a coin on a ladder must not hide it), by its ground (state/items.ts tileUse).
 */
export function climbable(portals: Portals | undefined, x: number, y: number, z: number): boolean {
  return portals?.[portalKey(x, y, z)] === "ladder";
}

/**
 * How using the tile (x, y, z) picks what it uses (state/items.ts tileUse): a ladder is
 * climbed whatever lies on it ("first", its ground); a bare house door or a bare portal used
 * by hand uses its ground (`bare`: what usesGround says, "bare"); anything else uses its
 * top item ("never"). `top` (Ctrl+right click on a desktop, or the touch menu's "Use" and
 * "Open") asks for the top item even on a ladder: a corpse lying there can then be opened
 * with the mouse. A bare ladder still climbs: there is nothing else to use.
 */
export function useMode(
  portals: Portals | undefined,
  bare: boolean,
  x: number,
  y: number,
  z: number,
  top: boolean,
): "first" | "bare" | "never" {
  if (!top && climbable(portals, x, y, z)) return "first";
  return bare ? "bare" : "never";
}

/**
 * The passable test of a click-to-walk path to goal: a path never crosses stairs, a hole
 * or a teleport on its way (the player would land elsewhere), only ends on one.
 */
export function pathPassable(
  portals: Portals | undefined,
  goal: { x: number; y: number; z: number },
  free: (x: number, y: number) => boolean,
): (x: number, y: number) => boolean {
  return (x, y) =>
    free(x, y) && ((x === goal.x && y === goal.y) || !movesOnStep(portals, x, y, goal.z));
}
