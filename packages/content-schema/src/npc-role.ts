// What an NPC does, in two words under its name (docs/06 "NPCs", docs/17 UI-3 "Nombres"):
// the client draws an NPC's label on two lines, "Tilde Varga" and "Provisiones". The role is
// content: a translation key the NPC names itself (`role` of data/npcs/<id>.yaml), or, when
// it names none, the default of what it offers, derived from its dialog and shop here. Pure
// and free of imports: make validate (validate.ts) and the client's content bundle
// (client/vite/content.ts) both read it, so the label and the check cannot disagree.

/** The defaults, most telling first: the first one an NPC offers names it. */
export const NPC_ROLE_KINDS = ["captain", "merchant", "healer", "trainer", "quest_giver"] as const;
export type NpcRoleKind = (typeof NPC_ROLE_KINDS)[number];

/** The translation key of a default role (i18n/<lang>/npcs.yaml). */
export const npcRoleDefaultKey = (kind: NpcRoleKind): string => `npc_role.${kind}`;

/** Longest role text and NPC name, in characters: the label never cuts them (two lines). */
export const NPC_ROLE_MAX_CHARS = 28;
export const NPC_NAME_MAX_CHARS = 22;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The dialog actions that make an NPC each kind. */
const ACTIONS: Readonly<Record<string, NpcRoleKind>> = {
  open_shop: "merchant",
  bless: "healer",
  heal: "healer",
  train_skill: "trainer",
  start_quest: "quest_giver",
};

/**
 * What a parsed data/npcs file offers, by its services: a node that sells boat routes
 * (captain), a shop (merchant), blessings or healing (healer), training (trainer), a quest
 * (quest giver). Undefined when it offers none of them: such an NPC must name its `role`.
 */
export function npcRoleKind(npc: unknown): NpcRoleKind | undefined {
  if (!isObj(npc)) return undefined;
  const found = new Set<NpcRoleKind>();
  if (isObj(npc["shop"])) found.add("merchant");
  const dialog = npc["dialog"];
  const nodes = isObj(dialog) && isObj(dialog["nodes"]) ? dialog["nodes"] : {};
  for (const node of Object.values(nodes)) {
    if (!isObj(node)) continue;
    if (node["boat_routes"] === true) found.add("captain");
    for (const opt of Array.isArray(node["options"]) ? node["options"] : []) {
      if (!isObj(opt)) continue;
      const action = opt["action"];
      for (const a of Array.isArray(action) ? action : [action]) {
        if (!isObj(a)) continue;
        for (const key of Object.keys(a)) {
          const kind = ACTIONS[key];
          if (kind) found.add(kind);
        }
      }
    }
  }
  return NPC_ROLE_KINDS.find((k) => found.has(k));
}

/**
 * The translation key of an NPC's role: its own `role`, else the default of what it
 * offers. Undefined when it has neither (make validate refuses that NPC).
 */
export function npcRoleKey(npc: unknown): string | undefined {
  if (isObj(npc) && typeof npc["role"] === "string" && npc["role"] !== "") return npc["role"];
  const kind = npcRoleKind(npc);
  return kind ? npcRoleDefaultKey(kind) : undefined;
}
