import { describe, expect, it } from "vitest";
import { DisconnectReason } from "@rpg/protocol";
import { STAYED_KEY, STAYED_SHOW_MS, rememberStayed, staysAfter, takeStayed } from "./stayed.ts";

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

describe('"stayed in the world" after closing the game in a fight', () => {
  it("is read once, while it is recent", () => {
    const s = memory();
    rememberStayed(s, { name: "Runner", at: 1000 });
    expect(takeStayed(s, 5000)).toEqual({ name: "Runner", at: 1000 });
    expect(takeStayed(s, 5000)).toBeUndefined();
    rememberStayed(s, { name: "Runner", at: 1000 });
    expect(takeStayed(s, 1000 + STAYED_SHOW_MS + 1)).toBeUndefined();
    expect(s.getItem(STAYED_KEY)).toBeNull();
  });

  it("ignores a broken note and a blocked storage", () => {
    const s = memory();
    s.setItem(STAYED_KEY, "{not json");
    expect(takeStayed(s, 0)).toBeUndefined();
    s.setItem(STAYED_KEY, JSON.stringify({ name: 3 }));
    expect(takeStayed(s, 0)).toBeUndefined();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(() => rememberStayed(blocked, { name: "A", at: 0 })).not.toThrow();
    expect(takeStayed(blocked, 0)).toBeUndefined();
    expect(takeStayed(undefined, 0)).toBeUndefined();
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
