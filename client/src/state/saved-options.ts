// Saved options (owner decision 2026-11-26: "everything the player picks is saved").
//
// OPTIONS is the registry: every option or toggle the player can choose is listed here and
// says where it is kept (saved-options.test.ts fails for a localStorage key or a Set*
// message of the protocol that is not declared):
// - "character": a game option of the character, kept by the game server (the Welcome
//   gives it back, docs/05 "Opciones guardadas");
// - "account": an interface option, kept in the account's options document on the server
//   (GET/POST /api/account/options, docs/05 "Opciones de la cuenta") so it follows the
//   player to another browser or device;
// - "device-class": the same document, but one value per kind of screen ("desktop" or
//   "touch"): pixels, zoom and the on-screen pad do not carry from a monitor to a phone;
// - "session": on purpose not saved (with the reason).
// localStorage stays as the cache every screen reads at once (and all there is before the
// login). At login the server wins and the local values fill what the server lacks
// (mergeDocs), except what this browser changed and could not send yet (the tab closed
// before the save, the server did not answer): those keys are marked in localStorage
// and the local value wins for them. Afterwards each change is sent a moment later
// (OptionsSync), and at once when the page goes away.
//
// The registry holds what is kept in localStorage or set with a Set* message of the
// protocol: the guard test sees those two. A switch that travels in another message, or
// a choice that only lives in a screen's state, has to be added by hand (as "session"
// with its reason when it is not saved).
//
// The server validates the document with a closed schema (server/internal/accountopts);
// the codecs below only ever build values it accepts, and what comes back is checked
// again before it reaches localStorage. Nothing in it is ever rendered as markup.

export type Persistence = "character" | "account" | "device-class" | "session";

/** How one localStorage value maps to its field of the document. */
interface Codec {
  /** The document value of a stored string; undefined = not saved (junk or unset). */
  read(raw: string): unknown;
  /** The string to store for a document value; undefined = junk, leave the key alone. */
  write(value: unknown): string | undefined;
}

export interface OptionDef {
  id: string;
  persistence: Persistence;
  /** The localStorage key (the cache), or its prefix when `keyed`. */
  storageKey?: string;
  /** One key per vocation: `<storageKey><name>`, a map in the document. */
  keyed?: boolean;
  /** Field of the document (of its device section for "device-class"). */
  field?: string;
  codec?: Codec;
  /** The protocol message that sets a "character" option. */
  message?: string;
  /** Why a "session" entry is not saved. */
  reason?: string;
  /**
   * Says something about the account's characters (their names, their spells): never
   * filled from what another account left in this browser.
   */
  personal?: boolean;
}

/** The saved keys this browser changed and the server has not confirmed (a JSON list). */
export const UNSENT_KEY = "rpg.optsUnsent";
/** The tag of the account the cached options belong to (GET /api/account/options). */
export const OWNER_KEY = "rpg.optsOwner";

const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const NAME = /^[\p{L} '-]{1,32}$/u;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** "on"/"off" style switches: `on` is the stored word of true. */
const flag = (on: string, off: string): Codec => ({
  read: (raw) => (raw === on ? true : raw === off ? false : undefined),
  write: (v) => (typeof v === "boolean" ? (v ? on : off) : undefined),
});

const oneOf = (allowed: readonly string[]): Codec => ({
  read: (raw) => (allowed.includes(raw) ? raw : undefined),
  write: (v) => (typeof v === "string" && allowed.includes(v) ? v : undefined),
});

const numberIn = (lo: number, hi: number, integer: boolean): Codec => {
  const ok = (v: unknown): v is number =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= lo &&
    v <= hi &&
    (!integer || Number.isInteger(v));
  return {
    read: (raw) => {
      const v = raw.trim() === "" ? NaN : Number(raw);
      return ok(v) ? v : undefined;
    },
    write: (v) => (ok(v) ? String(v) : undefined),
  };
};

const CHANNELS = ["master", "music", "sfx", "ui", "ambient"] as const;

/** rpg.audio: { volume: {channel: 0..1}, muted: {channel: boolean} }. */
const audioCodec: Codec = {
  read: (raw) => clean(parse(raw)),
  write: (v) => {
    const c = clean(v);
    return c ? JSON.stringify(c) : undefined;
  },
};
function clean(
  v: unknown,
): { volume: Record<string, number>; muted: Record<string, boolean> } | undefined {
  if (!isObject(v)) return undefined;
  const volume: Record<string, number> = {};
  const muted: Record<string, boolean> = {};
  const vol = isObject(v["volume"]) ? v["volume"] : {};
  const mut = isObject(v["muted"]) ? v["muted"] : {};
  for (const ch of CHANNELS) {
    const n = vol[ch];
    if (typeof n === "number" && n >= 0 && n <= 1) volume[ch] = n;
    const m = mut[ch];
    if (typeof m === "boolean") muted[ch] = m;
  }
  return { volume, muted };
}

/** rpg.hotkeys.<vocation>: twelve spell ids or null. */
const hotkeysCodec: Codec = {
  read: (raw) => bar(parse(raw)),
  write: (v) => {
    const b = bar(v);
    return b ? JSON.stringify(b) : undefined;
  },
};
function bar(v: unknown): (string | null)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.slice(0, 12).map((s) => (typeof s === "string" && ID.test(s) ? s : null));
}

/** rpg.track: { character name: quest id }. */
const trackCodec: Codec = {
  read: (raw) => tracked(parse(raw)),
  write: (v) => {
    const t = tracked(v);
    return t ? JSON.stringify(t) : undefined;
  },
};
function tracked(v: unknown): Record<string, string> | undefined {
  if (!isObject(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, quest] of Object.entries(v).slice(0, 32))
    if (NAME.test(name) && typeof quest === "string" && ID.test(quest)) out[name] = quest;
  return out;
}

/** rpg.minimap: { open, scale }. */
const minimapCodec: Codec = {
  read: (raw) => minimap(parse(raw)),
  write: (v) => {
    const m = minimap(v);
    return m ? JSON.stringify(m) : undefined;
  },
};
function minimap(v: unknown): { open: boolean; scale: number } | undefined {
  if (!isObject(v)) return undefined;
  const { open, scale } = v;
  if (typeof open !== "boolean" || typeof scale !== "number") return undefined;
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) return undefined;
  return { open, scale };
}

const MAX_WINDOWS = 64;
const MAX_COORD = 100000;

/** rpg.windows (ui/windows.ts, version 3): the layout as an object, places cleaned. */
const windowsCodec: Codec = {
  read: (raw) => windows(parse(raw)),
  write: (v) => {
    const w = windows(v);
    return w ? JSON.stringify(w) : undefined;
  },
};
function windows(v: unknown): unknown {
  if (!isObject(v) || v["v"] !== 3) return undefined;
  const places = (src: unknown): Record<string, Record<string, unknown>> => {
    const out: Record<string, Record<string, unknown>> = {};
    if (!isObject(src)) return out;
    for (const [id, p] of Object.entries(src).slice(-MAX_WINDOWS)) {
      if (!ID.test(id) || !isObject(p)) continue;
      const place: Record<string, unknown> = {};
      for (const k of ["open", "collapsed"]) if (typeof p[k] === "boolean") place[k] = p[k];
      for (const k of ["x", "y", "w", "h"]) {
        const n = p[k];
        if (typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= MAX_COORD) place[k] = n;
      }
      out[id] = place;
    }
    return out;
  };
  const z = Array.isArray(v["z"])
    ? v["z"].filter((id): id is string => typeof id === "string" && ID.test(id)).slice(-MAX_WINDOWS)
    : [];
  return { v: 3, z, win: places(v["win"]), others: places(v["others"]) };
}

const langCodec: Codec = {
  read: (raw) => (/^[a-z]{2,3}(-[A-Z]{2})?$/.test(raw) ? raw : undefined),
  write: (v) => (typeof v === "string" && /^[a-z]{2,3}(-[A-Z]{2})?$/.test(v) ? v : undefined),
};

/** Every option or toggle of the game, and where it is kept. */
export const OPTIONS: readonly OptionDef[] = [
  // ---- the character's game options: the game server keeps them ----
  { id: "fight.stance", persistence: "character", message: "SetFightMode" },
  { id: "fight.chase", persistence: "character", message: "SetFightMode" },
  // rpg.safeMode is only the switch's value before the Welcome arrives.
  {
    id: "pvp.safe_mode",
    persistence: "character",
    message: "SetSafeMode",
    storageKey: "rpg.safeMode",
  },
  { id: "look", persistence: "character", message: "SetLook" },
  // ---- interface options of the account ----
  {
    id: "language",
    persistence: "account",
    storageKey: "rpg.lang",
    field: "lang",
    codec: langCodec,
  },
  {
    id: "audio",
    persistence: "account",
    storageKey: "rpg.audio",
    field: "audio",
    codec: audioCodec,
  },
  {
    id: "controls",
    persistence: "account",
    storageKey: "rpg.controls",
    field: "controls",
    codec: oneOf(["menu", "classic"]),
  },
  {
    id: "reduced_motion",
    persistence: "account",
    storageKey: "rpg.motion",
    field: "reduced_motion",
    codec: flag("reduced", "full"),
  },
  {
    id: "ui_scale",
    persistence: "account",
    storageKey: "rpg.ui-scale",
    field: "ui_scale",
    codec: numberIn(0.5, 2, false),
  },
  {
    id: "text_scale",
    persistence: "account",
    storageKey: "rpg.text-scale",
    field: "text_scale",
    codec: numberIn(0.5, 2, false),
  },
  {
    id: "camera_shake",
    persistence: "account",
    storageKey: "rpg.shake",
    field: "camera_shake",
    codec: flag("on", "off"),
  },
  {
    id: "chat_bubbles",
    persistence: "account",
    storageKey: "rpg.chat-bubbles",
    field: "chat_bubbles",
    codec: flag("on", "off"),
  },
  {
    id: "name_size",
    persistence: "account",
    storageKey: "rpg.name-size",
    field: "name_size",
    codec: oneOf(["normal", "large"]),
  },
  {
    id: "chat_opacity",
    persistence: "account",
    storageKey: "rpg.chat-opacity",
    field: "chat_opacity",
    codec: numberIn(0, 100, true),
  },
  {
    id: "hotkeys",
    persistence: "account",
    storageKey: "rpg.hotkeys.",
    keyed: true,
    field: "hotkeys",
    codec: hotkeysCodec,
    personal: true,
  },
  {
    id: "tracked_quest",
    persistence: "account",
    storageKey: "rpg.track",
    field: "track",
    codec: trackCodec,
    personal: true,
  },
  // ---- per kind of screen ----
  {
    id: "touch_pad",
    persistence: "device-class",
    storageKey: "rpg.touchPad",
    field: "touch_pad",
    codec: flag("on", "off"),
  },
  {
    id: "map_zoom",
    persistence: "device-class",
    storageKey: "rpg.zoom",
    field: "zoom",
    codec: numberIn(1, 32, true),
  },
  {
    id: "minimap",
    persistence: "device-class",
    storageKey: "rpg.minimap",
    field: "minimap",
    codec: minimapCodec,
  },
  {
    id: "windows",
    persistence: "device-class",
    storageKey: "rpg.windows",
    field: "windows",
    codec: windowsCodec,
  },
  // ---- not saved, on purpose ----
  {
    id: "attack_target",
    persistence: "session",
    message: "SetTarget",
    reason: "the creature being attacked, not a preference: it ends with the fight or the login",
  },
  {
    id: "left_in_fight_note",
    persistence: "session",
    storageKey: "rpg.stayedInFight",
    reason: "a note to this browser's next start (the character stayed in a fight), not an option",
  },
  {
    id: "touch_controls",
    persistence: "session",
    storageKey: "rpg.touch",
    reason:
      "how this device is held (stick or pad, left hand, button size, vibration): another phone or tablet of the same account differs",
  },
  {
    id: "effects_preset",
    persistence: "session",
    storageKey: "rpg.effects",
    reason: "what this device can draw smoothly, picked by its own capability check",
  },
  {
    id: "app_mode",
    persistence: "session",
    storageKey: "rpg.appMode",
    reason:
      "whether this browser was offered the install and asked for full screen: it is about this device before any login",
  },
  {
    id: "last_email",
    persistence: "session",
    storageKey: "rpg.lastEmail",
    reason:
      "the email the login form starts with on this browser: it exists before any account is known",
  },
  {
    id: "unsent_options_note",
    persistence: "session",
    storageKey: UNSENT_KEY,
    reason: "the sync's own note: which saved keys this browser still has to send",
  },
  {
    id: "options_owner_note",
    persistence: "session",
    storageKey: OWNER_KEY,
    reason: "the sync's own note: the account the options cached in this browser belong to",
  },
  {
    id: "chat_channel",
    persistence: "session",
    reason:
      "the channel being written to follows the conversation; every login starts on the local one",
  },
  {
    id: "party_shared_experience",
    persistence: "session",
    reason:
      "belongs to the party, which lives in the server's memory and ends when its members leave",
  },
];

export type DeviceClass = "desktop" | "touch";
export const DEVICE_CLASSES: readonly DeviceClass[] = ["desktop", "touch"];

/** The account's options document (version 1); the server owns the schema. */
export type OptionsDoc = { v: 1 } & Record<string, unknown>;

export const emptyDoc = (): OptionsDoc => ({ v: 1 });

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function get(storage: Store, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function keysWith(storage: Store, prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(prefix)) out.push(k);
    }
  } catch {
    // blocked storage: nothing remembered
  }
  return out.sort();
}

const saved = OPTIONS.filter(
  (o): o is OptionDef & { storageKey: string; field: string; codec: Codec } =>
    (o.persistence === "account" || o.persistence === "device-class") &&
    o.storageKey !== undefined &&
    o.field !== undefined &&
    o.codec !== undefined,
);

/** The document of what this browser remembers (its own device section only). */
export function docFromStorage(storage: Store, device: DeviceClass): OptionsDoc {
  const doc = emptyDoc();
  const dev: Record<string, unknown> = {};
  for (const o of saved) {
    let value: unknown;
    if (o.keyed) {
      const map: Record<string, unknown> = {};
      for (const k of keysWith(storage, o.storageKey).slice(0, 16)) {
        const name = k.slice(o.storageKey.length);
        const raw = get(storage, k);
        const v = raw === null || !ID.test(name) ? undefined : o.codec.read(raw);
        if (v !== undefined) map[name] = v;
      }
      value = Object.keys(map).length > 0 ? map : undefined;
    } else {
      const raw = get(storage, o.storageKey);
      value = raw === null ? undefined : o.codec.read(raw);
    }
    if (value === undefined) continue;
    if (o.persistence === "device-class") dev[o.field] = value;
    else doc[o.field] = value;
  }
  if (Object.keys(dev).length > 0) doc["devices"] = { [device]: dev };
  return doc;
}

/**
 * Writes a document into localStorage (this device's section of it); a value the codecs do
 * not accept is skipped. Returns true when something stored changed.
 */
export function applyDoc(doc: OptionsDoc, storage: Store, device: DeviceClass): boolean {
  let changed = false;
  const put = (key: string, value: string | undefined): void => {
    if (value === undefined || get(storage, key) === value) return;
    try {
      storage.setItem(key, value);
      changed = true;
    } catch {
      // Private mode or full storage: the option lasts for this page only.
    }
  };
  const devices = isObject(doc["devices"]) ? doc["devices"] : {};
  const dev = isObject(devices[device]) ? devices[device] : {};
  for (const o of saved) {
    const value = o.persistence === "device-class" ? dev[o.field] : doc[o.field];
    if (value === undefined) continue;
    if (!o.keyed) put(o.storageKey, o.codec.write(value));
    else if (isObject(value))
      for (const [name, v] of Object.entries(value))
        if (ID.test(name)) put(o.storageKey + name, o.codec.write(v));
  }
  return changed;
}

/** Fields that are one value: never merged key by key. */
const WHOLE = new Set(["windows", "minimap"]);

/**
 * The login's merge rule: the server wins, the local values fill what the server lacks.
 * Maps (the audio channels, the bars per vocation, the tracked quest per character, the
 * device sections) merge key by key; a window layout is one value.
 */
export function mergeDocs(server: OptionsDoc, local: OptionsDoc): OptionsDoc {
  return { ...(merge(server, local) as Record<string, unknown>), v: 1 };
}

function merge(server: unknown, local: unknown, field = ""): unknown {
  if (server === undefined) return local;
  if (!isObject(server) || !isObject(local) || WHOLE.has(field)) return server;
  const out: Record<string, unknown> = { ...local };
  for (const [k, v] of Object.entries(server)) out[k] = merge(v, local[k], k);
  return out;
}

/** Stable JSON (sorted keys), to compare documents. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** True for a key OptionsSync saves to the account. */
export function isSavedKey(key: string): boolean {
  return saved.some((o) => (o.keyed ? key.startsWith(o.storageKey) : key === o.storageKey));
}

/** What GET /api/account/options answers. */
export interface AccountOptions {
  options: OptionsDoc;
  /** Tells this account from another one on the same browser; an older server has none. */
  account?: string | undefined;
}

export interface OptionsApi {
  get(): Promise<AccountOptions>;
  put(doc: OptionsDoc): Promise<void>;
  /** The same save, started so that it outlives the page (fetch keepalive). */
  putLeaving?(doc: OptionsDoc): Promise<void>;
}

export interface SyncTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** How long after the last change the options are sent. */
export const SAVE_DELAY_MS = 2000;

/** The waits before each new try of a save that failed; after the last, the next change. */
export const RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000, 120_000, 300_000];

function remove(storage: Store, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // blocked storage: nothing to forget
  }
}

/** `doc` without the fields of the storage keys in `keys` (of `device`'s section). */
function without(doc: OptionsDoc, keys: ReadonlySet<string>, device: DeviceClass): OptionsDoc {
  if (keys.size === 0) return doc;
  const out = JSON.parse(JSON.stringify(doc)) as OptionsDoc;
  const devices = isObject(out["devices"]) ? out["devices"] : {};
  const dev = isObject(devices[device]) ? devices[device] : {};
  for (const o of saved) {
    const home = o.persistence === "device-class" ? dev : out;
    if (!o.keyed) {
      if (keys.has(o.storageKey)) Reflect.deleteProperty(home, o.field);
      continue;
    }
    const map = home[o.field];
    if (!isObject(map)) continue;
    for (const k of keys)
      if (k.startsWith(o.storageKey)) Reflect.deleteProperty(map, k.slice(o.storageKey.length));
  }
  return out;
}

/**
 * Keeps the account's document and this browser's localStorage in step.
 *
 * login() merges: the server wins and the local values fill what it lacks, except the
 * keys this browser changed and never got confirmed (marked in UNSENT_KEY: the tab closed
 * before the save, or the save failed) and the ones chosen on this page before the
 * login, where the local value (or its absence) wins. What another account left in this
 * browser is not trusted: its marks are dropped and its personal options removed.
 *
 * changed() sends this browser's values a moment after the last change; a save that
 * fails is tried again after a wait, and leaving() sends what waits when the page goes
 * away. A save carries this device class's section only: the server keeps the others
 * (a page open for hours knows nothing of what the phone saved since). Before login()
 * and after logout() nothing is sent.
 */
export class OptionsSync {
  /**
   * What the server has of this browser's part of the document (the account's fields and
   * this device class's section), as far as this page knows; undefined = not logged in.
   */
  private sent: OptionsDoc | undefined;
  private timer: unknown;
  private epoch = 0;
  /** Saved keys written on this page before the login: the player's newest choices. */
  private readonly early = new Set<string>();
  /** The sync itself is writing localStorage: those writes are not the player's. */
  private applying = false;
  /** Counts the player's changes: a save confirms the marks only if none came meanwhile. */
  private changes = 0;
  /** Saves that failed in a row since the last change. */
  private failures = 0;
  /** One save at a time, in order. */
  private busy: Promise<void> = Promise.resolve();
  /** The login under way, until the account's options are in localStorage. */
  private entering: Promise<unknown> | undefined;

  constructor(
    private readonly api: OptionsApi,
    private readonly storage: Store | undefined,
    private readonly device: DeviceClass,
    private readonly timers: SyncTimers,
  ) {}

  /** After a login: returns true when localStorage changed (the screens reload it). */
  async login(): Promise<boolean> {
    if (!this.storage) return false;
    if (this.sent) {
      // Already in step with this account (back from the game): only send what waits.
      this.timers.clear(this.timer);
      this.timer = undefined;
      await this.flush();
      return false;
    }
    const run = this.enter(this.storage);
    this.entering = run;
    const { changed, doc } = await run;
    if (this.entering === run) this.entering = undefined;
    if (doc) await this.push(doc);
    return changed;
  }

  /**
   * Resolves once the login under way has put the account's options in localStorage (at
   * once when none is), or after `maxMs`: a screen that reads its options when it opens
   * (the game's windows) waits for this, so it never starts from the values the login is
   * about to replace.
   */
  ready(maxMs: number): Promise<void> {
    const entering = this.entering;
    if (!entering) return Promise.resolve();
    return new Promise((resolve) => {
      const cap = this.timers.set(resolve, maxMs);
      void entering.then(() => {
        this.timers.clear(cap);
        resolve();
      });
    });
  }

  /** The GET and the merge of a login; `doc` is what the server should have afterwards. */
  private async enter(storage: Store): Promise<{ changed: boolean; doc?: OptionsDoc }> {
    const epoch = ++this.epoch;
    let got: unknown;
    try {
      got = await this.api.get();
    } catch {
      return { changed: false }; // offline or an older server: localStorage goes on alone
    }
    if (epoch !== this.epoch) return { changed: false };
    const answer = isObject(got) ? got : {};
    const options = answer["options"];
    const server = isObject(options) && options["v"] === 1 ? (options as OptionsDoc) : emptyDoc();
    const account = answer["account"];
    let unsent = this.unsent(storage);
    let changed = false;
    this.applying = true;
    try {
      if (typeof account === "string" && account !== "") {
        const owner = get(storage, OWNER_KEY);
        if (owner !== null && owner !== account) {
          // Another account used this browser: what it could not send is not this one's,
          // and neither are its characters' quests and bars.
          unsent = new Set();
          for (const o of saved) {
            if (!o.personal) continue;
            for (const k of o.keyed ? keysWith(storage, o.storageKey) : [o.storageKey])
              if (!this.early.has(k) && get(storage, k) !== null) {
                remove(storage, k);
                changed = true;
              }
          }
        }
        this.note(storage, OWNER_KEY, account);
      }
      // The local value (or its absence) is the truth for what the player chose here and
      // the server never confirmed, and for what was chosen on this very page before
      // logging in (the language or the volume on the login screen).
      const chosen = new Set([...unsent, ...this.early]);
      this.early.clear();
      this.mark(storage, chosen);
      const merged = mergeDocs(
        without(server, chosen, this.device),
        docFromStorage(storage, this.device),
      );
      if (applyDoc(merged, storage, this.device)) changed = true;
      this.sent = this.own(server);
      return { changed, doc: this.own(merged) };
    } finally {
      this.applying = false;
    }
  }

  /**
   * The player logged out: stop sending. The marks of what was not sent stay for this
   * account's next login; another account's login drops them (enter).
   */
  logout(): void {
    this.epoch++;
    this.sent = undefined;
    this.entering = undefined;
    this.early.clear();
    this.failures = 0;
    this.timers.clear(this.timer);
    this.timer = undefined;
  }

  /** A saved key was written: mark it and send the document once the changes stop. */
  changed(key?: string): void {
    if (this.applying) return;
    this.changes++;
    if (key !== undefined && this.storage) {
      const unsent = this.unsent(this.storage);
      if (!unsent.has(key)) this.mark(this.storage, unsent.add(key));
    }
    if (!this.sent) {
      if (key !== undefined) this.early.add(key);
      return;
    }
    this.failures = 0;
    this.schedule(SAVE_DELAY_MS);
  }

  /** Sends now what a pending change would send later. */
  flush(): Promise<void> {
    return this.push();
  }

  /**
   * The page is going away (pagehide): what waits is sent at once, in a way that outlives
   * the page. If it does not arrive, the marks make the local values win at the next login.
   */
  leaving(): void {
    if (this.timer === undefined) return;
    this.timers.clear(this.timer);
    this.timer = undefined;
    void this.save(undefined, true);
  }

  private schedule(ms: number): void {
    this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
  }

  private push(doc?: OptionsDoc): Promise<void> {
    const run = this.busy.then(() => this.save(doc));
    this.busy = run;
    return run;
  }

  /** Sends `doc` (by default what localStorage holds now) unless the server has it. */
  private async save(given?: OptionsDoc, leaving = false): Promise<void> {
    const { storage } = this;
    if (!storage || !this.sent) return;
    const doc = given ?? this.own(docFromStorage(storage, this.device));
    const mark = this.changes;
    if (stable(doc) !== stable(this.sent)) {
      const epoch = this.epoch;
      try {
        if (leaving && this.api.putLeaving) await this.api.putLeaving(doc);
        else await this.api.put(doc);
      } catch {
        // Rate limited, offline, refused: the marks stay, and it is tried again later.
        if (epoch === this.epoch) this.retry();
        return;
      }
      if (epoch !== this.epoch) return;
      this.sent = doc;
      this.failures = 0;
    }
    // The server has everything, unless the player changed something meanwhile.
    if (mark === this.changes) remove(storage, UNSENT_KEY);
  }

  private retry(): void {
    if (this.timer !== undefined) return; // a newer change already waits
    const wait = RETRY_DELAYS_MS[this.failures];
    if (wait === undefined) return; // given up until the next change or login
    this.failures++;
    this.schedule(wait);
  }

  /** This browser's part of a document: the account's fields and its own device section. */
  private own(doc: OptionsDoc): OptionsDoc {
    const devices = isObject(doc["devices"]) ? doc["devices"] : {};
    const mine = devices[this.device];
    // Always its section, even empty: that is how the server learns an option was unset.
    return { ...doc, devices: { [this.device]: isObject(mine) ? mine : {} } };
  }

  /** The saved keys marked as not confirmed by the server. */
  private unsent(storage: Store): Set<string> {
    const raw = get(storage, UNSENT_KEY);
    const list = raw === null ? undefined : parse(raw);
    return new Set(
      Array.isArray(list)
        ? list.filter((k): k is string => typeof k === "string" && isSavedKey(k)).slice(0, 64)
        : [],
    );
  }

  private mark(storage: Store, keys: ReadonlySet<string>): void {
    if (keys.size === 0) remove(storage, UNSENT_KEY);
    else this.note(storage, UNSENT_KEY, JSON.stringify([...keys].sort()));
  }

  private note(storage: Store, key: string, value: string): void {
    try {
      if (storage.getItem(key) !== value) storage.setItem(key, value);
    } catch {
      // Private mode or full storage: the note lasts for this page only.
    }
  }
}

/**
 * A view of `base` that tells `onSaved` after each write of a saved key. Everything that
 * stores an option goes through one of these (state/option-storage.ts).
 */
export function watchedStorage(base: Storage, onSaved: (key: string) => void): Storage {
  const note = (key: string): void => {
    if (isSavedKey(key)) onSaved(key);
  };
  return {
    get length() {
      return base.length;
    },
    key: (i) => base.key(i),
    getItem: (k) => base.getItem(k),
    setItem: (k, v) => {
      base.setItem(k, v);
      note(k);
    },
    removeItem: (k) => {
      base.removeItem(k);
      note(k);
    },
    clear: () => base.clear(),
  };
}
