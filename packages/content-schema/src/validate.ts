// Validates data/ and i18n/ against the JSON Schemas plus the rules a schema cannot
// express: unique IDs, cross references, dialog graphs, translations and ids.lock.yaml.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isLicenseFile, registeredPacks } from "./credits.ts";
import { checkIdsLock } from "./ids.ts";
import { SCHEMA_DIR, SchemaSet } from "./schemas.ts";
import type { RefKind, SchemaName, Usage } from "./schemas.ts";
import { loadYaml, parseYaml, suggest } from "./source.ts";
import type { Diagnostic, PathSegment, SourceFile } from "./source.ts";

export const LANGUAGES = ["es", "en"] as const;

/** Source trees whose literal i18n keys must exist (checkCodeKeys). */
const CODE_DIRS = [
  { dir: "server/internal", ext: [".go"] },
  { dir: "client/src", ext: [".ts", ".tsx"] },
  { dir: "editor/src", ext: [".ts", ".tsx"] },
];

/** A literal that is a file name ("island.yaml"), not an i18n key. */
const FILE_NAME = /\.(ya?ml|json|go|tsx?|css|png|bin|sql)$/;

/** Source files under dir (recursively) with one of ext, skipping tests and generated code. */
function codeFiles(dir: string, ext: readonly string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (entry !== "pb" && entry !== "node_modules" && entry !== "testdata")
        out.push(...codeFiles(abs, ext));
    } else if (
      ext.some((e) => entry.endsWith(e)) &&
      !/(_test\.go|\.test\.tsx?|\.pb\.go|\.d\.ts)$/.test(entry)
    ) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Dialog actions that only run on a dev_only island of world/world.yaml (the sandbox
 * island's instructor, docs/06 "Diálogos"): anywhere else they would hand out what playing
 * earns. The server refuses them too (content.Action.DevOnly).
 */
export const DEV_ONLY_ACTIONS: readonly string[] = ["train_skill", "restore_mana"];

/** The look of every new character (data/outfits.yaml); free, so never sold. */
const DEFAULT_OUTFIT = "citizen";

/** The longest aimed range: aimRange in common.schema.json (server content.MaxRange). */
const MAX_RANGE = (
  JSON.parse(readFileSync(new URL("common.schema.json", SCHEMA_DIR), "utf8")) as {
    $defs: { aimRange: { maximum: number } };
  }
).$defs.aimRange.maximum;

const SKILLS = {
  combat: ["fist", "sword", "axe", "club", "distance", "shield", "magic", "fishing"],
  craft: ["mining", "woodcutting", "smithing", "cooking", "alchemy"],
};

/** Item sub-objects that only make sense for one kind. */
const KIND_BLOCKS = [
  "ground",
  "weapon",
  "armor",
  "shield",
  "container",
  "tool",
  "consumable",
  "currency",
  "rune",
  "ammo",
];

export interface ValidateOptions {
  /** Contents of ids.lock.yaml at the base revision; numbers there must not change. */
  baseIdsLock?: string;
}

export interface ValidationReport {
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
}

interface Owned {
  src: SourceFile;
  path: PathSegment[];
}

interface ContentIndex {
  ids: Record<RefKind, Map<string, Owned>>;
  refs: (Usage & { kind: RefKind; src: SourceFile })[];
  i18nKeys: (Usage & { src: SourceFile })[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** The twelve pieces of a fringe and of the surf (BORDER_PIECES of @rpg/map-format ops). */
const BORDER_PIECES = [
  "n",
  "e",
  "s",
  "w",
  "nw",
  "ne",
  "se",
  "sw",
  "inner_nw",
  "inner_ne",
  "inner_se",
  "inner_sw",
] as const;
/** The rewards of an item's chest block (docs/02 "Libros y cofres"), with their index. */
const chestRewards = (item: Obj): { item: string; count: number; index: number }[] => {
  const chest = item["chest"];
  const out: { item: string; count: number; index: number }[] = [];
  for (const [index, r] of (isObj(chest) ? asList(chest["rewards"]) : []).entries())
    if (isObj(r) && typeof r["item"] === "string")
      out.push({ item: r["item"], count: typeof r["count"] === "number" ? r["count"] : 1, index });
  return out;
};
const idOf = (v: unknown): string | undefined =>
  isObj(v) && typeof v["id"] === "string" ? v["id"] : undefined;

/** The count of a has_item or take_item: 1 when unset (content.ItemCount.N). */
const countOf = (c: Obj): number => (typeof c["count"] === "number" ? Math.max(c["count"], 1) : 1);

/** A tile of the map: x, y and floor. */
type Tile = [number, number, number];

/**
 * The portal kinds a step onto leaves at once, so nobody stands on their entrance
 * (PortalKind.OnStep on the server, ON_STEP_KINDS of @rpg/map-format).
 */
const STEP_PORTALS = ["stairs", "hole", "teleport"];

/** How far (Chebyshev, same floor) a player may stand from an NPC to talk (session.TalkRange). */
const TALK_RANGE = 3;

/** The tiles within r (Chebyshev) of x, y on floor z. */
function* square(x: number, y: number, z: number, r: number): Generator<Tile> {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) yield [x + dx, y + dy, z];
}

/** An island of world/world.yaml that is not dev_only, as checkQuestReach reads it. */
interface ProductionIsland {
  x: number;
  y: number;
  w: number;
  h: number;
  floors: number[];
  /** Zone id → its tiles, produced as they are read. */
  zones: Map<string, Iterable<Tile>>;
  /** The entrances of its stairs, holes and teleports (portals.yaml), "x,y,z". */
  entrances: Set<string>;
  /** Where its NPCs stand (npcs.yaml). */
  npcs: { npc: string; at: Tile }[];
}

export function validateContent(root: string, opts: ValidateOptions = {}): ValidationReport {
  const v = new Validator(root);
  v.run(opts);
  const errors = v.diags.filter((d) => d.severity === "error").length;
  return { diagnostics: v.diags, errors, warnings: v.diags.length - errors };
}

class Validator {
  readonly diags: Diagnostic[] = [];
  private readonly schemas = new SchemaSet();
  private readonly index: ContentIndex = {
    ids: {
      item: new Map(),
      monster: new Map(),
      npc: new Map(),
      quest: new Map(),
      vocation: new Map(),
      spell: new Map(),
      shop: new Map(),
    },
    refs: [],
    i18nKeys: [],
  };
  private readonly npcs: SourceFile[] = [];
  private readonly monsters: SourceFile[] = [];
  private readonly quests: SourceFile[] = [];
  /** Every item with where it is defined, for the rules across items (checkDoors). */
  private readonly items: (Owned & { item: Obj })[] = [];
  private balance: SourceFile | undefined;
  private recipes: SourceFile | undefined;
  private spells: SourceFile | undefined;
  private tutorial: SourceFile | undefined;
  /** data/livingworld/*.yaml (livingworld/README.md), checked after the items. */
  private living: SourceFile[] = [];

  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  run(opts: ValidateOptions): void {
    const dataDir = join(this.root, "data");
    if (!existsSync(dataDir)) {
      this.error("data", [], "directory not found");
      return;
    }
    this.loadData(dataDir);
    this.checkRefs();
    this.checkDoors();
    this.checkDialogs();
    this.checkQuestSteps();
    this.checkQuestReach();
    this.checkRepeatable();
    this.checkNpcActions();
    this.checkDevOnlyActions();
    this.checkShopPrices();
    this.checkQuestItemSources();
    this.checkToolTargets();
    this.checkItemTrade();
    this.checkRetiredItems();
    this.checkEquipLevels();
    this.checkForge();
    this.checkChests();
    this.checkMilestones();
    this.checkQuestDrops();
    this.checkSummons();
    this.checkI18n();
    this.checkSounds();
    this.checkLivingWorld();
    const lockFile = join(dataDir, "ids.lock.yaml");
    const lock = existsSync(lockFile)
      ? this.load(lockFile, "data/ids.lock.yaml", "ids-lock")
      : undefined;
    if (!lock && this.index.ids.item.size > 0 && !existsSync(lockFile)) {
      this.error("data/ids.lock.yaml", [], "missing; run `make gen-ids`");
    }
    if (lock) {
      const base =
        opts.baseIdsLock === undefined ? undefined : this.parseBaseLock(opts.baseIdsLock);
      // The chests of data/items (chest id → item; a repeated id is checkChests' error).
      const chests = new Map<string, string>();
      for (const { item } of this.items) {
        const chest = item["chest"];
        const cid = isObj(chest) ? chest["id"] : undefined;
        if (typeof cid === "string" && !chests.has(cid)) chests.set(cid, String(item["id"]));
      }
      for (const d of checkIdsLock(lock, [...this.index.ids.item.keys()], base, chests))
        this.diags.push(d);
    }
  }

  // ---- loading -------------------------------------------------------------

  private loadData(dataDir: string): void {
    const known = new Set(["ids.lock.yaml"]);
    const single = (
      file: string,
      schema: SchemaName,
      required: boolean,
    ): SourceFile | undefined => {
      known.add(file);
      const abs = join(dataDir, file);
      if (!existsSync(abs)) {
        if (required) this.error(`data/${file}`, [], "required file is missing");
        return undefined;
      }
      return this.load(abs, `data/${file}`, schema);
    };

    const balance = single("balance.yaml", "balance", true);
    this.balance = balance;
    if (balance) this.checkBalance(balance);

    const vocations = single("vocations.yaml", "vocations", true);
    if (vocations) {
      for (const [i, voc] of asList(vocations.data).entries()) {
        this.register("vocation", voc, vocations, [i]);
        this.checkVocation(voc, vocations, [i]);
      }
    }

    for (const src of this.loadDir(dataDir, "items", "items", known)) {
      for (const [i, item] of asList(src.data).entries()) {
        this.register("item", item, src, [i]);
        this.checkItem(item, src, [i]);
        if (isObj(item)) this.items.push({ item, src, path: [i] });
      }
    }

    for (const [dir, schema, kind] of [
      ["monsters", "monster", "monster"],
      ["npcs", "npc", "npc"],
      ["quests", "quest", "quest"],
    ] as const) {
      for (const src of this.loadDir(dataDir, dir, schema, known)) {
        const id = idOf(src.data);
        const expected = src.file.replace(/^.*\//, "").replace(/\.yaml$/, "");
        if (id !== undefined && id !== expected) {
          this.error(src, ["id"], `id "${id}" must match the file name "${expected}.yaml"`);
        }
        this.register(kind, src.data, src, []);
        if (kind === "monster") {
          this.monsters.push(src);
          this.checkMonster(src);
        }
        if (kind === "npc") {
          this.npcs.push(src);
          const shop = isObj(src.data) ? src.data["shop"] : undefined;
          this.register("shop", shop, src, ["shop"]);
        }
        if (kind === "quest") this.quests.push(src);
      }
    }

    const spells = single("spells.yaml", "spells", false);
    this.spells = spells;
    if (spells) {
      const words = new Map<string, number>();
      for (const [i, spell] of asList(spells.data).entries()) {
        this.register("spell", spell, spells, [i]);
        const w = isObj(spell) ? spell["words"] : undefined;
        if (typeof w !== "string") continue;
        const first = words.get(w);
        if (first !== undefined)
          this.error(spells, [i, "words"], `words "${w}" already used by spells[${first}]`);
        else words.set(w, i);
      }
    }

    let outfits: SourceFile | undefined;
    for (const [file, schema] of [
      ["recipes.yaml", "recipes"],
      ["boat_routes.yaml", "boat_routes"],
      ["borders.yaml", "borders"],
      ["outfits.yaml", "outfits"],
    ] as const) {
      const src = single(file, schema, false);
      if (!src) continue;
      this.checkUniqueIds(src);
      if (schema === "borders") this.checkBorders(src);
      if (schema === "outfits") outfits = src;
      if (schema === "recipes") this.recipes = src;
    }

    const attributes = single("attributes.yaml", "attributes", false);
    if (attributes) this.checkAttributes(attributes);

    const cosmetics = single("cosmetics.yaml", "cosmetics", false);
    if (cosmetics) this.checkCosmetics(cosmetics, outfits);

    const looks = single("looks.yaml", "looks", false);
    this.checkLooks(looks, outfits);

    const tutorial = single("tutorial.yaml", "tutorial", false);
    this.tutorial = tutorial;
    if (tutorial) this.checkTutorial(tutorial, dataDir);

    for (const src of this.loadDir(dataDir, "news", "news", known)) this.checkNews(src);

    this.loadLivingWorld(dataDir, known);

    for (const entry of readdirSync(dataDir).sort()) {
      if (!known.has(entry)) {
        this.error(
          `data/${entry}`,
          [],
          "unexpected file: there is no schema for it (see docs/06-content-data.md)",
        );
      }
    }
  }

  /**
   * data/livingworld/<name>.yaml (livingworld/README.md): each file has its own schema,
   * livingworld-<name>.schema.json, so a new kind of living world content brings its schema
   * along. Plants are listed once; every surface a ground item uses is described.
   */
  private loadLivingWorld(dataDir: string, known: Set<string>): void {
    known.add("livingworld");
    const abs = join(dataDir, "livingworld");
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs).sort()) {
      const rel = `data/livingworld/${entry}`;
      const name = entry.replace(/\.yaml$/, "");
      if (
        !entry.endsWith(".yaml") ||
        !existsSync(new URL(`livingworld-${name}.schema.json`, SCHEMA_DIR))
      ) {
        this.error(
          rel,
          [],
          `no schema for it (packages/content-schema/schemas/livingworld-${name}.schema.json)`,
        );
        continue;
      }
      const src = this.load(join(abs, entry), rel, `livingworld-${name}`);
      if (!src || !isObj(src.data)) continue;
      if (name === "objects") this.living.push(src);
      if (name === "plants") {
        const seen = new Map<string, number>();
        for (const [i, p] of asList(src.data["plants"]).entries()) {
          const item = isObj(p) ? p["item"] : undefined;
          if (typeof item !== "string") continue;
          const first = seen.get(item);
          if (first !== undefined)
            this.error(
              src,
              ["plants", i, "item"],
              `plant "${item}" already listed at plants[${first}]`,
            );
          else seen.set(item, i);
        }
      }
      if (name === "surfaces") {
        const described = isObj(src.data["surfaces"]) ? src.data["surfaces"] : {};
        for (const { item, src: itemSrc, path } of this.items) {
          const ground = item["ground"];
          const surface = isObj(ground) ? ground["surface"] : undefined;
          if (typeof surface === "string" && !(surface in described))
            this.error(
              itemSrc,
              [...path, "ground", "surface"],
              `surface "${surface}" is not described in data/livingworld/surfaces.yaml`,
            );
        }
      }
    }
  }

  private loadDir(
    dataDir: string,
    dir: string,
    schema: SchemaName,
    known: Set<string>,
  ): SourceFile[] {
    known.add(dir);
    const abs = join(dataDir, dir);
    if (!existsSync(abs)) return [];
    const out: SourceFile[] = [];
    for (const entry of readdirSync(abs).sort()) {
      const rel = `data/${dir}/${entry}`;
      if (!entry.endsWith(".yaml") || statSync(join(abs, entry)).isDirectory()) {
        this.error(rel, [], "expected only .yaml files here");
        continue;
      }
      const src = this.load(join(abs, entry), rel, schema);
      if (src) out.push(src);
    }
    return out;
  }

  private load(abs: string, rel: string, schema: SchemaName): SourceFile | undefined {
    const src = loadYaml(abs, rel, this.diags);
    if (!src) return undefined;
    this.applySchema(src, schema);
    return src;
  }

  private applySchema(src: SourceFile, schema: SchemaName): void {
    const res = this.schemas.validate(schema, src.data);
    for (const e of res.errors) this.error(src, e.path, e.message);
    for (const r of res.refs) this.index.refs.push({ ...r, src });
    for (const k of res.i18nKeys) this.index.i18nKeys.push({ ...k, src });
  }

  private register(kind: RefKind, value: unknown, src: SourceFile, path: PathSegment[]): void {
    const id = idOf(value);
    if (id === undefined) return;
    const prev = this.index.ids[kind].get(id);
    if (prev) {
      const loc = prev.src.locate([...prev.path, "id"]);
      this.error(
        src,
        [...path, "id"],
        `duplicate ${kind} id "${id}" (first defined in ${prev.src.file}${loc ? `:${loc.line}` : ""})`,
      );
      return;
    }
    this.index.ids[kind].set(id, { src, path });
  }

  /** data/news/<YYYY-MM-DD>-<slug>.yaml (T4.3): the name gives the URL; date must match it. */
  private checkNews(src: SourceFile): void {
    const name = src.file.replace(/^.*\//, "");
    const m = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/.exec(name);
    if (!m) {
      this.error(src, [], "news file names are <YYYY-MM-DD>-<slug>.yaml (slug: a-z, 0-9, -)");
      return;
    }
    const date = isObj(src.data) ? src.data["date"] : undefined;
    if (typeof date === "string" && date !== m[1])
      this.error(src, ["date"], `date "${date}" must match the file name (${m[1] ?? ""})`);
  }

  private checkUniqueIds(src: SourceFile): void {
    this.checkUniqueIdsOf(src, asList(src.data), []);
  }

  // ---- per-type rules --------------------------------------------------------

  /**
   * data/attributes.yaml (docs/06 "Atributo"): unique ids, bands from level 1 with growing
   * levels and min <= max.
   */
  private checkAttributes(src: SourceFile): void {
    this.checkUniqueIds(src);
    for (const [i, attr] of asList(src.data).entries()) {
      if (!isObj(attr)) continue;
      let last = 0;
      for (const [j, band] of asList(attr["bands"]).entries()) {
        if (!isObj(band)) continue;
        const level = Number(band["level"]);
        if (j === 0 && level !== 1)
          this.error(src, [i, "bands", j, "level"], "the first band is level 1");
        if (j > 0 && level <= last)
          this.error(src, [i, "bands", j, "level"], "band levels must grow");
        last = level;
        if (Number(band["min"]) > Number(band["max"]))
          this.error(src, [i, "bands", j], "min is greater than max");
      }
    }
  }

  /**
   * data/looks.yaml (docs/06 "Looks"): every look, worn piece and outfit of data/ names its
   * sex, build, skin, hair, beard, shape (of the right slot) and tint there. An item's `worn`
   * takes the slot it is equipped in; jewellery is never drawn. A player's outfit uses no
   * creatures_only skin and wears nothing but its clothes.
   */
  private checkLooks(looks: SourceFile | undefined, outfits: SourceFile | undefined): void {
    const data = looks && isObj(looks.data) ? looks.data : undefined;
    const ids = (v: unknown): Set<string> =>
      new Set(
        isObj(v) ? Object.keys(v) : asList(v).filter((x): x is string => typeof x === "string"),
      );
    const shapes = isObj(data?.["shapes"]) ? data["shapes"] : {};
    const t = {
      sexes: ids(data?.["sexes"]),
      builds: ids(data?.["builds"]),
      skins: ids(data?.["skins"]),
      hair: ids(data?.["hair_styles"]),
      hairColors: ids(data?.["hair_colors"]),
      beards: ids(data?.["beards"]),
      tints: ids(data?.["tints"]),
    };
    const creaturesOnly = new Set(
      Object.entries(isObj(data?.["skins"]) ? data["skins"] : {})
        .filter(([, v]) => isObj(v) && v["creatures_only"] === true)
        .map(([k]) => k),
    );
    if (looks && data)
      for (const shape of Object.keys(isObj(data["hides"]) ? data["hides"] : {}))
        if (!ids(shapes["head"]).has(shape))
          this.error(looks, ["hides", shape], `"${shape}" is not a head shape of shapes.head`);
    const where = "data/looks.yaml";
    const known = (
      src: SourceFile,
      path: PathSegment[],
      value: unknown,
      set: Set<string>,
      what: string,
    ): void => {
      if (typeof value !== "string" || set.has(value)) return;
      const hint = suggest(value, [...set]);
      this.error(
        src,
        path,
        `unknown ${what} "${value}" in ${where}${hint ? ` (did you mean "${hint}"?)` : ""}`,
      );
    };
    const piece = (src: SourceFile, path: PathSegment[], v: unknown, slot: string): void => {
      if (!isObj(v)) return;
      known(src, [...path, "shape"], v["shape"], ids(shapes[slot]), `${slot} shape`);
      known(src, [...path, "tint"], v["tint"], t.tints, "tint");
    };
    const lookOf = (src: SourceFile, path: PathSegment[], v: unknown, player: boolean): void => {
      if (!isObj(v)) return;
      if (!data) {
        this.error(src, path, `a look needs ${where}`);
        return;
      }
      known(src, [...path, "sex"], v["sex"], t.sexes, "sex");
      known(src, [...path, "body"], v["body"], t.builds, "build");
      known(src, [...path, "skin"], v["skin"], t.skins, "skin");
      known(src, [...path, "hair"], v["hair"], t.hair, "hair style");
      known(src, [...path, "hair_color"], v["hair_color"], t.hairColors, "hair colour");
      known(src, [...path, "beard"], v["beard"], t.beards, "beard");
      if (player && typeof v["skin"] === "string" && creaturesOnly.has(v["skin"]))
        this.error(
          src,
          [...path, "skin"],
          `skin "${v["skin"]}" is creatures_only: not for a player`,
        );
      const worn = v["worn"];
      if (player && worn !== undefined)
        this.error(src, [...path, "worn"], "a player's outfit wears its clothes, not worn");
      for (const [slot, w] of Object.entries(isObj(worn) ? worn : {}))
        piece(src, [...path, "worn", slot], w, slot);
    };
    for (const { item, src, path } of this.items) {
      const worn = item["worn"];
      if (worn === undefined) continue;
      if (!data) {
        this.error(src, [...path, "worn"], `worn needs ${where}`);
        continue;
      }
      const armor = isObj(item["armor"]) ? item["armor"]["slot"] : undefined;
      const slot =
        item["kind"] === "weapon"
          ? "weapon"
          : item["kind"] === "shield"
            ? "shield"
            : armor === "body"
              ? "torso"
              : armor === "head" || armor === "legs" || armor === "feet"
                ? armor
                : undefined;
      if (!slot) {
        this.error(
          src,
          [...path, "worn"],
          "only weapons, shields and head, body, legs and feet armour are drawn on the figure",
        );
        continue;
      }
      piece(src, [...path, "worn"], worn, slot);
    }
    for (const list of [this.npcs, this.monsters])
      for (const src of list) if (isObj(src.data)) lookOf(src, ["look"], src.data["look"], false);
    if (outfits)
      for (const [i, o] of asList(outfits.data).entries()) {
        if (!isObj(o)) continue;
        lookOf(outfits, [i, "look"], o["look"], true);
        for (const [slot, w] of Object.entries(isObj(o["clothes"]) ? o["clothes"] : {}))
          piece(outfits, [i, "clothes", slot], w, slot);
      }
  }

  /**
   * data/cosmetics.yaml (T5.7): unique ids (packs and cosmetics apart), each cosmetic only
   * carries the field of its kind, an outfit names a look of data/outfits.yaml other than
   * the free default, no two colours share a tint, and the texts exist: cosmetic.<id>.name
   * and .desc, cosmetic_pack.<id>.name and premium.name / premium.amount. No pack is worth
   * more than limits.daily_premium (it could never be bought).
   */
  private checkCosmetics(src: SourceFile, outfits: SourceFile | undefined): void {
    if (!isObj(src.data)) return;
    const key = (value: string, path: PathSegment[]): void => {
      this.index.i18nKeys.push({ value, path, src });
    };
    key("premium.name", ["currency"]);
    key("premium.amount", ["currency"]);
    const packs = asList(src.data["packs"]);
    this.checkUniqueIdsOf(src, packs, ["packs"]);
    const limits = src.data["limits"];
    const daily = isObj(limits) ? limits["daily_premium"] : undefined;
    for (const [i, pack] of packs.entries()) {
      const id = idOf(pack);
      if (id !== undefined) key(`cosmetic_pack.${id}.name`, ["packs", i, "id"]);
      const amount = isObj(pack) ? pack["amount"] : undefined;
      if (typeof daily === "number" && typeof amount === "number" && amount > daily)
        this.error(
          src,
          ["packs", i, "amount"],
          `amount ${amount} is over limits.daily_premium ${daily}: the pack could never be bought`,
        );
    }
    const list = asList(src.data["cosmetics"]);
    this.checkUniqueIdsOf(src, list, ["cosmetics"]);
    const looks = new Set(
      (outfits ? asList(outfits.data) : []).map(idOf).filter((id) => id !== undefined),
    );
    const fieldOf: Record<string, string> = {
      outfit: "outfit",
      outfit_color: "tint",
      name_effect: "style",
    };
    const tints = new Map<string, string>();
    for (const [i, c] of list.entries()) {
      if (!isObj(c)) continue;
      const id = idOf(c);
      if (id !== undefined) {
        key(`cosmetic.${id}.name`, ["cosmetics", i, "id"]);
        key(`cosmetic.${id}.desc`, ["cosmetics", i, "id"]);
      }
      const kind = typeof c["kind"] === "string" ? c["kind"] : "";
      for (const [k, field] of Object.entries(fieldOf)) {
        if (field in c && kind !== k)
          this.error(src, ["cosmetics", i, field], `"${field}" is only allowed with kind: ${k}`);
      }
      const look = c["outfit"];
      if (kind === "outfit" && typeof look === "string") {
        if (look === DEFAULT_OUTFIT)
          this.error(
            src,
            ["cosmetics", i, "outfit"],
            `"${DEFAULT_OUTFIT}" is every player's free look and cannot be sold`,
          );
        else if (!looks.has(look)) {
          const hint = suggest(look, looks);
          this.error(
            src,
            ["cosmetics", i, "outfit"],
            `unknown outfit "${look}" in data/outfits.yaml${hint ? ` (did you mean "${hint}"?)` : ""}`,
          );
        }
      }
      const tint = c["tint"];
      if (kind === "outfit_color" && typeof tint === "string") {
        const prev = tints.get(tint);
        if (prev !== undefined)
          this.error(src, ["cosmetics", i, "tint"], `tint ${tint} is already sold as "${prev}"`);
        else tints.set(tint, id ?? "?");
      }
    }
  }

  private checkBalance(src: SourceFile): void {
    const skills =
      isObj(src.data) && isObj(src.data["skills"]) ? src.data["skills"]["base"] : undefined;
    if (!isObj(skills)) return;
    for (const s of [...SKILLS.combat, ...SKILLS.craft]) {
      if (!(s in skills)) this.error(src, ["skills", "base"], `missing skill "${s}"`);
    }
    // Content audit m13: each vote of the reference price has one seller, so asking for
    // more seller accounts than votes would never show one (0 counts as 1).
    const market = isObj(src.data) ? src.data["market"] : undefined;
    if (isObj(market)) {
      const n = (k: string): number => (typeof market[k] === "number" ? Math.max(market[k], 1) : 1);
      if (n("reference_min_sellers") > n("reference_min_votes"))
        this.error(
          src,
          ["market", "reference_min_sellers"],
          `reference_min_sellers (${n("reference_min_sellers")}) is more than reference_min_votes (${n("reference_min_votes")}): each vote has one seller`,
        );
    }
  }

  private checkVocation(voc: unknown, src: SourceFile, path: PathSegment[]): void {
    const factors = isObj(voc) ? voc["skill_factors"] : undefined;
    if (!isObj(factors)) return;
    for (const s of SKILLS.combat) {
      if (!(s in factors)) this.error(src, [...path, "skill_factors"], `missing skill "${s}"`);
    }
  }

  private checkItem(item: unknown, src: SourceFile, path: PathSegment[]): void {
    if (!isObj(item)) return;
    for (const block of KIND_BLOCKS) {
      if (block in item && item["kind"] !== block) {
        this.error(
          src,
          [...path, block],
          `"${block}" is only allowed on items with kind: ${block}`,
        );
      }
    }
    if ("max_stack" in item && item["stackable"] !== true) {
      this.error(src, [...path, "max_stack"], "max_stack requires stackable: true");
    }
    // An equipable rolls one attribute of its own (docs/02 "Atributos de items"): it is an
    // instance, never part of a pile.
    if (item["stackable"] === true && ["weapon", "armor", "shield"].some((k) => k in item)) {
      this.error(src, [...path, "stackable"], "an equipable (weapon, armor, shield) never stacks");
    }
    const portal = item["portal"];
    if (isObj(portal)) this.checkPortalItem(item, portal, src, [...path, "portal"]);
    const res = item["resource"];
    if (isObj(res)) {
      const chance = res["chance"];
      if (isObj(chance) && Number(chance["base"]) > Number(chance["max"])) {
        this.error(src, [...path, "resource", "chance"], "base is greater than max");
      }
      for (const [i, drop] of asList(res["drops"]).entries()) {
        if (!isObj(drop) || !Array.isArray(drop["count"])) continue;
        const [lo, hi] = drop["count"] as number[];
        if (lo !== undefined && hi !== undefined && lo > hi) {
          this.error(
            src,
            [...path, "resource", "drops", i, "count"],
            `count range [${lo}, ${hi}] is reversed`,
          );
        }
      }
    }
  }

  /**
   * The look of a portal (docs/03 "Validación", same rules as the server reads it): a map
   * item nobody carries off, standing on a tile a player can step onto (every portal
   * entrance is walkable), and a way that fits its kind (a hole only leads down, a rope
   * spot only up).
   */
  private checkPortalItem(item: Obj, portal: Obj, src: SourceFile, path: PathSegment[]): void {
    if (item["pickupable"] !== false)
      this.error(src, path, "a portal item needs pickupable: false (it marks a map tile)");
    if (
      item["blocks_movement"] === true ||
      (item["kind"] === "wall" && item["blocks_movement"] !== false)
    )
      this.error(src, path, "a portal item cannot block movement (a portal entrance is walkable)");
    const kind = portal["kind"];
    const leads = portal["leads"];
    if ((kind === "hole" && leads === "up") || (kind === "rope_spot" && leads === "down"))
      this.error(
        src,
        [...path, "leads"],
        kind === "hole" ? "a hole only leads down" : "a rope spot only leads up",
      );
  }

  private checkMonster(src: SourceFile): void {
    const m = src.data;
    if (!isObj(m)) return;
    for (const { atk, path } of monsterAttacks(m)) {
      if (
        typeof atk["min"] === "number" &&
        typeof atk["max"] === "number" &&
        atk["min"] > atk["max"]
      ) {
        this.error(
          src,
          [...path, "min"],
          `min (${atk["min"]}) is greater than max (${atk["max"]})`,
        );
      }
      // A circle around the target reaches the attack's range plus its radius: past
      // MAX_RANGE it would hurt a player who does not know the monster (server
      // content.checkAttack).
      const area = atk["area"];
      if (isObj(area) && area["center"] === "target" && typeof area["radius"] === "number") {
        const range = typeof atk["range"] === "number" ? Math.max(atk["range"], 1) : 1;
        const reach = atk["type"] === "melee" ? 1 : range;
        if (reach + area["radius"] > MAX_RANGE) {
          this.error(
            src,
            [...path, "area", "radius"],
            `reach ${reach} + radius ${area["radius"]} of a circle around the target is above ${MAX_RANGE}, what a monster notices`,
          );
        }
      }
    }
    // The remains it leaves: a container that stays on its tile, like creature_remains
    // (an unknown id is checkRefs' to report).
    if (typeof m["corpse"] === "string") {
      const owned = this.index.ids.item.get(m["corpse"]);
      const def = owned ? this.itemDef(owned) : undefined;
      if (def && (def["kind"] !== "container" || def["pickupable"] !== false)) {
        this.error(
          src,
          ["corpse"],
          `item "${m["corpse"]}" must be a container with pickupable: false (the remains stay on the tile)`,
        );
      }
    }
    // The server sorts the phases by below_hp_pct: two at the same one would be one phase.
    const seen = new Set<unknown>();
    for (const [i, phase] of asList(m["phases"]).entries()) {
      const pct = isObj(phase) ? phase["below_hp_pct"] : undefined;
      if (pct === undefined) continue;
      if (seen.has(pct)) {
        this.error(
          src,
          ["phases", i, "below_hp_pct"],
          `another phase is already below ${String(pct)} %`,
        );
      }
      seen.add(pct);
    }
    for (const [i, drop] of asList(m["loot"]).entries()) {
      if (!isObj(drop) || !Array.isArray(drop["count"])) continue;
      const [lo, hi] = drop["count"] as number[];
      if (lo !== undefined && hi !== undefined && lo > hi) {
        this.error(src, ["loot", i, "count"], `count range [${lo}, ${hi}] is reversed`);
      }
      const item = this.index.ids.item.get(String(drop["item"]));
      const def = item ? this.itemDef(item) : undefined;
      if (def && def["stackable"] !== true && hi !== undefined && hi > 1) {
        this.error(
          src,
          ["loot", i, "count"],
          `item "${String(drop["item"])}" is not stackable, so count must be at most 1`,
        );
      }
    }
  }

  /**
   * A monster summons one that summons nothing itself: a chain of summoners would have no
   * bound (the server refuses it too, session checkSummons). Unknown monsters are
   * checkRefs' (x-ref).
   */
  private checkSummons(): void {
    const summoners = new Set<string>();
    for (const src of this.monsters) {
      if (!isObj(src.data)) continue;
      for (const { atk } of monsterAttacks(src.data)) {
        if (atk["type"] === "summon") summoners.add(String(src.data["id"]));
      }
    }
    for (const src of this.monsters) {
      if (!isObj(src.data)) continue;
      for (const { atk, path } of monsterAttacks(src.data)) {
        const summon = atk["summon"];
        if (!isObj(summon)) continue;
        const id = String(summon["monster"]);
        if (summoners.has(id)) {
          this.error(
            src,
            [...path, "summon", "monster"],
            `"${id}" summons monsters itself: a summoned monster cannot summon (no bound)`,
          );
        }
      }
    }
  }

  /**
   * data/borders.yaml (docs/06 "Bordes"): the ladder's grounds are ground items, each once;
   * `over` names lower grounds of the ladder; every fringe and the surf have their twelve
   * piece items, decorations that never block and cannot be picked up, each set its own.
   */
  private checkBorders(src: SourceFile): void {
    if (!isObj(src.data)) return;
    const ground = (path: PathSegment[], id: unknown): void => {
      const owned = this.index.ids.item.get(String(id));
      const def = owned ? this.itemDef(owned) : undefined;
      if (def && def["kind"] !== "ground")
        this.error(src, path, `"${String(id)}" must be a ground item`);
    };
    const prefixes = new Map<string, string>();
    const pieces = (path: PathSegment[], prefix: unknown, owner: string): void => {
      if (typeof prefix !== "string") return;
      const other = prefixes.get(prefix);
      if (other !== undefined) {
        this.error(src, path, `pieces "${prefix}" are already the ones of ${other}`);
        return;
      }
      prefixes.set(prefix, owner);
      const defs = BORDER_PIECES.map((piece) => {
        const id = `${prefix}_${piece}`;
        const owned = this.index.ids.item.get(id);
        return { id, def: owned ? this.itemDef(owned) : undefined };
      });
      if (defs.every((d) => !d.def)) {
        this.error(
          src,
          path,
          `none of the 12 pieces ${prefix}_n ... ${prefix}_inner_sw is an item of data/items`,
        );
        return;
      }
      for (const { id, def } of defs) {
        if (!def) {
          this.error(src, path, `piece "${id}" is not an item of data/items`);
          continue;
        }
        if (def["kind"] !== "decoration" || def["blocks_movement"] === true)
          this.error(src, path, `piece "${id}" must be a decoration that does not block`);
        if (def["pickupable"] !== false)
          this.error(src, path, `piece "${id}" must have pickupable: false`);
      }
    };
    const ladder = asList(src.data["ladder"]);
    const rank = new Map<string, number>();
    for (const [i, step] of ladder.entries()) {
      if (!isObj(step)) continue;
      const g = String(step["ground"]);
      ground(["ladder", i, "ground"], g);
      if (rank.has(g)) this.error(src, ["ladder", i, "ground"], `"${g}" is already on the ladder`);
      else rank.set(g, i);
    }
    for (const [i, step] of ladder.entries()) {
      if (!isObj(step)) continue;
      const g = String(step["ground"]);
      if (step["pieces"] === undefined) {
        for (const key of ["edge", "over"])
          if (step[key] !== undefined)
            this.error(src, ["ladder", i, key], `${key} needs pieces (the ground's fringe)`);
        continue;
      }
      pieces(["ladder", i, "pieces"], step["pieces"], `the fringe of "${g}"`);
      for (const [j, lower] of asList(step["over"]).entries()) {
        const r = rank.get(String(lower));
        if (r === undefined)
          this.error(src, ["ladder", i, "over", j], `"${String(lower)}" is not on the ladder`);
        else if (r >= i)
          this.error(src, ["ladder", i, "over", j], `"${String(lower)}" is not below "${g}"`);
      }
    }
    const shore = src.data["shore"];
    if (!isObj(shore)) return;
    for (const [j, w] of asList(shore["water"]).entries()) {
      ground(["shore", "water", j], w);
      const step = ladder[rank.get(String(w)) ?? -1];
      if (!rank.has(String(w)))
        this.error(src, ["shore", "water", j], `"${String(w)}" is not on the ladder`);
      else if (isObj(step) && step["pieces"] !== undefined)
        this.error(src, ["shore", "water", j], `water "${String(w)}" cannot have a fringe`);
    }
    pieces(["shore", "pieces"], shore["pieces"], "the surf");
  }

  private itemDef(owned: Owned): Obj | undefined {
    const list = owned.src.data;
    const at = owned.path[0];
    const v = Array.isArray(list) && typeof at === "number" ? (list[at] as unknown) : undefined;
    return isObj(v) ? v : undefined;
  }

  // ---- cross-file rules ------------------------------------------------------

  private checkRefs(): void {
    for (const ref of this.index.refs) {
      const known = this.index.ids[ref.kind];
      if (known.has(ref.value)) continue;
      const hint = suggest(ref.value, known.keys());
      this.error(
        ref.src,
        ref.path,
        `unknown ${ref.kind} "${ref.value}"${hint ? ` (did you mean "${hint}"?)` : ""}`,
      );
    }
  }

  /**
   * Doors and keys (docs/02 "Puertas con llave", same rules as content.CheckDoors in Go):
   * a door pairs with another door that points back, the closed one blocks movement and the
   * open one does not, neither can be picked up, only the closed one is locked, every lock
   * has a key, every key can be picked up (a player carries it) and no door is a key.
   * Unknown pairs are checkRefs' to report. Where doors stand is map-format's.
   */
  private checkDoors(): void {
    const byId = new Map<string, Obj>();
    const keys = new Set<string>();
    for (const { item } of this.items) {
      const id = idOf(item);
      if (id !== undefined && !byId.has(id)) byId.set(id, item);
      if (typeof item["key"] === "string") keys.add(item["key"]);
    }
    const blocks = (it: Obj): boolean =>
      it["blocks_movement"] === true || (it["kind"] === "wall" && it["blocks_movement"] !== false);
    for (const { item, src, path } of this.items) {
      if (typeof item["key"] === "string" && item["pickupable"] === false)
        this.error(src, [...path, "key"], "a key needs to be pickupable (a player carries it)");
      const door = item["door"];
      if (!isObj(door)) continue;
      const id = idOf(item) ?? "";
      if ("key" in item) this.error(src, [...path, "key"], "a door cannot be a key");
      if (item["pickupable"] !== false)
        this.error(src, [...path, "door"], "a door needs pickupable: false");
      const lock = door["key"];
      const open = door["open"];
      const closed = door["closed"];
      if (typeof closed === "string") {
        const pair = byId.get(closed);
        const back = pair && isObj(pair["door"]) ? pair["door"]["open"] : undefined;
        if (lock !== undefined)
          this.error(src, [...path, "door", "key"], "only the closed door of a pair has a key");
        if (pair && back !== id)
          this.error(
            src,
            [...path, "door", "closed"],
            `"${closed}" is not a closed door that opens into "${id}"`,
          );
        if (blocks(item)) this.error(src, [...path, "door"], "an open door cannot block movement");
      } else if (typeof open === "string") {
        const pair = byId.get(open);
        const back = pair && isObj(pair["door"]) ? pair["door"]["closed"] : undefined;
        if (pair && back !== id)
          this.error(
            src,
            [...path, "door", "open"],
            `"${open}" is not an open door that closes into "${id}"`,
          );
        if (!blocks(item))
          this.error(src, [...path, "door"], "a closed door needs blocks_movement: true");
        if (typeof lock === "string" && !keys.has(lock))
          this.error(
            src,
            [...path, "door", "key"],
            `no item has key "${lock}", so nothing opens this door`,
          );
      }
    }
  }

  private checkDialogs(): void {
    for (const src of this.npcs) {
      const dialog = isObj(src.data) ? src.data["dialog"] : undefined;
      if (!isObj(dialog) || !isObj(dialog["nodes"])) continue;
      const nodes = dialog["nodes"];
      const names = Object.keys(nodes);
      const reached = new Set<string>();
      const target = (name: unknown, path: PathSegment[]): void => {
        if (typeof name !== "string") return;
        if (name in nodes) {
          reached.add(name);
          return;
        }
        const hint = suggest(name, names);
        this.error(
          src,
          path,
          `unknown dialog node "${name}"${hint ? ` (did you mean "${hint}"?)` : ""}`,
        );
      };
      target(dialog["start"], ["dialog", "start"]);
      for (const [name, node] of Object.entries(nodes)) {
        if (!isObj(node)) continue;
        for (const [i, opt] of asList(node["options"]).entries()) {
          if (isObj(opt)) target(opt["goto"], ["dialog", "nodes", name, "options", i, "goto"]);
        }
      }
      for (const name of names) {
        if (!reached.has(name))
          this.warn(src, ["dialog", "nodes", name], `dialog node "${name}" is never reached`);
      }
    }
  }

  /** Quest step and dialog node references inside actions, conditions and completions. */
  private checkQuestSteps(): void {
    const stepsOf = (questId: string): string[] | undefined => {
      const owned = this.index.ids.quest.get(questId);
      if (!owned || !isObj(owned.src.data)) return undefined;
      return asList(owned.src.data["steps"])
        .map(idOf)
        .filter((s) => s !== undefined);
    };
    for (const src of this.quests) {
      const seen = new Set<string>();
      for (const [i, step] of asList(isObj(src.data) ? src.data["steps"] : undefined).entries()) {
        const id = idOf(step);
        if (id === undefined) continue;
        if (seen.has(id)) this.error(src, ["steps", i, "id"], `duplicate step id "${id}"`);
        seen.add(id);
      }
    }
    const visit = (src: SourceFile, value: unknown, path: PathSegment[]): void => {
      if (Array.isArray(value)) {
        value.forEach((v, i) => visit(src, v, [...path, i]));
        return;
      }
      if (!isObj(value)) return;
      for (const [key, inner] of Object.entries(value)) {
        const here = [...path, key];
        const isStepRef = key === "set_quest_step" || key === "quest_state";
        if (
          isStepRef &&
          isObj(inner) &&
          typeof inner["quest"] === "string" &&
          typeof inner["step"] === "string"
        ) {
          const steps = stepsOf(inner["quest"]);
          if (steps && !steps.includes(inner["step"])) {
            this.error(
              src,
              [...here, "step"],
              `quest "${inner["quest"]}" has no step "${inner["step"]}"`,
            );
          }
        }
        if (key === "quest_state" && isObj(inner)) this.checkQuestState(src, inner, here);
        if (key === "quest_not_started" && typeof inner === "string")
          this.warnNotStartedTask(src, here, inner);
        if (key === "dialog_action" && isObj(inner) && typeof inner["npc"] === "string") {
          const npc = this.index.ids.npc.get(inner["npc"]);
          const dialog = npc && isObj(npc.src.data) ? npc.src.data["dialog"] : undefined;
          const nodes = isObj(dialog) && isObj(dialog["nodes"]) ? dialog["nodes"] : undefined;
          if (nodes && typeof inner["node"] === "string" && !(inner["node"] in nodes)) {
            this.error(
              src,
              [...here, "node"],
              `npc "${inner["npc"]}" has no dialog node "${inner["node"]}"`,
            );
          }
        }
        visit(src, inner, here);
      }
    };
    for (const src of [...this.npcs, ...this.quests]) visit(src, src.data, []);
  }

  /**
   * A quest_state condition that means something (docs/06 "NPC", as the server's CheckRefs):
   * a step only with state in_progress (available and cooling_down would ignore it, the
   * others never hold), and cooling_down only of a repeatable quest (no other cools down).
   */
  private checkQuestState(src: SourceFile, cond: Obj, path: PathSegment[]): void {
    const state = cond["state"];
    if (state === "not_started" && typeof cond["quest"] === "string")
      this.warnNotStartedTask(src, [...path, "state"], cond["quest"]);
    if (typeof cond["step"] === "string" && typeof state === "string" && state !== "in_progress")
      this.error(
        src,
        [...path, "step"],
        `quest_state: a step only goes with state in_progress, not ${state}`,
      );
    const quest = typeof cond["quest"] === "string" ? cond["quest"] : undefined;
    const owned = quest === undefined ? undefined : this.index.ids.quest.get(quest);
    if (
      state === "cooling_down" &&
      owned &&
      isObj(owned.src.data) &&
      !isObj(owned.src.data["repeatable"])
    )
      this.error(
        src,
        [...path, "state"],
        `quest_state: cooling_down of quest "${quest}", which is not repeatable (it never cools down)`,
      );
  }

  /**
   * A warning for quest_not_started (or quest_state not_started) of a repeatable quest: it
   * holds only before the first turn; a task is offered with quest_state available (docs/06
   * "Quests repetibles"; the server logs the same, content.RefWarnings).
   */
  private warnNotStartedTask(src: SourceFile, path: PathSegment[], quest: string): void {
    const owned = this.index.ids.quest.get(quest);
    if (owned && isObj(owned.src.data) && isObj(owned.src.data["repeatable"]))
      this.warn(
        src,
        path,
        `not_started of repeatable quest "${quest}" holds only before its first turn; offer it with quest_state available`,
      );
  }

  /** The NPCs whose dialog starts quest (a start_quest action). */
  private giversOf(quest: string): Set<string> {
    const out = new Set<string>();
    for (const src of this.npcs) {
      const id = idOf(src.data);
      const dialog = isObj(src.data) ? src.data["dialog"] : undefined;
      const nodes = isObj(dialog) && isObj(dialog["nodes"]) ? dialog["nodes"] : {};
      for (const n of Object.values(nodes))
        for (const opt of isObj(n) ? asList(n["options"]) : []) {
          const action = isObj(opt) ? opt["action"] : undefined;
          for (const a of Array.isArray(action) ? action : [action])
            if (id !== undefined && isObj(a) && a["start_quest"] === quest) out.add(id);
        }
    }
    return out;
  }

  /**
   * The steps of a repeatable quest that would let a turn be done, and paid, with no effort
   * (docs/06 "Quests repetibles"; the server's content.CheckRepeatable refuses the same):
   * a has_item not followed by its delivery (a dialog_action step whose node every option
   * leading there reaches taking at least that many, deliveryTakes); a flag_equals on a key
   * and value its own rewards set; and, among the steps that may hold the moment it starts
   * (its first ones while they are flag_equals), a dialog_action with an NPC that gives it,
   * or a reach whose place comes within talk range (TALK_RANGE, same floor) of where such an
   * NPC stands (with world/: the NPCs of the islands that are not dev_only).
   */
  private checkRepeatable(): void {
    const islands = this.productionIslands();
    const when = (step: unknown): Obj | undefined =>
      isObj(step) && isObj(step["complete_when"]) ? step["complete_when"] : undefined;
    for (const src of this.quests) {
      if (!isObj(src.data) || !isObj(src.data["repeatable"])) continue;
      const quest = idOf(src.data) ?? "";
      const steps = asList(src.data["steps"]);
      const rewards = asList(src.data["rewards"]);
      for (const [i, step] of steps.entries()) {
        const c = when(step);
        const has = c?.["has_item"];
        if (isObj(has) && typeof has["item"] === "string") {
          const d = when(steps[i + 1])?.["dialog_action"];
          const n = countOf(has);
          if (!isObj(d) || !this.deliveryTakes(d["npc"], d["node"], has["item"], n))
            this.error(
              src,
              ["steps", i, "complete_when", "has_item"],
              `a repeatable quest's has_item must be followed by its delivery, a dialog_action step whose node every option leading there reaches with take_item of ${n} "${has["item"]}", or the same items would do it every turn`,
            );
        }
        const flag = c?.["flag_equals"];
        const own = (r: unknown): boolean => {
          const set = isObj(r) ? r["set_flag"] : undefined;
          return (
            isObj(set) &&
            isObj(flag) &&
            set["key"] === flag["key"] &&
            (set["value"] ?? 0) === (flag["value"] ?? 0)
          );
        };
        if (isObj(flag) && rewards.some(own))
          this.error(
            src,
            ["steps", i, "complete_when", "flag_equals"],
            `flag_equals ${String(flag["key"])} = ${String(flag["value"] ?? 0)}, which the quest's own rewards set: from its second turn on the step would hold at once`,
          );
      }
      const givers = this.giversOf(quest);
      for (const [i, step] of steps.entries()) {
        const c = when(step);
        if (isObj(c?.["flag_equals"])) continue; // it may hold already
        const d = c?.["dialog_action"];
        if (isObj(d) && typeof d["npc"] === "string" && givers.has(d["npc"]))
          this.error(
            src,
            ["steps", i, "complete_when", "dialog_action"],
            `a repeatable quest cannot start with a dialog_action of npc "${d["npc"]}", which gives it: talking on would complete the turn right where it is taken`,
          );
        const reach = c?.["reach"];
        const by = isObj(reach) && islands ? this.giverNear(reach, givers, islands) : undefined;
        if (by !== undefined)
          this.error(
            src,
            ["steps", i, "complete_when", "reach"],
            `a repeatable quest cannot start with a reach whose place comes within talk range of npc "${by}", which gives it: taking it there would complete the turn`,
          );
        break;
      }
    }
  }

  /** The first of givers that stands within TALK_RANGE of a tile of reach's place, if any. */
  private giverNear(
    reach: Obj,
    givers: Set<string>,
    islands: ProductionIsland[],
  ): string | undefined {
    const at = islands.flatMap((is) => is.npcs).filter((n) => givers.has(n.npc));
    if (at.length === 0) return undefined;
    const { zone, x, y, z } = reach;
    let tiles: Iterable<Tile> | undefined;
    if (typeof zone === "string")
      tiles = islands.map((is) => is.zones.get(zone)).find((t) => t !== undefined);
    else if (typeof x === "number" && typeof y === "number" && typeof z === "number")
      tiles = square(x, y, z, typeof reach["radius"] === "number" ? reach["radius"] : 0);
    for (const [tx, ty, tz] of tiles ?? [])
      for (const { npc, at: pos } of at)
        if (tz === pos[2] && Math.max(Math.abs(tx - pos[0]), Math.abs(ty - pos[1])) <= TALK_RANGE)
          return npc;
    return undefined;
  }

  /**
   * The place of every reach step (docs/06 "Quest") is on the production map, as the server
   * checks when it starts (initReach): a zone of the zones.yaml of an island that is not
   * dev_only, or a point inside such an island's rect (world/world.yaml) on a floor its
   * island.yaml lists; and either has a tile that is no entrance of stairs, a hole or a
   * teleport (portals.yaml): a step onto one counts where it lands, nobody stands there.
   * Not checked without world/ (tests).
   */
  private checkQuestReach(): void {
    const islands = this.productionIslands();
    if (!islands) return;
    const entrances = new Set(islands.flatMap((is) => [...is.entrances]));
    // Stops at the first tile that is no entrance: a place of open ground answers at once.
    const someStandable = (tiles: Iterable<Tile>): boolean => {
      for (const [x, y, z] of tiles) if (!entrances.has(`${x},${y},${z}`)) return true;
      return false;
    };
    for (const src of this.quests) {
      const steps = asList(isObj(src.data) ? src.data["steps"] : undefined);
      for (const [i, step] of steps.entries()) {
        const when = isObj(step) ? step["complete_when"] : undefined;
        const reach = isObj(when) ? when["reach"] : undefined;
        if (!isObj(reach)) continue;
        const path = ["steps", i, "complete_when", "reach"];
        const zone = reach["zone"];
        if (typeof zone === "string") {
          const tiles = islands.map((is) => is.zones.get(zone)).find((t) => t !== undefined);
          if (!tiles)
            this.error(
              src,
              [...path, "zone"],
              `reach zone "${zone}" is no zone of an island that is not dev_only (world/islands/*/zones.yaml)`,
            );
          else if (!someStandable(tiles))
            this.error(
              src,
              [...path, "zone"],
              `every tile of reach zone "${zone}" is the entrance of stairs, a hole or a teleport (portals.yaml), where nobody stands`,
            );
          continue;
        }
        const { x, y, z } = reach;
        if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") continue;
        const on = islands.some(
          (is) =>
            x >= is.x && y >= is.y && x < is.x + is.w && y < is.y + is.h && is.floors.includes(z),
        );
        if (!on) {
          this.error(
            src,
            path,
            `reach point ${x},${y},${z} is on no island that is not dev_only (its rect in world/world.yaml and its floors in island.yaml)`,
          );
          continue;
        }
        const r = typeof reach["radius"] === "number" ? reach["radius"] : 0;
        if (!someStandable(square(x, y, z, r)))
          this.error(
            src,
            path,
            `every tile of reach point ${x},${y},${z} radius ${r} is the entrance of stairs, a hole or a teleport (portals.yaml), where nobody stands`,
          );
      }
    }
  }

  /** productionIslands, read once: null before the first read. */
  private islandsRead: ProductionIsland[] | undefined | null = null;

  /**
   * The islands of world/world.yaml that are not dev_only: rect, floors, zones, the
   * entrances of their stairs, holes and teleports and their NPCs (ProductionIsland);
   * undefined without world/.
   */
  private productionIslands(): ProductionIsland[] | undefined {
    if (this.islandsRead === null) this.islandsRead = this.readProductionIslands();
    return this.islandsRead;
  }

  private readProductionIslands(): ProductionIsland[] | undefined {
    const worldFile = join(this.root, "world", "world.yaml");
    if (!existsSync(worldFile)) return undefined;
    const diags: Diagnostic[] = [];
    const w = parseYaml(readFileSync(worldFile, "utf8"), "world/world.yaml", diags);
    const out: ProductionIsland[] = [];
    for (const entry of w && isObj(w.data) ? asList(w.data["islands"]) : []) {
      const island = idOf(entry);
      if (island === undefined || !/^[a-z0-9_]+$/.test(island) || !isObj(entry)) continue;
      if (entry["dev_only"] === true) continue;
      const rect = isObj(entry["rect"]) ? entry["rect"] : {};
      const num = (v: unknown): number => (typeof v === "number" ? v : 0);
      const dir = `world/islands/${island}`;
      const read = (name: string): unknown => {
        const abs = join(this.root, dir, name);
        return existsSync(abs)
          ? parseYaml(readFileSync(abs, "utf8"), `${dir}/${name}`, diags)?.data
          : undefined;
      };
      const meta = read("island.yaml");
      const floors = asList(isObj(meta) ? meta["floors"] : undefined).filter(
        (f): f is number => typeof f === "number",
      );
      const zones = new Map<string, Iterable<Tile>>();
      for (const zone of asList(read("zones.yaml"))) {
        const id = idOf(zone);
        if (id === undefined || !isObj(zone)) continue;
        const zFloors = asList(zone["floors"]).filter((f): f is number => typeof f === "number");
        const rects = asList(zone["rects"]).filter(isObj);
        zones.set(id, {
          *[Symbol.iterator](): Generator<Tile> {
            for (const f of zFloors)
              for (const r of rects)
                for (let y = num(r["y"]); y < num(r["y"]) + num(r["h"]); y++)
                  for (let x = num(r["x"]); x < num(r["x"]) + num(r["w"]); x++) yield [x, y, f];
          },
        });
      }
      const entrances = new Set<string>();
      for (const p of asList(read("portals.yaml"))) {
        if (!isObj(p) || !STEP_PORTALS.includes(String(p["kind"]))) continue;
        const from = p["from"];
        if (isObj(from)) entrances.add(`${num(from["x"])},${num(from["y"])},${num(from["z"])}`);
      }
      const npcs: ProductionIsland["npcs"] = [];
      for (const n of asList(read("npcs.yaml"))) {
        const at = isObj(n) ? n["pos"] : undefined;
        if (isObj(n) && typeof n["npc"] === "string" && isObj(at))
          npcs.push({ npc: n["npc"], at: [num(at["x"]), num(at["y"]), num(at["z"])] });
      }
      out.push({
        x: num(rect["x"]),
        y: num(rect["y"]),
        w: num(rect["w"]),
        h: num(rect["h"]),
        floors,
        zones,
        entrances,
        npcs,
      });
    }
    return out;
  }

  /**
   * Rules on dialog actions across all NPCs: an NPC only opens its own shop, the blessings
   * sold fit in balance.yaml death.max_blessings, and every quest has a way to start.
   */
  private checkNpcActions(): void {
    const blessings = new Map<string, { src: SourceFile; path: PathSegment[] }>();
    const started = new Set<string>();
    for (const src of this.npcs) {
      const npc = isObj(src.data) ? src.data : undefined;
      const ownShop = npc ? idOf(npc["shop"]) : undefined;
      // Content audit M6 (review): a blessing's price grows with the level, so an option
      // that also gives experience would charge at another level than its {price} shows.
      const options = new Map<string, { keys: Set<string>; path: PathSegment[] }>();
      for (const { key, path } of actionsOf(npc?.["dialog"], ["dialog"])) {
        const at = path.slice(0, path.indexOf("action") + 1);
        const o = options.get(at.join("/")) ?? { keys: new Set<string>(), path: at };
        o.keys.add(key);
        options.set(at.join("/"), o);
      }
      for (const o of options.values())
        if (o.keys.has("bless") && o.keys.has("give_xp"))
          this.error(
            src,
            o.path,
            "bless and give_xp cannot go in one option: the blessing's price follows the level",
          );
      for (const { key, value, path } of actionsOf(npc?.["dialog"], ["dialog"])) {
        if (key === "open_shop" && typeof value === "string" && value !== ownShop) {
          const owner = this.index.ids.shop.get(value);
          if (owner) {
            this.error(
              src,
              path,
              `opens shop "${value}" of ${owner.src.file}; an NPC can only open its own shop${ownShop ? ` ("${ownShop}")` : ""}`,
            );
          }
        }
        if (key === "bless" && isObj(value) && typeof value["blessing"] === "string") {
          if (!blessings.has(value["blessing"])) blessings.set(value["blessing"], { src, path });
        }
        if (key === "start_quest" && typeof value === "string") started.add(value);
      }
    }

    const death = isObj(this.balance?.data) ? this.balance.data["death"] : undefined;
    const max = isObj(death) ? death["max_blessings"] : undefined;
    if (typeof max === "number" && blessings.size > max) {
      const [, extra] = [...blessings.entries()][max] ?? [];
      if (extra) {
        this.error(
          extra.src,
          [...extra.path, "blessing"],
          `${blessings.size} different blessings are sold, but balance.yaml death.max_blessings is ${max} (${[...blessings.keys()].join(", ")})`,
        );
      }
    }

    for (const src of this.quests) {
      const id = idOf(src.data);
      if (id !== undefined && !started.has(id)) {
        this.warn(
          src,
          ["id"],
          `quest "${id}" is never started (no start_quest action in data/npcs/)`,
        );
      }
    }
  }

  /**
   * Dev-only dialog actions (DEV_ONLY_ACTIONS), or an NPC marked dev_only (every action of
   * it is dev-only): such an NPC must be placed (world/islands/<id>/npcs.yaml), and only on
   * dev_only islands of world/world.yaml, which the production image leaves out. The
   * server refuses the same when it starts and again when an option is picked.
   */
  private checkDevOnlyActions(): void {
    const placed = this.npcPlacements();
    if (!placed) return; // no world/ (tests): the placements are unknown
    for (const src of this.npcs) {
      const npc = isObj(src.data) ? src.data : undefined;
      const id = idOf(npc);
      const used =
        npc?.["dev_only"] === true
          ? { what: "dev_only NPC (every action of it is dev-only)", path: ["dev_only"] }
          : actionsOf(npc?.["dialog"], ["dialog"])
              .filter((a) => DEV_ONLY_ACTIONS.includes(a.key))
              .map((a) => ({ what: `dev-only action "${a.key}"`, path: a.path }))[0];
      if (!used || id === undefined) continue;
      const at = placed.get(id) ?? [];
      if (at.length === 0)
        this.error(
          src,
          used.path,
          `${used.what}: NPC "${id}" is placed on no dev_only island (world/world.yaml); only the sandbox island may have it`,
        );
      for (const p of at.filter((p) => !p.dev))
        this.error(
          src,
          used.path,
          `${used.what}: NPC "${id}" stands on island "${p.island}", which is not dev_only (world/world.yaml); only the sandbox island may have it`,
        );
    }
  }

  /**
   * The islands each NPC is placed on (world/islands/<id>/npcs.yaml) and whether they are
   * dev_only (world/world.yaml), or undefined when there is no world/ (tests).
   */
  private npcPlacements(): Map<string, { island: string; dev: boolean }[]> | undefined {
    const worldFile = join(this.root, "world", "world.yaml");
    if (!existsSync(worldFile)) return undefined;
    const out = new Map<string, { island: string; dev: boolean }[]>();
    const diags: Diagnostic[] = [];
    const w = parseYaml(readFileSync(worldFile, "utf8"), "world/world.yaml", diags);
    for (const entry of w && isObj(w.data) ? asList(w.data["islands"]) : []) {
      const island = idOf(entry);
      if (island === undefined || !/^[a-z0-9_]+$/.test(island)) continue;
      const dev = isObj(entry) && entry["dev_only"] === true;
      const rel = `world/islands/${island}/npcs.yaml`;
      const abs = join(this.root, rel);
      if (!existsSync(abs)) continue;
      const list = parseYaml(readFileSync(abs, "utf8"), rel, diags);
      for (const n of list ? asList(list.data) : []) {
        const npc = isObj(n) ? n["npc"] : undefined;
        if (typeof npc !== "string") continue;
        out.set(npc, [...(out.get(npc) ?? []), { island, dev }]);
      }
    }
    return out;
  }

  /**
   * NPCs buy cheap (docs/02-game-design.md): no shop may buy an item for as much as any shop
   * sells it (an endless gold loop), and a buy price above the item's value is suspicious.
   */
  private checkShopPrices(): void {
    interface Offer {
      price: number;
      src: SourceFile;
      path: PathSegment[];
      shop: string;
    }
    const sells = new Map<string, Offer>();
    const buys: (Offer & { item: string })[] = [];
    for (const src of this.npcs) {
      const shop = isObj(src.data) ? src.data["shop"] : undefined;
      if (!isObj(shop)) continue;
      const shopId = idOf(shop) ?? "?";
      for (const side of ["sells", "buys"] as const) {
        for (const [i, offer] of asList(shop[side]).entries()) {
          if (!isObj(offer) || typeof offer["item"] !== "string") continue;
          if (typeof offer["price"] !== "number") continue;
          const o = { price: offer["price"], src, path: ["shop", side, i], shop: shopId };
          if (side === "buys") {
            buys.push({ ...o, item: offer["item"] });
          } else {
            const prev = sells.get(offer["item"]);
            if (!prev || o.price < prev.price) sells.set(offer["item"], o);
          }
        }
      }
    }
    for (const b of buys) {
      const s = sells.get(b.item);
      if (s && b.price >= s.price) {
        this.error(
          b.src,
          [...b.path, "price"],
          `shop "${b.shop}" buys "${b.item}" for ${b.price} but shop "${s.shop}" sells it for ${s.price}: buy prices must be lower than every sell price`,
        );
      }
      const owned = this.index.ids.item.get(b.item);
      const value = owned ? this.itemDef(owned)?.["value"] : undefined;
      if (typeof value === "number" && b.price > value) {
        this.warn(
          b.src,
          [...b.path, "price"],
          `shop "${b.shop}" buys "${b.item}" for ${b.price}, above its value ${value}; NPCs should buy cheap`,
        );
      }
    }
  }

  /**
   * A quest step that waits for an item (has_item) needs a way to get it: monster loot, a
   * shop that sells it, a dialog give_item or another quest's reward. Whether that source
   * fits the quest's level is checked by the balance tests, which know monster levels.
   */
  private checkQuestItemSources(): void {
    const sources = new Set<string>();
    for (const src of this.monsters) {
      const loot = isObj(src.data) ? asList(src.data["loot"]) : [];
      for (const drop of loot)
        if (isObj(drop) && typeof drop["item"] === "string") sources.add(drop["item"]);
    }
    for (const src of this.npcs) {
      const npc = isObj(src.data) ? src.data : undefined;
      const shop = npc?.["shop"];
      for (const offer of isObj(shop) ? asList(shop["sells"]) : []) {
        if (isObj(offer) && typeof offer["item"] === "string") sources.add(offer["item"]);
      }
      for (const { key, value } of actionsOf(npc?.["dialog"], ["dialog"])) {
        if (key === "give_item" && typeof value === "string") sources.add(value);
      }
    }
    for (const src of this.quests) {
      const rewards = isObj(src.data) ? asList(src.data["rewards"]) : [];
      for (const r of rewards)
        if (isObj(r) && typeof r["item"] === "string") sources.add(r["item"]);
    }
    for (const src of this.quests) {
      const steps = isObj(src.data) ? asList(src.data["steps"]) : [];
      for (const [i, step] of steps.entries()) {
        const when = isObj(step) ? step["complete_when"] : undefined;
        const need = isObj(when) ? when["has_item"] : undefined;
        if (!isObj(need) || typeof need["item"] !== "string") continue;
        if (!this.index.ids.item.has(need["item"]) || sources.has(need["item"])) continue;
        this.error(
          src,
          ["steps", i, "complete_when", "has_item", "item"],
          `no way to obtain "${need["item"]}": no monster drops it, no shop sells it and no give_item or quest reward gives it`,
        );
      }
    }
  }

  /**
   * Content audit m1: a tool a player can get in production (sold or given by an NPC placed
   * on an island that is not dev_only, dropped by a monster, crafted or a quest reward) needs
   * something to be used on in the production map: a placed resource of its kind (fishing,
   * mining, woodcutting), a placed station of a recipe that asks for it (smithing), or a
   * rope_spot portal (rope). Any other use (the shovel) has nothing in the world yet. Not
   * checked without world/ (tests).
   */
  private checkToolTargets(): void {
    const world = this.productionWorld();
    if (!world) return;
    const got = new Set<string>();
    const placed = this.npcPlacements() ?? new Map<string, { island: string; dev: boolean }[]>();
    for (const src of this.npcs) {
      const npc = isObj(src.data) ? src.data : undefined;
      const id = typeof npc?.["id"] === "string" ? npc["id"] : "";
      if (!(placed.get(id) ?? []).some((p) => !p.dev)) continue;
      const shop = npc?.["shop"];
      for (const offer of isObj(shop) ? asList(shop["sells"]) : [])
        if (isObj(offer) && typeof offer["item"] === "string") got.add(offer["item"]);
      for (const { key, value } of actionsOf(npc?.["dialog"], ["dialog"]))
        if (key === "give_item" && typeof value === "string") got.add(value);
    }
    for (const src of this.monsters)
      for (const drop of isObj(src.data) ? asList(src.data["loot"]) : [])
        if (isObj(drop) && typeof drop["item"] === "string") got.add(drop["item"]);
    for (const src of this.quests)
      for (const r of isObj(src.data) ? asList(src.data["rewards"]) : [])
        if (isObj(r) && typeof r["item"] === "string") got.add(r["item"]);
    const recipes = this.recipes ? asList(this.recipes.data).filter(isObj) : [];
    for (const r of recipes) {
      const out = r["output"];
      if (isObj(out) && typeof out["item"] === "string") got.add(out["item"]);
    }
    // What each use can be used on in production.
    const targets = new Map<string, boolean>();
    for (const { item } of this.items) {
      const res = item["resource"];
      if (isObj(res) && typeof res["tool"] === "string" && typeof item["id"] === "string")
        if (world.placed.has(item["id"])) targets.set(res["tool"], true);
    }
    for (const r of recipes)
      if (typeof r["tool"] === "string" && typeof r["station"] === "string")
        if (world.placed.has(r["station"])) targets.set(r["tool"], true);
    if (world.portalKinds.has("rope_spot")) targets.set("rope", true);
    for (const { item, src, path } of this.items) {
      const tool = item["tool"];
      const id = item["id"];
      if (!isObj(tool) || typeof tool["use"] !== "string" || typeof id !== "string") continue;
      if (!got.has(id) || targets.get(tool["use"])) continue;
      this.error(
        src,
        [...path, "tool", "use"],
        `tool "${id}" can be had in production (a shop, a dialog, loot, a recipe or a reward) but nothing in the production map takes tool.use "${tool["use"]}" (a placed resource or station, or a rope_spot portal for rope): give it a target or no production source`,
      );
    }
  }

  /** The forge's temper stones and protection (balance.yaml forge), when it is on. */
  private forgeMaterials(): string[] {
    const forge = isObj(this.balance?.data) ? this.balance.data["forge"] : undefined;
    if (!isObj(forge) || forge["enabled"] !== true) return [];
    const out: string[] = [];
    if (typeof forge["protection"] === "string") out.push(forge["protection"]);
    for (const b of asList(forge["bands"]))
      if (isObj(b) && typeof b["stone"] === "string") out.push(b["stone"]);
    return out;
  }

  /**
   * The forge (docs/02 "Forja", same rules as content.Forge.CheckItems in Go): its station is
   * an item nobody picks up; its stones and protection are stackable materials (counted and
   * spent by units); the protection is rare, so no NPC of a production island sells it or
   * gives it (checked with world/ only, where NPCs placed only on dev_only islands do not
   * count: the sandbox merchant sells it); every band's stone and the protection have a way
   * to be had in production (a shop or loot).
   */
  private checkForge(): void {
    const src = this.balance;
    const forge = isObj(src?.data) ? src.data["forge"] : undefined;
    if (!src || !isObj(forge) || forge["enabled"] !== true) return;
    const byId = new Map<string, Obj>();
    for (const { item } of this.items) {
      const id = idOf(item);
      if (id !== undefined) byId.set(id, item);
    }
    const station = typeof forge["station"] === "string" ? byId.get(forge["station"]) : undefined;
    if (station && station["pickupable"] !== false)
      this.error(
        src,
        ["forge", "station"],
        `the forge's station "${String(forge["station"])}" needs pickupable: false`,
      );
    const materials = (): { id: string; path: PathSegment[] }[] => {
      const out: { id: string; path: PathSegment[] }[] = [];
      if (typeof forge["protection"] === "string")
        out.push({ id: forge["protection"], path: ["forge", "protection"] });
      for (const [i, b] of asList(forge["bands"]).entries())
        if (isObj(b) && typeof b["stone"] === "string")
          out.push({ id: b["stone"], path: ["forge", "bands", i, "stone"] });
      return out;
    };
    for (const { id, path } of materials()) {
      const it = byId.get(id);
      if (it && (it["kind"] !== "material" || it["stackable"] !== true))
        this.error(src, path, `the forge's "${id}" must be a stackable material (spent by units)`);
    }
    const placed = this.npcPlacements();
    const prodNpc = (id: string): boolean => !placed || (placed.get(id) ?? []).some((p) => !p.dev);
    const sold = new Set<string>();
    const protection = typeof forge["protection"] === "string" ? forge["protection"] : "";
    for (const npcSrc of this.npcs) {
      const npc = isObj(npcSrc.data) ? npcSrc.data : undefined;
      const id = typeof npc?.["id"] === "string" ? npc["id"] : "";
      if (!prodNpc(id)) continue;
      const shop = npc?.["shop"];
      for (const [i, o] of (isObj(shop) ? asList(shop["sells"]) : []).entries()) {
        if (!isObj(o) || typeof o["item"] !== "string") continue;
        sold.add(o["item"]);
        if (placed && o["item"] === protection)
          this.error(
            npcSrc,
            ["shop", "sells", i, "item"],
            `"${protection}" is the forge's rare protection: no NPC sells it (only the boss and strong monsters drop it)`,
          );
      }
      for (const { key, value, path } of actionsOf(npc?.["dialog"], ["dialog"]))
        if (placed && key === "give_item" && value === protection)
          this.error(
            npcSrc,
            path,
            `"${protection}" is the forge's rare protection: no NPC gives it`,
          );
    }
    const dropped = new Set<string>();
    for (const m of this.monsters)
      for (const drop of isObj(m.data) ? asList(m.data["loot"]) : [])
        if (isObj(drop) && typeof drop["item"] === "string") dropped.add(drop["item"]);
    for (const { id, path } of materials())
      if (byId.has(id) && !sold.has(id) && !dropped.has(id))
        this.error(
          src,
          path,
          `nothing gives the forge's "${id}" in production: a smith that sells it or a monster that drops it`,
        );
  }

  /**
   * Milestone quests (docs/02 "Quests de hito"), the rules the schema cannot say (the
   * server's content.ParseQuest says the same): requires and title go with milestone: true
   * and it with them; a milestone is not repeatable and its last step, only that one, is a
   * sigils step; requires.vocations lists one per player; gear.equipped goes with an item.
   * A sigil plate is a map item nobody picks up that blocks nothing. The plates themselves
   * are mapcli validate's (packages/map-format, checkSigils).
   */
  private checkMilestones(): void {
    for (const src of this.quests) {
      const q = src.data;
      if (!isObj(q)) continue;
      const steps = asList(q["steps"]);
      const sigils = steps.flatMap((s, i) =>
        isObj(s) && isObj(s["complete_when"]) && isObj(s["complete_when"]["sigils"]) ? [i] : [],
      );
      const req = q["requires"];
      if (q["milestone"] !== true) {
        if (req !== undefined || q["title"] !== undefined)
          this.error(src, [], "requires and title belong to a milestone quest (milestone: true)");
        for (const i of sigils)
          this.error(
            src,
            ["steps", i, "complete_when", "sigils"],
            "a sigils step belongs to a milestone quest (milestone: true)",
          );
        continue;
      }
      if (!isObj(req)) this.error(src, [], "a milestone needs requires");
      if (typeof q["title"] !== "string") this.error(src, [], "a milestone needs a title");
      if (q["repeatable"] !== undefined)
        this.error(src, ["repeatable"], "a milestone is done once: it cannot be repeatable");
      if (sigils.length !== 1 || sigils[0] !== steps.length - 1)
        this.error(src, ["steps"], "a milestone needs exactly one sigils step, its last");
      if (!isObj(req)) continue;
      const vocations = asList(req["vocations"]);
      if (req["vocations"] !== undefined && vocations.length !== req["players"])
        this.error(
          src,
          ["requires", "vocations"],
          "requires.vocations lists one vocation per player (as many as requires.players)",
        );
    }
    for (const { item, src, path } of this.items) {
      if (!isObj(item["sigil"])) continue;
      if (item["pickupable"] !== false || item["blocks_movement"] === true)
        this.error(
          src,
          [...path, "sigil"],
          `sigil plate "${String(item["id"])}" needs pickupable: false and must not block movement (a player stands on it)`,
        );
    }
  }

  /**
   * Reward chests (docs/02 "Libros y cofres", same rules as content.CheckChests in Go): a
   * chest is a map item nobody picks up, its chest id is unique, and each reward can go in a
   * backpack (not pickupable: false, like a wall, a lectern or another chest), comes in a
   * count from 1 to one stack of its item (1 if it does not stack) and is never the forge's
   * protection (the warding amber: only monsters drop it). That a reward exists is the
   * schema's itemRef; that it is not retired, checkRetiredItems'.
   */
  private checkChests(): void {
    const byId = new Map<string, Obj>();
    for (const { item } of this.items) {
      const id = idOf(item);
      if (id !== undefined) byId.set(id, item);
    }
    const forge = isObj(this.balance?.data) ? this.balance.data["forge"] : undefined;
    const protection =
      isObj(forge) && forge["enabled"] === true && typeof forge["protection"] === "string"
        ? forge["protection"]
        : "";
    const seen = new Map<string, string>();
    for (const { item, src, path } of this.items) {
      const chest = item["chest"];
      if (!isObj(chest)) continue;
      const id = String(item["id"]);
      if (item["pickupable"] !== false)
        this.error(src, [...path, "chest"], `chest "${id}" needs pickupable: false (a map item)`);
      const cid = chest["id"];
      if (typeof cid === "string") {
        const other = seen.get(cid);
        if (other !== undefined)
          this.error(
            src,
            [...path, "chest", "id"],
            `chest id "${cid}" is also the one of "${other}"`,
          );
        else seen.set(cid, id);
      }
      for (const r of chestRewards(item)) {
        const at: PathSegment[] = [...path, "chest", "rewards", r.index];
        if (protection !== "" && r.item === protection)
          this.error(
            src,
            [...at, "item"],
            `"${protection}" is the forge's rare protection: no chest gives it (only monsters drop it)`,
          );
        const def = byId.get(r.item);
        if (!def) continue;
        if (def["pickupable"] === false)
          this.error(
            src,
            [...at, "item"],
            `"${r.item}" cannot be picked up (pickupable: false): a chest only gives what goes in a backpack`,
          );
        const limit =
          def["stackable"] === true
            ? typeof def["max_stack"] === "number"
              ? def["max_stack"]
              : 100
            : 1;
        if (r.count > limit)
          this.error(
            src,
            [...at, "count"],
            `${r.count} "${r.item}" do not make one stack (at most ${limit}): a chest gives one stack per reward`,
          );
      }
    }
  }

  /**
   * Content audit m4: items that lead nowhere. With world/, only NPCs placed on an island
   * that is not dev_only count (without it, tests, every NPC):
   * - an item an NPC buys needs a way to get it (monster loot, a resource's drops, a recipe,
   *   a shop, a dialog give_item, a quest or tutorial reward, a conjuring spell or a reward
   *   chest);
   * - a weapon, armor or shield that can be had, is tradeable and has a value needs an NPC
   *   that buys it (no dead weight in the backpack); a material, an NPC buyer, a recipe or a
   *   quest or dialog that takes it;
   * - a quest item (not tradeable, the has_item of a quest step) drops from monsters only as
   *   each_player loot: as plain loot it keeps dropping as junk after the quest.
   */
  private checkItemTrade(): void {
    const placed = this.npcPlacements();
    const prodNpc = (id: string): boolean => !placed || (placed.get(id) ?? []).some((p) => !p.dev);
    const got = new Set<string>();
    const bought = new Map<string, { src: SourceFile; path: PathSegment[] }>();
    const used = new Set<string>();
    for (const src of this.monsters)
      for (const drop of isObj(src.data) ? asList(src.data["loot"]) : [])
        if (isObj(drop) && typeof drop["item"] === "string") got.add(drop["item"]);
    for (const { item } of this.items) {
      const res = item["resource"];
      for (const d of isObj(res) ? asList(res["drops"]) : [])
        if (isObj(d) && typeof d["item"] === "string") got.add(d["item"]);
      for (const r of chestRewards(item)) got.add(r.item);
    }
    for (const r of this.recipes ? asList(this.recipes.data).filter(isObj) : []) {
      const out = r["output"];
      if (isObj(out) && typeof out["item"] === "string") got.add(out["item"]);
      for (const i of asList(r["inputs"]))
        if (isObj(i) && typeof i["item"] === "string") used.add(i["item"]);
    }
    for (const sp of this.spells ? asList(this.spells.data).filter(isObj) : []) {
      const effect = sp["effect"];
      const conj = isObj(effect) ? effect["conjure"] : undefined;
      if (isObj(conj) && typeof conj["item"] === "string") got.add(conj["item"]);
    }
    for (const r of this.tutorialRewards()) got.add(r.item);
    const questItems = new Set<string>();
    for (const src of this.quests) {
      const q = isObj(src.data) ? src.data : undefined;
      for (const r of asList(q?.["rewards"]))
        if (isObj(r) && typeof r["item"] === "string") got.add(r["item"]);
      for (const step of asList(q?.["steps"])) {
        const when = isObj(step) ? step["complete_when"] : undefined;
        const need = isObj(when) ? when["has_item"] : undefined;
        if (isObj(need) && typeof need["item"] === "string") {
          used.add(need["item"]);
          questItems.add(need["item"]);
        }
      }
    }
    for (const src of this.npcs) {
      const npc = isObj(src.data) ? src.data : undefined;
      if (!prodNpc(typeof npc?.["id"] === "string" ? npc["id"] : "")) continue;
      const shop = npc?.["shop"];
      for (const o of isObj(shop) ? asList(shop["sells"]) : [])
        if (isObj(o) && typeof o["item"] === "string") got.add(o["item"]);
      for (const [i, o] of (isObj(shop) ? asList(shop["buys"]) : []).entries())
        if (isObj(o) && typeof o["item"] === "string" && !bought.has(o["item"]))
          bought.set(o["item"], { src, path: ["shop", "buys", i, "item"] });
      for (const { key, value } of actionsOf(npc?.["dialog"], ["dialog"])) {
        if (key === "give_item" && typeof value === "string") got.add(value);
        if (key === "take_item" && isObj(value) && typeof value["item"] === "string")
          used.add(value["item"]);
      }
    }
    const retired = new Set(
      this.items.filter(({ item }) => item["retired"] === true).map(({ item }) => item["id"]),
    );
    // The forge (balance.yaml forge, docs/02 "Forja") spends its stones and protection.
    for (const id of this.forgeMaterials()) used.add(id);
    for (const [id, at] of bought)
      // A retired item (lote 11) has no source on purpose: its buyer is for old copies.
      if (this.index.ids.item.has(id) && !got.has(id) && !retired.has(id))
        this.error(
          at.src,
          at.path,
          `an NPC buys "${id}" but nothing gives it in the game (loot, a resource, a recipe, a shop, a dialog, a quest or tutorial reward, a spell or a chest)`,
        );
    for (const { item, src, path } of this.items) {
      const id = item["id"];
      const kind = item["kind"];
      const value = item["value"];
      if (typeof id !== "string" || !got.has(id) || item["tradeable"] !== true) continue;
      if (typeof value !== "number" || value <= 0 || bought.has(id)) continue;
      if (kind === "weapon" || kind === "armor" || kind === "shield")
        this.error(
          src,
          [...path, "value"],
          `"${id}" (${kind}) can be had and has a value, but no NPC buys it: add a buyer (a third of its value or less)`,
        );
      else if (kind === "material" && !used.has(id))
        this.error(
          src,
          [...path, "value"],
          `material "${id}" can be had and has a value, but no NPC buys it and no recipe, quest or the forge takes it`,
        );
    }
    const untradeable = new Set(
      this.items.filter(({ item }) => item["tradeable"] === false).map(({ item }) => item["id"]),
    );
    for (const src of this.monsters)
      for (const [i, drop] of (isObj(src.data) ? asList(src.data["loot"]) : []).entries()) {
        if (!isObj(drop) || typeof drop["item"] !== "string" || drop["each_player"] === true)
          continue;
        if (questItems.has(drop["item"]) && untradeable.has(drop["item"]))
          this.error(
            src,
            ["loot", i, "item"],
            `quest item "${drop["item"]}" drops as plain loot: make it each_player (only players whose quest needs it get one), or it keeps dropping as junk after the quest`,
          );
      }
  }

  /**
   * Lote 11 (compact catalog, docs/06 "Item"): a retired item stays defined so the
   * characters that own one keep it, but nothing gives a new one: no shop sells it (dev-only
   * NPCs included), no monster or resource drops it, no recipe makes it, no dialog gives it,
   * no quest or tutorial rewards it, no spell conjures it and no character starts with it.
   * An NPC may still buy it (checkItemTrade lets that buyer be).
   */
  private checkRetiredItems(): void {
    const retired = new Set(
      this.items.filter(({ item }) => item["retired"] === true).map(({ item }) => item["id"]),
    );
    if (retired.size === 0) return;
    const refuse = (src: SourceFile, path: PathSegment[], id: unknown, how: string): void => {
      if (typeof id === "string" && retired.has(id))
        this.error(src, path, `"${id}" is retired (retired: true): ${how}`);
    };
    for (const src of this.monsters)
      for (const [i, drop] of (isObj(src.data) ? asList(src.data["loot"]) : []).entries())
        if (isObj(drop)) refuse(src, ["loot", i, "item"], drop["item"], "no monster drops it");
    for (const { item, src, path } of this.items) {
      const res = item["resource"];
      for (const [i, d] of (isObj(res) ? asList(res["drops"]) : []).entries())
        if (isObj(d))
          refuse(src, [...path, "resource", "drops", i, "item"], d["item"], "no resource drops it");
      for (const r of chestRewards(item))
        refuse(src, [...path, "chest", "rewards", r.index, "item"], r.item, "no chest gives it");
    }
    if (this.recipes)
      for (const [i, r] of asList(this.recipes.data).entries()) {
        const out = isObj(r) ? r["output"] : undefined;
        if (isObj(out))
          refuse(this.recipes, [i, "output", "item"], out["item"], "no recipe makes it");
      }
    if (this.spells)
      for (const [i, sp] of asList(this.spells.data).entries()) {
        const effect = isObj(sp) ? sp["effect"] : undefined;
        const conj = isObj(effect) ? effect["conjure"] : undefined;
        if (isObj(conj))
          refuse(
            this.spells,
            [i, "effect", "conjure", "item"],
            conj["item"],
            "no spell conjures it",
          );
      }
    for (const src of this.quests)
      for (const [i, r] of (isObj(src.data) ? asList(src.data["rewards"]) : []).entries())
        if (isObj(r)) refuse(src, ["rewards", i, "item"], r["item"], "no quest rewards it");
    if (this.tutorial)
      for (const r of this.tutorialRewards())
        refuse(this.tutorial, ["rewards", r.index, "item"], r.item, "no tutorial rewards it");
    for (const src of this.npcs) {
      const npc = isObj(src.data) ? src.data : undefined;
      const shop = npc?.["shop"];
      for (const [i, o] of (isObj(shop) ? asList(shop["sells"]) : []).entries())
        if (isObj(o)) refuse(src, ["shop", "sells", i, "item"], o["item"], "no shop sells it");
      for (const { key, value, path } of actionsOf(npc?.["dialog"], ["dialog"]))
        if (key === "give_item") refuse(src, path, value, "no dialog gives it");
    }
    const balance = this.balance;
    const inv = balance && isObj(balance.data) ? balance.data["inventory"] : undefined;
    if (balance && isObj(inv))
      refuse(
        balance,
        ["inventory", "start_container"],
        inv["start_container"],
        "no character starts with it",
      );
  }

  /** The items data/tutorial.yaml gives when its last step completes (rewards: { item }). */
  private tutorialRewards(): { item: string; index: number }[] {
    const t = this.tutorial && isObj(this.tutorial.data) ? this.tutorial.data : undefined;
    const out: { item: string; index: number }[] = [];
    for (const [index, r] of asList(t?.["rewards"]).entries())
      if (isObj(r) && typeof r["item"] === "string") out.push({ item: r["item"], index });
    return out;
  }

  /**
   * Lote 11 (compact catalog, docs/02 "Catálogo de equipo"): every weapon, armor piece and
   * shield states the level it asks for (requires.level), the band it belongs to; the item
   * attributes roll by it.
   */
  private checkEquipLevels(): void {
    for (const { item, src, path } of this.items) {
      const kind = item["kind"];
      if (kind !== "weapon" && kind !== "armor" && kind !== "shield") continue;
      const req = item["requires"];
      if (isObj(req) && typeof req["level"] === "number") continue;
      this.error(
        src,
        [...path, "requires"],
        `${String(kind)} "${String(item["id"])}" has no requires.level: every weapon, armor and shield states its level (docs/02 "Catálogo de equipo")`,
      );
    }
  }

  /**
   * Content audit m9, the rules the server's startup also checks (session.checkQuestDrop):
   * a quest drop (loot each_player) is worth nothing and cannot be traded (tradeable:
   * false, value: 0); it is the has_item of some quest step; and the step right after each
   * such step is its delivery, a dialog_action step whose node is not where that NPC's
   * dialog starts and that every option leading there (goto, one at least) reaches while
   * taking the item (take_item). A player gets another while the has_item step, or its
   * delivery, is current: a step in between would leave a lost one without a source, and a
   * way into the delivery that does not take it would leave one to show again.
   */
  private checkQuestDrops(): void {
    const items = new Map(this.items.map(({ item }) => [item["id"], item]));
    const when = (step: unknown): Obj | undefined =>
      isObj(step) && isObj(step["complete_when"]) ? step["complete_when"] : undefined;
    for (const src of this.monsters)
      for (const [i, drop] of (isObj(src.data) ? asList(src.data["loot"]) : []).entries()) {
        if (!isObj(drop) || drop["each_player"] !== true || typeof drop["item"] !== "string")
          continue;
        const id = drop["item"];
        const at: PathSegment[] = ["loot", i, "item"];
        const item = items.get(id);
        const value = item?.["value"];
        if (item && (item["tradeable"] === true || (typeof value === "number" && value !== 0)))
          this.error(src, at, `quest drop "${id}" needs tradeable: false and value: 0`);
        let asked = false;
        for (const q of this.quests) {
          const quest = idOf(q.data) ?? q.file;
          const steps = isObj(q.data) ? asList(q.data["steps"]) : [];
          for (const [k, step] of steps.entries()) {
            const need = when(step)?.["has_item"];
            if (!isObj(need) || need["item"] !== id) continue;
            asked = true;
            const deliver = when(steps[k + 1])?.["dialog_action"];
            if (!isObj(deliver)) {
              this.error(
                src,
                at,
                `quest "${quest}" step "${idOf(step) ?? k}": the has_item of quest drop "${id}" must be followed by its delivery (a dialog_action step), or a lost one would never come back`,
              );
              continue;
            }
            if (!this.deliveryTakes(deliver["npc"], deliver["node"], id))
              this.error(
                src,
                at,
                `quest "${quest}" step "${idOf(steps[k + 1]) ?? k + 1}": its delivery must take quest drop "${id}": every option of npc "${String(deliver["npc"])}" that leads to node "${String(deliver["node"])}" (one at least) needs take_item of it, and the node cannot be where the dialog starts`,
              );
          }
        }
        if (!asked)
          this.error(
            src,
            at,
            `quest drop "${id}" is the has_item of no quest step: it would never drop`,
          );
      }
  }

  /**
   * Whether node of NPC npc's dialog is a delivery of `units` of item
   * (content.DeliveryTakes): not where the dialog starts, and every option that leads there
   * (goto, one at least) takes at least that many of the item (take_item, count 1 when unset).
   */
  private deliveryTakes(npc: unknown, node: unknown, item: string, units = 1): boolean {
    const owned = typeof npc === "string" ? this.index.ids.npc.get(npc) : undefined;
    const dialog = owned && isObj(owned.src.data) ? owned.src.data["dialog"] : undefined;
    if (!isObj(dialog) || dialog["start"] === node) return false;
    const nodes = isObj(dialog["nodes"]) ? dialog["nodes"] : {};
    let leads = false;
    for (const n of Object.values(nodes))
      for (const opt of isObj(n) ? asList(n["options"]) : []) {
        if (!isObj(opt) || opt["goto"] !== node) continue;
        leads = true;
        const action = opt["action"];
        const takes = (Array.isArray(action) ? action : [action]).some((a) => {
          const take = isObj(a) ? a["take_item"] : undefined;
          return isObj(take) && take["item"] === item && countOf(take) >= units;
        });
        if (!takes) return false;
      }
    return leads;
  }

  /**
   * What the islands of world/world.yaml that are not dev_only hold: the ids of their chunk
   * palettes (grounds and items) and the kinds of their portals; undefined without world/.
   */
  private productionWorld(): { placed: Set<string>; portalKinds: Set<string> } | undefined {
    const worldFile = join(this.root, "world", "world.yaml");
    if (!existsSync(worldFile)) return undefined;
    const diags: Diagnostic[] = [];
    const w = parseYaml(readFileSync(worldFile, "utf8"), "world/world.yaml", diags);
    const placed = new Set<string>();
    const portalKinds = new Set<string>();
    for (const entry of w && isObj(w.data) ? asList(w.data["islands"]) : []) {
      const island = idOf(entry);
      if (island === undefined || !/^[a-z0-9_]+$/.test(island)) continue;
      if (isObj(entry) && entry["dev_only"] === true) continue;
      const dir = join(this.root, "world", "islands", island);
      const portals = join(dir, "portals.yaml");
      if (existsSync(portals)) {
        const list = parseYaml(
          readFileSync(portals, "utf8"),
          `world/islands/${island}/portals.yaml`,
          diags,
        );
        for (const p of list ? asList(list.data) : [])
          if (isObj(p) && typeof p["kind"] === "string") portalKinds.add(p["kind"]);
      }
      const chunks = join(dir, "chunks");
      if (!existsSync(chunks)) continue;
      for (const floor of readdirSync(chunks)) {
        const fdir = join(chunks, floor);
        if (!statSync(fdir).isDirectory()) continue;
        for (const name of readdirSync(fdir)) {
          if (!name.endsWith(".json")) continue;
          try {
            const chunk: unknown = JSON.parse(readFileSync(join(fdir, name), "utf8"));
            for (const id of isObj(chunk) ? asList(chunk["palette"]) : [])
              if (typeof id === "string") placed.add(id);
          } catch {
            // A broken chunk is the map validator's finding (make validate runs it next).
          }
        }
      }
    }
    return { placed, portalKinds };
  }

  private checkI18n(): void {
    const i18nDir = join(this.root, "i18n");
    const catalogs = new Map<string, Map<string, { src: SourceFile; text: string }>>();
    for (const lang of LANGUAGES) {
      const dir = join(i18nDir, lang);
      const keys = new Map<string, { src: SourceFile; text: string }>();
      catalogs.set(lang, keys);
      if (!existsSync(dir)) {
        this.error(`i18n/${lang}`, [], "language directory is missing");
        continue;
      }
      for (const entry of readdirSync(dir).sort()) {
        const rel = `i18n/${lang}/${entry}`;
        if (!entry.endsWith(".yaml")) {
          this.error(rel, [], "expected only .yaml files here");
          continue;
        }
        const src = this.load(join(dir, entry), rel, "i18n");
        if (!src || !isObj(src.data)) continue;
        for (const [key, text] of Object.entries(src.data)) {
          if (typeof text !== "string") continue;
          const prev = keys.get(key);
          if (prev) this.error(src, [key], `key also defined in ${prev.src.file}`);
          else keys.set(key, { src, text });
        }
      }
    }
    if (existsSync(i18nDir)) {
      for (const entry of readdirSync(i18nDir)) {
        if (!(LANGUAGES as readonly string[]).includes(entry)) {
          this.warn(
            `i18n/${entry}`,
            [],
            `not a configured language (${LANGUAGES.join(", ")}); it is not checked`,
          );
        }
      }
    }

    // Same keys and same {placeholders} in every language, and in the same file.
    const [first, ...others] = LANGUAGES;
    const reference = catalogs.get(first) ?? new Map();
    for (const lang of others) {
      const cat = catalogs.get(lang) ?? new Map();
      for (const [key, ref] of reference) {
        const other = cat.get(key);
        if (!other) {
          this.error(
            ref.src,
            [key],
            `missing in ${lang} (expected in i18n/${lang}/${fileName(ref.src)})`,
          );
          continue;
        }
        if (fileName(other.src) !== fileName(ref.src)) {
          this.error(
            other.src,
            [key],
            `must live in i18n/${lang}/${fileName(ref.src)} like in ${first}`,
          );
        }
        const a = placeholders(ref.text);
        const b = placeholders(other.text);
        if (a !== b) {
          this.error(other.src, [key], `placeholders {${b}} differ from ${first} {${a}}`);
        }
      }
      for (const [key, other] of cat) {
        if (!reference.has(key))
          this.error(
            other.src,
            [key],
            `missing in ${first} (expected in i18n/${first}/${fileName(other.src)})`,
          );
      }
    }

    // Every key referenced from data/ exists in every language.
    const used = new Set<string>();
    for (const k of this.index.i18nKeys) {
      used.add(k.value);
      const missing = LANGUAGES.filter((lang) => !catalogs.get(lang)?.has(k.value));
      if (missing.length > 0) {
        this.error(k.src, k.path, `i18n key "${k.value}" is missing in: ${missing.join(", ")}`);
      }
    }
    this.checkCodeKeys(catalogs);
    // Shared UI keys (dialog.*, ui.*) are used by code, not data; only data-owned prefixes are checked.
    const dataPrefixes = [
      "attribute.",
      "book.",
      "item.",
      "monster.",
      "npc.",
      "quest.",
      "spell.",
      "vocation.",
      "cosmetic.",
      "cosmetic_pack.",
    ];
    for (const [key, entry] of reference) {
      if (!used.has(key) && dataPrefixes.some((p) => key.startsWith(p))) {
        this.warn(entry.src, [key], `i18n key "${key}" is not used by any file in data/`);
      }
    }
  }

  /**
   * Every i18n key the code uses as a literal exists in every language: string
   * literals of the server's Go (the msg* constants it sends as Message.localized) and
   * of the client and editor TypeScript (t("...") and key tables). A literal counts as
   * a key when it looks like one (dotted, lower case) and its first segment is a
   * namespace of the catalogs (client., chat., combat.), so paths and ids are skipped.
   * Keys built at run time (`skill.${id}.name`) are not checked here.
   */
  private checkCodeKeys(catalogs: Map<string, Map<string, unknown>>): void {
    const namespaces = new Set<string>();
    for (const cat of catalogs.values())
      for (const key of cat.keys()) namespaces.add(key.split(".")[0] ?? "");
    const literal = /["'`]([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)["'`]/g;
    for (const { dir, ext } of CODE_DIRS) {
      for (const file of codeFiles(join(this.root, dir), ext)) {
        // Diagnostics use "/" on every platform.
        const rel = relative(this.root, file).split(sep).join("/");
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          for (const m of line.matchAll(literal)) {
            const key = m[1] ?? "";
            if (!namespaces.has(key.split(".")[0] ?? "") || FILE_NAME.test(key)) continue;
            const missing = LANGUAGES.filter((lang) => !catalogs.get(lang)?.has(key));
            if (missing.length > 0)
              this.error(
                `${rel}:${i + 1}`,
                [],
                `i18n key "${key}" is missing in: ${missing.join(", ")}`,
              );
          }
        });
      }
    }
  }

  /**
   * data/livingworld/*.yaml (livingworld/README.md): one entry per item; never a wall, a
   * door or a ground; a breakable, pushable or closed gate blocks movement, its debris, an
   * open gate and a plate do not; sounds exist in assets/sounds.yaml; debris lies at most
   * as long as the respawn. The server's livingworld.Resolve applies the same rules.
   */
  private checkLivingWorld(): void {
    if (this.living.length === 0) return;
    const items = new Map<string, Obj>();
    for (const { item } of this.items)
      if (typeof item["id"] === "string") items.set(item["id"], item);
    const blocks = (it: Obj): boolean =>
      it["blocks_movement"] === true || (it["kind"] === "wall" && it["blocks_movement"] !== false);
    const soundsAbs = join(this.root, "assets", "sounds.yaml");
    const soundsSrc = existsSync(soundsAbs)
      ? parseYaml(readFileSync(soundsAbs, "utf8"), "assets/sounds.yaml", [])
      : undefined;
    const sounds =
      soundsSrc && isObj(soundsSrc.data) && isObj(soundsSrc.data["sounds"])
        ? new Set(Object.keys(soundsSrc.data["sounds"]))
        : undefined;
    const seen = new Map<string, string>();
    for (const src of this.living) {
      for (const [i, e] of asList(src.data).entries()) {
        if (!isObj(e) || typeof e["item"] !== "string") continue;
        const id = e["item"];
        const first = seen.get(id);
        if (first !== undefined)
          this.error(src, [i, "item"], `item "${id}" already has an entry (${first})`);
        else seen.set(id, `${src.file} entry ${i}`);
        const structure = (path: PathSegment[], ref: string): void => {
          const it = items.get(ref);
          if (!it) return; // an unknown id is checkRefs' error
          if (it["kind"] === "wall")
            this.error(src, path, `"${ref}" is a wall: walls never break nor move`);
          else if (isObj(it["door"]))
            this.error(src, path, `"${ref}" is a door: doors never break nor move`);
          else if (it["kind"] === "ground") this.error(src, path, `"${ref}" is a ground`);
        };
        structure([i, "item"], id);
        const it = items.get(id);
        const mustBlock = (what: string): void => {
          if (it && !blocks(it))
            this.error(src, [i, "item"], `a ${what} must block movement (blocks_movement: true)`);
        };
        const walkable = (path: PathSegment[], ref: unknown, what: string): void => {
          if (typeof ref !== "string") return;
          structure(path, ref);
          const alt = items.get(ref);
          if (alt && blocks(alt)) this.error(src, path, `${what} "${ref}" must not block movement`);
        };
        const sound = (path: PathSegment[], v: unknown): void => {
          if (typeof v === "string" && sounds && !sounds.has(v))
            this.error(src, path, `sound "${v}" is not declared in the sounds manifest`);
        };
        const b = e["breakable"];
        if (isObj(b)) {
          mustBlock("breakable object");
          if (b["becomes"] !== "none")
            walkable([i, "breakable", "becomes"], b["becomes"], "debris");
          sound([i, "breakable", "sound"], b["sound"]);
          sound([i, "breakable", "hit_sound"], b["hit_sound"]);
          const debris = typeof b["debris_seconds"] === "number" ? b["debris_seconds"] : 20;
          const respawn = typeof b["respawn_seconds"] === "number" ? b["respawn_seconds"] : 300;
          if (b["becomes"] !== "none" && debris > respawn)
            this.error(src, [i, "breakable", "debris_seconds"], "longer than respawn_seconds");
        }
        const p = e["pushable"];
        if (isObj(p)) {
          mustBlock("pushable object");
          sound([i, "pushable", "sound"], p["sound"]);
        }
        const g = e["gate"];
        if (isObj(g)) {
          mustBlock("closed gate");
          walkable([i, "gate", "open"], g["open"], "the open gate");
          sound([i, "gate", "sound"], g["sound"]);
        }
        if (isObj(e["plate"]) && it && blocks(it))
          this.error(src, [i, "item"], "a pressure plate must not block movement");
      }
    }
  }

  /**
   * assets/sounds.yaml (T3.7, optional): files exist, vendor packs have their CREDITS.md
   * row, events and loops name declared sounds of the right channel, the music's places
   * name declared pools (and an important quest's music too), islands exist, and a
   * track's measures fit in it.
   */
  private checkSounds(): void {
    const abs = join(this.root, "assets", "sounds.yaml");
    if (!existsSync(abs)) return;
    const src = this.load(abs, "assets/sounds.yaml", "sounds");
    if (!src || !isObj(src.data)) return;
    const sounds = isObj(src.data["sounds"]) ? src.data["sounds"] : {};
    const creditsFile = join(this.root, "assets", "CREDITS.md");
    const packs = registeredPacks(existsSync(creditsFile) ? readFileSync(creditsFile, "utf8") : "");
    const unlicensed = new Set<string>();
    for (const [id, s] of Object.entries(sounds)) {
      const file = isObj(s) ? s["file"] : undefined;
      if (typeof file !== "string") continue;
      const where: PathSegment[] = ["sounds", id, "file"];
      const abs = resolve(this.root, "assets", file);
      if (!abs.startsWith(resolve(this.root, "assets") + sep)) {
        this.error(src, where, `assets/${file} is outside assets/`);
        continue;
      }
      if (!existsSync(abs))
        this.error(src, where, `assets/${file} does not exist (run \`make sounds\`)`);
      const pack = /^vendor\/([^/]+)\//.exec(file)?.[1];
      if (!pack) continue;
      if (!packs.has(pack)) {
        this.error(src, where, `pack "${pack}" has no row in assets/CREDITS.md`);
        continue;
      }
      const dir = join(this.root, "assets", "vendor", pack);
      if (unlicensed.has(pack) || !existsSync(dir) || !readdirSync(dir).some(isLicenseFile)) {
        if (!unlicensed.has(pack))
          this.error(
            src,
            where,
            `pack "${pack}" has no LICENSE or COPYING file in assets/vendor/${pack}/`,
          );
        unlicensed.add(pack);
      }
    }
    const channelOf = (id: string): unknown => {
      const s = sounds[id];
      return isObj(s) ? s["channel"] : undefined;
    };
    const ref = (path: PathSegment[], id: unknown, loop?: "music" | "ambient"): void => {
      if (typeof id !== "string") return;
      const ch = channelOf(id);
      if (ch === undefined) this.error(src, path, `unknown sound "${id}"`);
      else if (loop && ch !== loop)
        this.error(src, path, `sound "${id}" is on channel ${String(ch)}, not ${loop}`);
      else if (!loop && (ch === "music" || ch === "ambient"))
        this.error(src, path, `sound "${id}" is a ${ch} loop, not an event sound`);
    };
    const events = isObj(src.data["events"]) ? src.data["events"] : {};
    for (const [ev, v] of Object.entries(events)) {
      if (Array.isArray(v)) v.forEach((id, i) => ref(["events", ev, i], id));
      else ref(["events", ev], v);
    }
    const islands = this.worldIslands();
    // The music: pools of music sounds, and places that name a pool (the director's,
    // client/src/audio/director.ts). The ambient bed names its loops directly.
    const music = isObj(src.data["music"]) ? src.data["music"] : {};
    const pools = isObj(music["pools"]) ? music["pools"] : {};
    for (const [pool, ids] of Object.entries(pools))
      if (Array.isArray(ids)) ids.forEach((id, i) => ref(["music", "pools", pool, i], id, "music"));
    const pool = (path: PathSegment[], id: unknown): void => {
      if (typeof id === "string" && !(id in pools))
        this.error(src, path, `unknown pool "${id}" (music.pools)`);
    };
    for (const loop of ["music", "ambient"] as const) {
      const l = src.data[loop];
      if (!isObj(l)) continue;
      const name = (path: PathSegment[], id: unknown): void =>
        loop === "music" ? pool(path, id) : ref(path, id, "ambient");
      name([loop, "underground"], l["underground"]);
      const by = isObj(l["islands"]) ? l["islands"] : {};
      for (const [island, id] of Object.entries(by)) {
        if (islands && !islands.has(island))
          this.error(
            src,
            [loop, "islands", island],
            `unknown island "${island}" (world/world.yaml)`,
          );
        name([loop, "islands", island], id);
      }
    }
    // Over the zone's: the title screen's pool and each boss's.
    pool(["music", "title"], music["title"]);
    const bosses = isObj(music["bosses"]) ? music["bosses"] : {};
    for (const [monster, id] of Object.entries(bosses)) {
      if (!this.index.ids.monster.has(monster))
        this.error(
          src,
          ["music", "bosses", monster],
          `unknown monster "${monster}" (data/monsters)`,
        );
      pool(["music", "bosses", monster], id);
    }
    const gap = music["gap_ms"];
    if (Array.isArray(gap) && typeof gap[0] === "number" && typeof gap[1] === "number")
      if (gap[0] > gap[1])
        this.error(src, ["music", "gap_ms"], `gap_ms is [min, max]: ${gap[0]} > ${gap[1]}`);
    // A track's measures (make music-gemini): only on music, end within it, entries going
    // up from after 0 to the body's end.
    for (const [id, s] of Object.entries(sounds)) {
      if (!isObj(s) || !["seconds", "end", "entries"].some((k) => k in s)) continue;
      if (s["channel"] !== "music") {
        this.error(src, ["sounds", id], "seconds, end and entries are a music track's");
        continue;
      }
      const seconds = typeof s["seconds"] === "number" ? s["seconds"] : undefined;
      if (seconds === undefined) {
        this.error(src, ["sounds", id], "a track with end or entries needs its seconds");
        continue;
      }
      const end = typeof s["end"] === "number" ? s["end"] : seconds;
      if (end > seconds)
        this.error(src, ["sounds", id, "end"], `end ${end} is past the track's ${seconds} s`);
      const entries = Array.isArray(s["entries"]) ? s["entries"] : [];
      let before = 0;
      entries.forEach((e, i) => {
        if (typeof e !== "number") return;
        if (e > end)
          this.error(
            src,
            ["sounds", id, "entries", i],
            `entry ${e} is past the body's end (${end} s)`,
          );
        else if (e <= before)
          this.error(src, ["sounds", id, "entries", i], "entries go up, after 0");
        before = e;
      });
    }
    // An important quest's music names a pool of this file.
    for (const q of this.quests) {
      const m = isObj(q.data) ? q.data["music"] : undefined;
      if (isObj(m) && typeof m["pool"] === "string" && !(m["pool"] in pools))
        this.error(
          q,
          ["music", "pool"],
          `unknown pool "${m["pool"]}" (assets/sounds.yaml music.pools)`,
        );
    }
  }

  /**
   * data/tutorial.yaml (T4.2): unique step ids, the island exists and craft steps name a
   * recipe of data/recipes.yaml (the other refs are x-ref in the schema).
   */
  private checkTutorial(src: SourceFile, dataDir: string): void {
    if (!isObj(src.data)) return;
    const steps = asList(src.data["steps"]);
    this.checkUniqueIdsOf(src, steps, ["steps"]);
    const island = src.data["island"];
    const islands = this.worldIslands();
    if (typeof island === "string" && islands && !islands.has(island))
      this.error(src, ["island"], `unknown island "${island}" (world/world.yaml)`);
    let recipes: Set<string> | undefined;
    for (const [i, step] of steps.entries()) {
      const when = isObj(step) && isObj(step["when"]) ? step["when"] : undefined;
      if (!when || when["event"] !== "craft" || typeof when["ref"] !== "string") continue;
      if (!recipes) {
        const abs = join(dataDir, "recipes.yaml");
        const diags: Diagnostic[] = [];
        const r = existsSync(abs)
          ? parseYaml(readFileSync(abs, "utf8"), "data/recipes.yaml", diags)
          : undefined;
        recipes = new Set(
          (r ? asList(r.data) : []).map(idOf).filter((id): id is string => id !== undefined),
        );
      }
      if (!recipes.has(when["ref"]))
        this.error(src, ["steps", i, "when", "ref"], `unknown recipe "${when["ref"]}"`);
    }
  }

  private checkUniqueIdsOf(src: SourceFile, list: unknown[], path: PathSegment[]): void {
    const seen = new Set<string>();
    for (const [i, entry] of list.entries()) {
      const id = idOf(entry);
      if (id === undefined) continue;
      if (seen.has(id)) this.error(src, [...path, i, "id"], `duplicate id "${id}"`);
      seen.add(id);
    }
  }

  /** Island ids of world/world.yaml, or undefined when there is no world/ (tests). */
  private worldIslands(): Set<string> | undefined {
    const abs = join(this.root, "world", "world.yaml");
    if (!existsSync(abs)) return undefined;
    const diags: Diagnostic[] = [];
    const w = parseYaml(readFileSync(abs, "utf8"), "world/world.yaml", diags);
    const list = w && isObj(w.data) ? asList(w.data["islands"]) : [];
    return new Set(list.map(idOf).filter((id): id is string => id !== undefined));
  }

  private parseBaseLock(text: string): SourceFile | undefined {
    const diags: Diagnostic[] = [];
    const src = parseYaml(text, "data/ids.lock.yaml@base", diags);
    if (diags.length > 0)
      this.warn(
        "data/ids.lock.yaml",
        [],
        "could not parse the base revision; skipping the append-only check",
      );
    return src;
  }

  // ---- reporting --------------------------------------------------------------

  private error(src: SourceFile | string, path: PathSegment[], message: string): void {
    this.report("error", src, path, message);
  }

  private warn(src: SourceFile | string, path: PathSegment[], message: string): void {
    this.report("warning", src, path, message);
  }

  private report(
    severity: Diagnostic["severity"],
    src: SourceFile | string,
    path: PathSegment[],
    message: string,
  ): void {
    if (typeof src === "string") {
      this.diags.push({ severity, file: src, path, message });
      return;
    }
    const pos = src.locate(path);
    this.diags.push({
      severity,
      file: src.file,
      path,
      message,
      ...(pos ? { line: pos.line, col: pos.col } : {}),
    });
  }
}

/** Every dialog action (key and value) under `value`, including those inside action lists. */
function actionsOf(
  value: unknown,
  path: PathSegment[],
): { key: string; value: unknown; path: PathSegment[] }[] {
  const out: { key: string; value: unknown; path: PathSegment[] }[] = [];
  const nodes = isObj(value) && isObj(value["nodes"]) ? value["nodes"] : {};
  for (const [name, node] of Object.entries(nodes)) {
    const options = isObj(node) ? asList(node["options"]) : [];
    for (const [i, opt] of options.entries()) {
      if (!isObj(opt)) continue;
      const at: PathSegment[] = [...path, "nodes", name, "options", i, "action"];
      const action = opt["action"];
      const list = Array.isArray(action) ? action : [action];
      for (const [j, a] of list.entries()) {
        if (!isObj(a)) continue;
        const here = Array.isArray(action) ? [...at, j] : at;
        for (const [key, inner] of Object.entries(a))
          out.push({ key, value: inner, path: [...here, key] });
      }
    }
  }
  return out;
}

/** Every attack of a monster: its own, then each phase's attacks_add, with its path. */
function monsterAttacks(m: Obj): { atk: Obj; path: PathSegment[] }[] {
  const out: { atk: Obj; path: PathSegment[] }[] = [];
  for (const [i, atk] of asList(m["attacks"]).entries()) {
    if (isObj(atk)) out.push({ atk, path: ["attacks", i] });
  }
  for (const [p, phase] of asList(m["phases"]).entries()) {
    const list = isObj(phase) ? asList(phase["attacks_add"]) : [];
    for (const [i, atk] of list.entries()) {
      if (isObj(atk)) out.push({ atk, path: ["phases", p, "attacks_add", i] });
    }
  }
  return out;
}

function fileName(src: SourceFile): string {
  return src.file.replace(/^.*\//, "");
}

function placeholders(text: string): string {
  return [...new Set([...text.matchAll(/\{([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]))]
    .sort()
    .join(", ");
}
