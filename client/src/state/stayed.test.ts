import { describe, expect, it } from "vitest";
import { DisconnectReason } from "@rpg/protocol";
import {
  STAYED_KEY,
  STAYED_LIVE_MS,
  STAYED_SHOW_MS,
  endNotice,
  rememberStayed,
  stayedText,
  staysAfter,
  takeStayed,
  watchLeaving,
} from "./stayed.ts";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

describe('"stayed in the world" after closing the game in a fight', () => {
  it("is read once, while it is recent, by the session that owns the character", () => {
    const s = memory();
    rememberStayed(s, { name: "Runner", at: 1000 });
    expect(takeStayed(s, 5000, ["Runner"])).toEqual([{ name: "Runner", at: 1000 }]);
    expect(takeStayed(s, 5000, ["Runner"])).toEqual([]);
    rememberStayed(s, { name: "Runner", at: 1000 });
    expect(takeStayed(s, 1000 + STAYED_SHOW_MS + 1, ["Runner"])).toEqual([]);
    expect(s.getItem(STAYED_KEY)).toBeNull();
  });

  it("keeps a note per character, and one of another account's character for its owner", () => {
    const s = memory();
    // Two tabs of one account (two characters online at once), and a stranger's note.
    rememberStayed(s, { name: "Runner", at: 1000 });
    rememberStayed(s, { name: "Second", at: 2000 });
    rememberStayed(s, { name: "Stranger", at: 2500 });
    rememberStayed(s, { name: "Runner", at: 3000 }); // again: over its older note
    // No session yet (the login screen knows no character): nothing is shown or lost.
    expect(takeStayed(s, 4000, [])).toEqual([]);
    expect(takeStayed(s, 4000, ["Second", "Runner", "Other"])).toEqual([
      { name: "Second", at: 2000 },
      { name: "Runner", at: 3000 },
    ]);
    expect(takeStayed(s, 4000, ["Stranger"])).toEqual([{ name: "Stranger", at: 2500 }]);
    expect(s.getItem(STAYED_KEY)).toBeNull();
  });

  it("reads a single note as first written", () => {
    const s = memory();
    s.setItem(STAYED_KEY, JSON.stringify({ name: "Runner", at: 1000 }));
    expect(takeStayed(s, 2000, ["Runner"])).toEqual([{ name: "Runner", at: 1000 }]);
  });

  it("promises a takeover only while the character may still be in the world", () => {
    const note = { name: "Runner", at: 1000 };
    expect(stayedText(t, note, 1000 + STAYED_LIVE_MS)).toBe(
      'client.characters.stayed_in_fight{"name":"Runner"}',
    );
    expect(stayedText(t, note, 1000 + STAYED_LIVE_MS + 1)).toBe(
      'client.characters.stayed_in_fight_earlier{"name":"Runner"}',
    );
    expect(STAYED_LIVE_MS).toBeLessThan(STAYED_SHOW_MS);
  });

  it("ignores a broken note and a blocked storage", () => {
    const s = memory();
    s.setItem(STAYED_KEY, "{not json");
    expect(takeStayed(s, 0, ["A"])).toEqual([]);
    s.setItem(STAYED_KEY, JSON.stringify({ name: 3 }));
    expect(takeStayed(s, 0, ["A"])).toEqual([]);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => rememberStayed(blocked, { name: "A", at: 0 })).not.toThrow();
    expect(takeStayed(blocked, 0, ["A"])).toEqual([]);
    expect(takeStayed(undefined, 0, ["A"])).toEqual([]);
  });

  it("writes the note on pagehide only in a fight, until it stops watching", () => {
    const s = memory();
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
      removeEventListener: (type: string, fn: () => void) => {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
    let fighting = false;
    const stop = watchLeaving(
      target,
      () => fighting,
      s,
      "Runner",
      () => 7000,
    );
    listeners.get("pagehide")?.();
    expect(s.getItem(STAYED_KEY)).toBeNull(); // out of a fight the character just leaves
    fighting = true;
    listeners.get("pagehide")?.();
    expect(takeStayed(s, 7001, ["Runner"])).toEqual([{ name: "Runner", at: 7000 }]);
    stop();
    expect(listeners.has("pagehide")).toBe(false);
  });

  it("adds it to the notice of a game that ended in a fight and kept the character", () => {
    const stayed = 'Lost. client.characters.stayed_in_fight{"name":"Runner"}';
    expect(endNotice(t, "Lost.", undefined, true, "Runner")).toBe(stayed);
    expect(endNotice(t, "Lost.", DisconnectReason.PASSWORD_CHANGED, true, "Runner")).toBe(stayed);
    expect(endNotice(t, "Lost.", undefined, false, "Runner")).toBe("Lost.");
    expect(endNotice(t, "Kicked.", DisconnectReason.KICKED, true, "Runner")).toBe("Kicked.");
  });

  it("knows which ends leave the character link-dead in a fight", () => {
    for (const r of [
      undefined,
      DisconnectReason.UNSPECIFIED,
      DisconnectReason.SLOW_CLIENT,
      DisconnectReason.RATE_LIMITED,
      DisconnectReason.PASSWORD_CHANGED,
      DisconnectReason.SIGNED_OUT_EVERYWHERE,
    ]) {
      expect(staysAfter(r)).toBe(true);
    }
    for (const r of [
      DisconnectReason.LOGGED_OUT,
      DisconnectReason.LOGGED_IN_ELSEWHERE,
      DisconnectReason.KICKED,
      DisconnectReason.BANNED,
      DisconnectReason.SERVER_SHUTDOWN,
      DisconnectReason.SAVE_FAILED,
    ]) {
      expect(staysAfter(r)).toBe(false);
    }
  });
});
