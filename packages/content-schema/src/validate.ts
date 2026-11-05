// Validates data/ and i18n/ against the JSON Schemas plus the rules a schema cannot
// express: unique IDs, cross references, dialog graphs, translations and ids.lock.yaml.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isLicenseFile, registeredPacks } from "./credits.ts";
import { checkIdsLock } from "./ids.ts";
import { SchemaSet } from "./schemas.ts";
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
const idOf = (v: unknown): string | undefined =>
  isObj(v) && typeof v["id"] === "string" ? v["id"] : undefined;

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
  private balance: SourceFile | undefined;

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
    this.checkDialogs();
    this.checkQuestSteps();
    this.checkNpcActions();
    this.checkShopPrices();
    this.checkQuestItemSources();
    this.checkI18n();
    this.checkSounds();
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
      for (const d of checkIdsLock(lock, [...this.index.ids.item.keys()], base)) this.diags.push(d);
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

    for (const [file, schema] of [
      ["recipes.yaml", "recipes"],
      ["boat_routes.yaml", "boat_routes"],
      ["borders.yaml", "borders"],
    ] as const) {
      const src = single(file, schema, false);
      if (!src) continue;
      this.checkUniqueIds(src);
      if (schema === "borders") this.checkBorders(src);
    }

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

  private checkUniqueIds(src: SourceFile): void {
    const seen = new Set<string>();
    for (const [i, entry] of asList(src.data).entries()) {
      const id = idOf(entry);
      if (id === undefined) continue;
      if (seen.has(id)) this.error(src, [i, "id"], `duplicate id "${id}"`);
      seen.add(id);
    }
  }

  // ---- per-type rules --------------------------------------------------------

  private checkBalance(src: SourceFile): void {
    const skills =
      isObj(src.data) && isObj(src.data["skills"]) ? src.data["skills"]["base"] : undefined;
    if (!isObj(skills)) return;
    for (const s of [...SKILLS.combat, ...SKILLS.craft]) {
      if (!(s in skills)) this.error(src, ["skills", "base"], `missing skill "${s}"`);
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

  private checkMonster(src: SourceFile): void {
    const m = src.data;
    if (!isObj(m)) return;
    for (const [i, atk] of asList(m["attacks"]).entries()) {
      if (
        isObj(atk) &&
        typeof atk["min"] === "number" &&
        typeof atk["max"] === "number" &&
        atk["min"] > atk["max"]
      ) {
        this.error(
          src,
          ["attacks", i, "min"],
          `min (${atk["min"]}) is greater than max (${atk["max"]})`,
        );
      }
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

  private checkBorders(src: SourceFile): void {
    for (const [i, rule] of asList(src.data).entries()) {
      if (!isObj(rule)) continue;
      for (const side of ["from", "to"]) {
        const owned = this.index.ids.item.get(String(rule[side]));
        const def = owned ? this.itemDef(owned) : undefined;
        if (def && def["kind"] !== "ground") {
          this.error(src, [i, side], `"${String(rule[side])}" must be a ground item`);
        }
      }
    }
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
   * Rules on dialog actions across all NPCs: an NPC only opens its own shop, the blessings
   * sold fit in balance.yaml death.max_blessings, and every quest has a way to start.
   */
  private checkNpcActions(): void {
    const blessings = new Map<string, { src: SourceFile; path: PathSegment[] }>();
    const started = new Set<string>();
    for (const src of this.npcs) {
      const npc = isObj(src.data) ? src.data : undefined;
      const ownShop = npc ? idOf(npc["shop"]) : undefined;
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
    const dataPrefixes = ["item.", "monster.", "npc.", "quest.", "spell.", "vocation."];
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
        const rel = file.slice(this.root.length + 1);
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
   * assets/sounds.yaml (T3.7, optional): files exist, vendor packs have their CREDITS.md
   * row, events and loops name declared sounds of the right channel, islands exist.
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
    for (const loop of ["music", "ambient"] as const) {
      const l = src.data[loop];
      if (!isObj(l)) continue;
      ref([loop, "underground"], l["underground"], loop);
      const by = isObj(l["islands"]) ? l["islands"] : {};
      for (const [island, id] of Object.entries(by)) {
        if (islands && !islands.has(island))
          this.error(
            src,
            [loop, "islands", island],
            `unknown island "${island}" (world/world.yaml)`,
          );
        ref([loop, "islands", island], id, loop);
      }
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

function fileName(src: SourceFile): string {
  return src.file.replace(/^.*\//, "");
}

function placeholders(text: string): string {
  return [...new Set([...text.matchAll(/\{([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]))]
    .sort()
    .join(", ");
}
