import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEVICE_CLASSES,
  OPTIONS,
  OWNER_KEY,
  OptionsSync,
  RETRY_DELAYS_MS,
  SAVE_DELAY_MS,
  UNSENT_KEY,
  applyDoc,
  docFromStorage,
  emptyDoc,
  isSavedKey,
  mergeDocs,
  stable,
  watchedStorage,
} from "./saved-options.ts";
import type { AccountOptions, OptionsApi, OptionsDoc } from "./saved-options.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

class MemoryStorage implements Storage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

function storageWith(values: Record<string, string>): MemoryStorage {
  const s = new MemoryStorage();
  for (const [k, v] of Object.entries(values)) s.setItem(k, v);
  return s;
}

const WINDOWS = JSON.stringify({
  v: 3,
  z: ["battle"],
  win: { battle: { open: true, collapsed: false, x: 10, y: 20 } },
  others: { "container-backpack": { collapsed: false, w: 200 } },
});

/** A browser where the player changed everything. */
const everything = (): MemoryStorage =>
  storageWith({
    "rpg.lang": "en",
    "rpg.audio": JSON.stringify({
      volume: { master: 0.4, music: 0, sfx: 1, ui: 0.7, ambient: 0.6 },
      muted: { master: false, music: true, sfx: false, ui: false, ambient: false },
    }),
    "rpg.controls": "classic",
    "rpg.motion": "reduced",
    "rpg.ui-scale": "1.25",
    "rpg.text-scale": "0.9",
    "rpg.shake": "off",
    "rpg.chat-bubbles": "off",
    "rpg.name-size": "normal",
    "rpg.chat-opacity": "65",
    "rpg.hotkeys.guardian": JSON.stringify(["arc_bolt", null, "ember_ring"]),
    "rpg.track": JSON.stringify({ "Ana María": "bounty_crawlers" }),
    "rpg.touchPad": "on",
    "rpg.zoom": "3",
    "rpg.minimap": JSON.stringify({ open: false, scale: 4 }),
    "rpg.windows": WINDOWS,
  });

// ---- the guard: nothing the player can choose escapes the registry ------------------

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("the registry of options", () => {
  it("declares where each option is kept", () => {
    const ids = new Set<string>();
    for (const o of OPTIONS) {
      expect(ids.has(o.id), `${o.id} is declared twice`).toBe(false);
      ids.add(o.id);
      expect(["character", "account", "device-class", "session"]).toContain(o.persistence);
      if (o.persistence === "session")
        expect(o.reason?.length ?? 0, `${o.id}: not saved, so it says why`).toBeGreaterThan(20);
      if (o.persistence === "character")
        expect(o.message, `${o.id}: the message that sets it on the server`).toBeTruthy();
      if (o.persistence === "account" || o.persistence === "device-class") {
        expect(o.storageKey, `${o.id}: its localStorage cache`).toBeTruthy();
        expect(o.field, `${o.id}: its field of the account document`).toBeTruthy();
        expect(o.codec, `${o.id}: how it is checked`).toBeTruthy();
      }
    }
  });

  it("knows every localStorage key of the client", () => {
    // Every "rpg.<name>" literal of the client's sources is a localStorage key.
    const declared = OPTIONS.flatMap((o) => (o.storageKey ? [o] : []));
    const found = new Set<string>();
    for (const file of sourceFiles(join(root, "client/src")))
      for (const m of readFileSync(file, "utf8").matchAll(/["'`](rpg\.[A-Za-z][\w.-]*)/g))
        found.add(m[1] ?? "");
    expect(found.size).toBeGreaterThan(10);
    for (const key of found) {
      const known = declared.some((o) =>
        o.keyed ? key.startsWith(o.storageKey ?? "") : key === o.storageKey,
      );
      expect(known, `localStorage key "${key}" is not in OPTIONS (state/saved-options.ts)`).toBe(
        true,
      );
    }
    for (const o of declared)
      expect(
        [...found].some((k) => k === o.storageKey || (o.keyed && k.startsWith(o.storageKey ?? ""))),
        `${o.id}: "${o.storageKey}" is not used by the client any more`,
      ).toBe(true);
  });

  it("knows every Set* message of the protocol", () => {
    const proto = readFileSync(join(root, "proto/game/v1/client.proto"), "utf8");
    const setters = [...proto.matchAll(/^message (Set[A-Z]\w*)/gm)].map((m) => m[1]);
    expect(setters).toContain("SetFightMode");
    const declared = new Set(OPTIONS.map((o) => o.message));
    for (const s of setters)
      expect(declared.has(s), `message ${s} sets something OPTIONS does not declare`).toBe(true);
    for (const o of OPTIONS)
      if (o.message) expect(setters, `${o.id}: no message ${o.message}`).toContain(o.message);
  });

  it("only uses fields the server's schema has", () => {
    const go = readFileSync(join(root, "server/internal/accountopts/accountopts.go"), "utf8");
    const struct = (name: string): string[] => {
      const body = new RegExp(`type ${name} struct \\{([^}]*)\\}`).exec(go)?.[1] ?? "";
      return [...body.matchAll(/json:"([a-z_]+)/g)].map((m) => m[1] ?? "");
    };
    const doc = struct("Doc");
    const device = struct("Device");
    expect(doc).toContain("devices");
    for (const o of OPTIONS) {
      if (o.persistence === "account") expect(doc, o.id).toContain(o.field);
      if (o.persistence === "device-class") expect(device, o.id).toContain(o.field);
    }
    // And the server has no field no option fills.
    const fields = new Set(OPTIONS.map((o) => o.field));
    for (const f of [...doc, ...device])
      if (f !== "v" && f !== "devices") expect(fields.has(f), `server field ${f}`).toBe(true);
    for (const c of DEVICE_CLASSES) expect(go).toContain(`"${c}"`);
  });
});

// ---- the document ---------------------------------------------------------------------

describe("docFromStorage and applyDoc", () => {
  it("round-trips everything a browser remembers", () => {
    const doc = docFromStorage(everything(), "desktop");
    expect(doc).toEqual({
      v: 1,
      lang: "en",
      audio: {
        volume: { master: 0.4, music: 0, sfx: 1, ui: 0.7, ambient: 0.6 },
        muted: { master: false, music: true, sfx: false, ui: false, ambient: false },
      },
      controls: "classic",
      reduced_motion: true,
      ui_scale: 1.25,
      text_scale: 0.9,
      camera_shake: false,
      chat_bubbles: false,
      name_size: "normal",
      chat_opacity: 65,
      hotkeys: { guardian: ["arc_bolt", null, "ember_ring"] },
      track: { "Ana María": "bounty_crawlers" },
      devices: {
        desktop: {
          touch_pad: true,
          zoom: 3,
          minimap: { open: false, scale: 4 },
          windows: JSON.parse(WINDOWS) as unknown,
        },
      },
    });
    const other = new MemoryStorage();
    expect(applyDoc(doc, other, "desktop")).toBe(true);
    expect(docFromStorage(other, "desktop")).toEqual(doc);
    expect(applyDoc(doc, other, "desktop")).toBe(false); // nothing left to change
    // Another kind of screen takes the account's options, not this one's pixels.
    const phone = new MemoryStorage();
    applyDoc(doc, phone, "touch");
    expect(phone.getItem("rpg.lang")).toBe("en");
    expect(phone.getItem("rpg.windows")).toBeNull();
    expect(phone.getItem("rpg.zoom")).toBeNull();
  });

  it("an empty browser gives the empty document", () => {
    expect(docFromStorage(new MemoryStorage(), "touch")).toEqual(emptyDoc());
  });

  it("never passes junk on, in either direction", () => {
    const junk = storageWith({
      "rpg.lang": "<script>alert(1)</script>",
      "rpg.audio": "{not json",
      "rpg.controls": "<img src=x onerror=alert(1)>",
      "rpg.ui-scale": "1e9",
      "rpg.chat-opacity": "50.5",
      "rpg.hotkeys.<b>": "[]",
      "rpg.hotkeys.guardian": JSON.stringify(["javascript:alert(1)", "arc_bolt"]),
      "rpg.track": JSON.stringify({ "<i>x</i>": "q", Ana: "Not An Id" }),
      "rpg.zoom": "0",
      "rpg.minimap": JSON.stringify({ open: "yes", scale: 2 }),
      "rpg.windows": JSON.stringify({ v: 2, z: [], win: {}, others: {} }),
      "rpg.stayedInFight": "[]",
    });
    expect(docFromStorage(junk, "desktop")).toEqual({
      v: 1,
      hotkeys: { guardian: [null, "arc_bolt"] },
      track: {},
    });
    const target = new MemoryStorage();
    const hostile = {
      v: 1,
      lang: "<script>",
      controls: { toString: "x" },
      ui_scale: "big",
      camera_shake: "on",
      hotkeys: { "<b>": ["a"], guardian: "nope" },
      track: "x",
      devices: { desktop: { zoom: 99, windows: { v: 3, z: ["<x>"], win: { "a b": {} } } } },
      motd: "<b>hello</b>",
    } as unknown as OptionsDoc;
    applyDoc(hostile, target, "desktop");
    expect([...target.map.keys()]).toEqual(["rpg.windows"]);
    expect(target.getItem("rpg.windows")).toBe(
      JSON.stringify({ v: 3, z: [], win: {}, others: {} }),
    );
  });

  it("drops the unknown keys of a window place", () => {
    const s = storageWith({
      "rpg.windows": JSON.stringify({
        v: 3,
        z: [],
        win: { battle: { open: true, dock: true, x: 1.5, y: 4, html: "<b>" } },
        others: {},
      }),
    });
    expect(docFromStorage(s, "desktop")["devices"]).toEqual({
      desktop: { windows: { v: 3, z: [], win: { battle: { open: true, y: 4 } }, others: {} } },
    });
  });
});

describe("mergeDocs: the server wins, the local values fill what it lacks", () => {
  it("takes the server's value where both have one", () => {
    const merged = mergeDocs(
      { v: 1, lang: "es", chat_opacity: 40 },
      { v: 1, lang: "en", controls: "classic" },
    );
    expect(merged).toEqual({ v: 1, lang: "es", chat_opacity: 40, controls: "classic" });
  });

  it("merges maps key by key and keeps a layout whole", () => {
    const server: OptionsDoc = {
      v: 1,
      audio: { volume: { master: 0.2 } },
      hotkeys: { guardian: ["a"] },
      devices: { desktop: { zoom: 2, windows: { v: 3, z: ["chat"], win: {}, others: {} } } },
    };
    const local: OptionsDoc = {
      v: 1,
      audio: { volume: { master: 0.9, music: 0.3 }, muted: { music: true } },
      hotkeys: { guardian: ["b"], mage: ["c"] },
      devices: {
        desktop: {
          zoom: 5,
          touch_pad: true,
          windows: { v: 3, z: [], win: { battle: { open: true } }, others: {} },
        },
        touch: { zoom: 1 },
      },
    };
    expect(mergeDocs(server, local)).toEqual({
      v: 1,
      audio: { volume: { master: 0.2, music: 0.3 }, muted: { music: true } },
      hotkeys: { guardian: ["a"], mage: ["c"] },
      devices: {
        desktop: { zoom: 2, touch_pad: true, windows: { v: 3, z: ["chat"], win: {}, others: {} } },
        touch: { zoom: 1 },
      },
    });
  });

  it("is the local document for an account that never saved", () => {
    const local = docFromStorage(everything(), "desktop");
    expect(mergeDocs(emptyDoc(), local)).toEqual(local);
  });
});

// ---- the sync -------------------------------------------------------------------------

class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, () => void>();
  delays: number[] = [];
  set = (fn: () => void, ms: number): unknown => {
    this.delays.push(ms);
    this.pending.set(this.next, fn);
    return this.next++;
  };
  clear = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  run(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }
}

/** The server: a save replaces the document but keeps the device sections it lacks. */
class FakeApi implements OptionsApi {
  doc: OptionsDoc = emptyDoc();
  account: string | undefined = "tag-ana";
  puts: OptionsDoc[] = [];
  /** How many of the puts were made as the page went away. */
  leavings = 0;
  fail: Error | undefined;
  /** The GET waits for this (a slow server). */
  gate: Promise<void> = Promise.resolve();
  get = async (): Promise<AccountOptions> => {
    await this.gate;
    if (this.fail) throw this.fail;
    return { options: this.doc, account: this.account };
  };
  put = (doc: OptionsDoc): Promise<void> => {
    if (this.fail) return Promise.reject(this.fail);
    this.puts.push(doc);
    const kept = (this.doc["devices"] ?? {}) as Record<string, unknown>;
    const sent = (doc["devices"] ?? {}) as Record<string, unknown>;
    this.doc = { ...doc, devices: { ...kept, ...sent } };
    return Promise.resolve();
  };
  putLeaving = (doc: OptionsDoc): Promise<void> => {
    this.leavings++;
    return this.put(doc);
  };
}

const OFFLINE = new Error("offline");

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function setup(
  values: Record<string, string>,
  device: "desktop" | "touch" = "desktop",
  base: MemoryStorage = storageWith(values),
) {
  const api = new FakeApi();
  const timers = new FakeTimers();
  const holder: { sync?: OptionsSync } = {};
  const storage = watchedStorage(base, (key) => holder.sync?.changed(key));
  const sync = new OptionsSync(api, storage, device, timers);
  holder.sync = sync;
  return { api, timers, base, storage, sync };
}

describe("OptionsSync", () => {
  it("at login the server wins, the browser fills, and the result is saved", async () => {
    const { api, base, sync } = setup({ "rpg.lang": "en", "rpg.controls": "classic" });
    api.doc = { v: 1, lang: "es", chat_opacity: 40 };
    expect(await sync.login()).toBe(true);
    expect(base.getItem("rpg.lang")).toBe("es");
    expect(base.getItem("rpg.chat-opacity")).toBe("40");
    expect(base.getItem("rpg.controls")).toBe("classic");
    expect(api.puts).toEqual([
      { v: 1, lang: "es", chat_opacity: 40, controls: "classic", devices: { desktop: {} } },
    ]);
  });

  it("sends nothing when the browser adds nothing", async () => {
    const { api, sync } = setup({ "rpg.lang": "es" });
    api.doc = { v: 1, lang: "es", chat_opacity: 40 };
    expect(await sync.login()).toBe(true); // the opacity came in
    expect(api.puts).toEqual([]);
  });

  it("what the player chose on the login screen wins over the saved value", async () => {
    const { api, base, storage, sync } = setup({ "rpg.lang": "en", "rpg.controls": "classic" });
    api.doc = { v: 1, lang: "es", controls: "menu" };
    storage.setItem("rpg.lang", "en"); // picked before logging in, on this page
    await sync.login();
    expect(base.getItem("rpg.lang")).toBe("en");
    expect(base.getItem("rpg.controls")).toBe("menu"); // an older local value loses
    expect(api.doc["lang"]).toBe("en");
  });

  it("sends a change once the changes stop, and only saved keys", async () => {
    const { api, timers, storage, sync } = setup({});
    await sync.login();
    storage.setItem("rpg.stayedInFight", "[]"); // not an option
    expect(timers.pending.size).toBe(0);
    storage.setItem("rpg.chat-opacity", "70");
    storage.setItem("rpg.chat-opacity", "75");
    storage.setItem("rpg.hotkeys.guardian", JSON.stringify(["arc_bolt"]));
    expect(timers.pending.size).toBe(1);
    expect(timers.delays.every((d) => d === SAVE_DELAY_MS)).toBe(true);
    timers.run();
    await settle();
    expect(api.puts).toEqual([
      { v: 1, chat_opacity: 75, hotkeys: { guardian: ["arc_bolt"] }, devices: { desktop: {} } },
    ]);
    storage.removeItem("rpg.zoom"); // nothing really changed
    timers.run();
    await settle();
    expect(api.puts.length).toBe(1);
  });

  it("saves its own device section only: a long session never writes the other back", async () => {
    const { api, timers, storage, sync } = setup({ "rpg.zoom": "3" });
    api.doc = { v: 1, devices: { desktop: { zoom: 3 }, touch: { zoom: 4 } } };
    await sync.login();
    expect(api.puts).toEqual([]);
    // Hours later the phone has saved its own section; this page never heard of it.
    api.doc = { v: 1, devices: { desktop: { zoom: 3 }, touch: { zoom: 2, touch_pad: true } } };
    storage.setItem("rpg.chat-opacity", "70");
    timers.run();
    await settle();
    expect(api.puts).toEqual([{ v: 1, chat_opacity: 70, devices: { desktop: { zoom: 3 } } }]);
    expect(api.doc["devices"]).toEqual({
      desktop: { zoom: 3 },
      touch: { zoom: 2, touch_pad: true },
    });
  });

  it("says an option of its device section was unset with the empty section", async () => {
    const { api, timers, storage, sync } = setup({ "rpg.zoom": "3" });
    api.doc = { v: 1, devices: { desktop: { zoom: 3 } } };
    await sync.login();
    storage.removeItem("rpg.zoom"); // back to the fitted zoom
    timers.run();
    await settle();
    expect(api.puts).toEqual([{ v: 1, devices: { desktop: {} } }]);
  });

  it("a change the page never sent wins at the next login", async () => {
    const first = setup({ "rpg.chat-opacity": "40", "rpg.zoom": "3", "rpg.lang": "es" });
    first.api.doc = { v: 1, lang: "es", chat_opacity: 40, devices: { desktop: { zoom: 3 } } };
    await first.sync.login();
    first.storage.setItem("rpg.chat-opacity", "70");
    first.storage.removeItem("rpg.zoom");
    // The tab closes before the save's delay: nothing was sent.
    expect(first.api.puts).toEqual([]);

    // The next start of the same browser: a new page, the same localStorage.
    const next = setup({}, "desktop", first.base);
    next.api.doc = { v: 1, lang: "en", chat_opacity: 40, devices: { desktop: { zoom: 3 } } };
    await next.sync.login();
    expect(next.base.getItem("rpg.chat-opacity")).toBe("70");
    expect(next.base.getItem("rpg.zoom")).toBeNull();
    expect(next.base.getItem("rpg.lang")).toBe("en"); // not changed here: the server wins
    expect(next.api.puts).toEqual([
      { v: 1, lang: "en", chat_opacity: 70, devices: { desktop: {} } },
    ]);
    // Confirmed: the marks are gone, and from now on the server wins again.
    expect(next.base.getItem(UNSENT_KEY)).toBeNull();
    const later = setup({}, "desktop", first.base);
    later.api.doc = { v: 1, lang: "en", chat_opacity: 55, devices: { desktop: {} } };
    await later.sync.login();
    expect(later.base.getItem("rpg.chat-opacity")).toBe("55");
  });

  it("a save that failed is tried again after a wait, and wins at the next login", async () => {
    const { api, timers, base, storage, sync } = setup({});
    api.doc = { v: 1, chat_opacity: 40 };
    await sync.login();
    api.fail = OFFLINE;
    storage.setItem("rpg.chat-opacity", "70");
    timers.run();
    await settle();
    expect(api.puts).toEqual([]);
    expect(JSON.parse(base.getItem(UNSENT_KEY) ?? "[]")).toEqual(["rpg.chat-opacity"]);
    // Tried again on its own, later each time, a bounded number of times.
    for (const wait of RETRY_DELAYS_MS) {
      expect(timers.delays.at(-1)).toBe(wait);
      expect(timers.pending.size).toBe(1);
      timers.run();
      await settle();
    }
    expect(timers.pending.size).toBe(0);
    expect(api.puts).toEqual([]);

    // The page closes without ever reaching the server: the next login sends it.
    const next = setup({}, "desktop", base);
    next.api.doc = { v: 1, chat_opacity: 40 };
    await next.sync.login();
    expect(next.base.getItem("rpg.chat-opacity")).toBe("70");
    expect(next.api.doc["chat_opacity"]).toBe(70);
  });

  it("the retry sends it when the server is back", async () => {
    const { api, timers, base, storage, sync } = setup({});
    await sync.login();
    api.fail = OFFLINE;
    storage.setItem("rpg.chat-opacity", "70");
    timers.run();
    await settle();
    api.fail = undefined;
    expect(timers.delays.at(-1)).toBe(RETRY_DELAYS_MS[0]);
    timers.run();
    await settle();
    expect(api.doc["chat_opacity"]).toBe(70);
    expect(base.getItem(UNSENT_KEY)).toBeNull();
    expect(timers.pending.size).toBe(0);
  });

  it("sends what waits at once when the page goes away", async () => {
    const { api, timers, storage, sync } = setup({});
    await sync.login();
    sync.leaving(); // nothing waits
    expect(api.puts).toEqual([]);
    storage.setItem("rpg.chat-opacity", "70");
    sync.leaving();
    // Started before the handler returns (fetch keepalive), not after the delay.
    expect(api.leavings).toBe(1);
    expect(api.puts).toEqual([{ v: 1, chat_opacity: 70, devices: { desktop: {} } }]);
    expect(timers.pending.size).toBe(0);
    await settle();
    sync.leaving();
    expect(api.puts.length).toBe(1);
  });

  it("what the login writes to localStorage is not a change of the player", async () => {
    const { api, timers, base, sync } = setup({});
    api.doc = { v: 1, lang: "es", hotkeys: { guardian: ["arc_bolt"] } };
    expect(await sync.login()).toBe(true);
    expect(base.getItem(UNSENT_KEY)).toBeNull();
    expect(timers.pending.size).toBe(0);
    expect(api.puts).toEqual([]);
  });

  it("does not fill an account with what another one left in the browser", async () => {
    const left = {
      "rpg.track": JSON.stringify({ Ana: "bounty_crawlers" }),
      "rpg.hotkeys.guardian": JSON.stringify(["arc_bolt"]),
      "rpg.controls": "classic",
      "rpg.chat-opacity": "70",
      [UNSENT_KEY]: JSON.stringify(["rpg.chat-opacity"]),
      [OWNER_KEY]: "tag-ana",
    };
    // Bob logs in on Ana's browser.
    const bob = setup(left);
    bob.api.account = "tag-bob";
    bob.api.doc = { v: 1, chat_opacity: 40 };
    expect(await bob.sync.login()).toBe(true);
    expect(bob.api.doc["track"]).toBeUndefined();
    expect(bob.api.doc["hotkeys"]).toBeUndefined();
    expect(bob.base.getItem("rpg.track")).toBeNull();
    expect(bob.base.getItem("rpg.hotkeys.guardian")).toBeNull();
    expect(bob.api.doc["chat_opacity"]).toBe(40); // Ana's unsent change is not his
    expect(bob.api.doc["controls"]).toBe("classic"); // nothing personal: it fills
    expect(bob.base.getItem(OWNER_KEY)).toBe("tag-bob");
    // His own choices stay his at the next login.
    bob.storage.setItem("rpg.hotkeys.guardian", JSON.stringify(["ember_ring"]));
    bob.timers.run();
    await settle();
    bob.sync.logout();
    await bob.sync.login();
    expect(bob.base.getItem("rpg.hotkeys.guardian")).toBe(JSON.stringify(["ember_ring"]));

    // Ana on her own browser: everything fills as before.
    const ana = setup(left);
    ana.api.doc = { v: 1, chat_opacity: 40 };
    await ana.sync.login();
    expect(ana.api.doc["track"]).toEqual({ Ana: "bounty_crawlers" });
    expect(ana.api.doc["hotkeys"]).toEqual({ guardian: ["arc_bolt"] });
    expect(ana.api.doc["chat_opacity"]).toBe(70);
  });

  it("a server without the route (404) leaves the browser alone", async () => {
    const { api, timers, base, storage, sync } = setup({ "rpg.lang": "en" });
    api.fail = Object.assign(new Error("api 404 not_found"), { status: 404, code: "not_found" });
    expect(await sync.login()).toBe(false);
    storage.setItem("rpg.chat-opacity", "70");
    sync.leaving();
    await sync.flush();
    await settle();
    expect(timers.pending.size).toBe(0); // nothing is sent, nothing is retried
    expect(api.puts).toEqual([]);
    expect(base.getItem("rpg.lang")).toBe("en");
    expect(base.getItem("rpg.chat-opacity")).toBe("70");
  });

  it("ready waits for the login under way, up to a limit", async () => {
    const { api, timers, base, sync } = setup({ "rpg.zoom": "5" });
    let done = false;
    await sync.ready(2000); // no login: at once
    api.doc = { v: 1, devices: { desktop: { zoom: 2 } } };
    let open: () => void = () => undefined;
    api.gate = new Promise((resolve) => (open = resolve));
    const login = sync.login();
    void sync.ready(2000).then(() => (done = true));
    await settle();
    expect(done).toBe(false); // the game does not open on the values about to be replaced
    expect(timers.delays).toEqual([2000]);
    open();
    await settle();
    expect(done).toBe(true);
    expect(base.getItem("rpg.zoom")).toBe("2");
    expect(timers.pending.size).toBe(0);
    await login;

    // A server that does not answer: the limit lets the player in.
    const slow = setup({});
    slow.api.gate = new Promise(() => undefined);
    void slow.sync.login();
    let late = false;
    void slow.sync.ready(2000).then(() => (late = true));
    await settle();
    expect(late).toBe(false);
    slow.timers.run();
    await settle();
    expect(late).toBe(true);
  });

  it("sends nothing before the login nor after the logout", async () => {
    const { api, timers, storage, sync } = setup({});
    storage.setItem("rpg.chat-opacity", "70");
    expect(timers.pending.size).toBe(0);
    await sync.login();
    api.puts.length = 0;
    storage.setItem("rpg.chat-opacity", "80");
    sync.logout();
    timers.run();
    await settle();
    await sync.flush();
    expect(api.puts).toEqual([]);
  });

  it("back from the game it sends what waits instead of taking the server's again", async () => {
    const { api, base, storage, sync } = setup({});
    await sync.login();
    storage.setItem("rpg.chat-opacity", "70"); // changed in the game, not sent yet
    expect(await sync.login()).toBe(false);
    expect(base.getItem("rpg.chat-opacity")).toBe("70");
    expect(api.doc["chat_opacity"]).toBe(70);
  });

  it("an unreachable server changes nothing and a later change tries again", async () => {
    const { api, timers, base, storage, sync } = setup({ "rpg.lang": "en" });
    api.fail = OFFLINE;
    expect(await sync.login()).toBe(false);
    expect(base.getItem("rpg.lang")).toBe("en");
    api.fail = undefined;
    api.doc = { v: 1, lang: "es" };
    expect(await sync.login()).toBe(true);
    api.fail = OFFLINE;
    storage.setItem("rpg.chat-opacity", "70");
    timers.run();
    await settle();
    api.fail = undefined;
    storage.setItem("rpg.chat-opacity", "75");
    timers.run();
    await settle();
    expect(api.doc).toEqual({ v: 1, lang: "es", chat_opacity: 75, devices: { desktop: {} } });
  });

  it("ignores a document that is not version 1", async () => {
    const { api, base, sync } = setup({ "rpg.lang": "en" });
    api.doc = { v: 9, lang: "es" } as unknown as OptionsDoc;
    await sync.login();
    expect(base.getItem("rpg.lang")).toBe("en");
  });
});

describe("helpers", () => {
  it("isSavedKey", () => {
    expect(isSavedKey("rpg.lang")).toBe(true);
    expect(isSavedKey("rpg.hotkeys.guardian")).toBe(true);
    expect(isSavedKey("rpg.stayedInFight")).toBe(false);
    expect(isSavedKey("rpg.safeMode")).toBe(false); // the server keeps it per character
  });

  it("stable ignores key order and undefined", () => {
    expect(stable({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe(
      stable({ a: [1, { d: 2 }], b: 1 }),
    );
  });
});
