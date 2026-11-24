import { describe, expect, it } from "vitest";
import {
  CHAT_OPACITY,
  TEXT_SCALES,
  UI_SCALES,
  applyChatOpacity,
  applyScales,
  clampChatOpacity,
  loadChatOpacity,
  saveChatOpacity,
  loadCameraShake,
  loadChatBubbles,
  loadNameSize,
  loadReducedMotion,
  loadTextScale,
  loadUiScale,
  nearestScale,
  saveCameraShake,
  saveChatBubbles,
  saveNameSize,
  saveReducedMotion,
  saveTextScale,
  saveUiScale,
} from "./ui-prefs.ts";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

describe("reduced animations", () => {
  it("is off until chosen, and remembered", () => {
    const s = memory();
    expect(loadReducedMotion(s)).toBe(false);
    saveReducedMotion(true, s);
    expect(loadReducedMotion(s)).toBe(true);
    saveReducedMotion(false, s);
    expect(loadReducedMotion(s)).toBe(false);
  });

  it("survives a blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadReducedMotion(blocked)).toBe(false);
    expect(() => saveReducedMotion(true, blocked)).not.toThrow();
    expect(loadReducedMotion(undefined)).toBe(false);
  });
});

describe("interface scale, text size and camera shake (docs/17 UI-3, UI-9)", () => {
  it("offers the text sizes docs/17 asks for: 90 % to 130 %", () => {
    expect(Math.min(...TEXT_SCALES)).toBe(0.9);
    expect(Math.max(...TEXT_SCALES)).toBe(1.3);
    expect(UI_SCALES).toContain(1);
  });

  it("remembers each choice and brings anything else to the closest offered", () => {
    const s = memory();
    expect(loadUiScale(s)).toBe(1);
    expect(loadTextScale(s)).toBe(1);
    saveUiScale(1.25, s);
    saveTextScale(1.3, s);
    expect(loadUiScale(s)).toBe(1.25);
    expect(loadTextScale(s)).toBe(1.3);
    s.setItem("rpg.ui-scale", "7");
    expect(loadUiScale(s)).toBe(1.5);
    s.setItem("rpg.text-scale", "nonsense");
    expect(loadTextScale(s)).toBe(1);
    expect(nearestScale(1.12, TEXT_SCALES)).toBe(1.15);
    expect(loadUiScale(undefined)).toBe(1);
  });

  it("shakes the camera unless turned off", () => {
    const s = memory();
    expect(loadCameraShake(s)).toBe(true);
    saveCameraShake(false, s);
    expect(loadCameraShake(s)).toBe(false);
    saveCameraShake(true, s);
    expect(loadCameraShake(s)).toBe(true);
  });

  it("remembers the speech bubbles over the heads, on by default (docs/17 UI-11)", () => {
    const s = memory();
    expect(loadChatBubbles(s)).toBe(true);
    expect(loadChatBubbles(undefined)).toBe(true);
    saveChatBubbles(false, s);
    expect(loadChatBubbles(s)).toBe(false);
    saveChatBubbles(true, s);
    expect(loadChatBubbles(s)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadChatBubbles(broken)).toBe(true);
  });

  it("puts the scales on the page, and takes them off at 100 %", () => {
    const props = new Map<string, string>();
    const root = {
      style: {
        setProperty: (k: string, v: string | null) => void props.set(k, v ?? ""),
        removeProperty: (k: string) => {
          props.delete(k);
          return "";
        },
      },
    };
    applyScales(root, 1.25, 1.15);
    expect(Object.fromEntries(props)).toEqual({ "--ui-zoom": "1.25", "--ui-text-scale": "1.15" });
    applyScales(root, 1, 1);
    expect(props.size).toBe(0);
  });
});

describe("the chat's opacity (docs/17 UI-10)", () => {
  it("is 30 to 100 %, 50 % until the player picks one", () => {
    const s = memory();
    expect(CHAT_OPACITY.min).toBe(30);
    expect(CHAT_OPACITY.max).toBe(100);
    expect(loadChatOpacity(s)).toBe(50);
    saveChatOpacity(75, s);
    expect(s.getItem("rpg.chat-opacity")).toBe("75");
    expect(loadChatOpacity(s)).toBe(75);
    s.setItem("rpg.chat-opacity", "5");
    expect(loadChatOpacity(s)).toBe(30);
    s.setItem("rpg.chat-opacity", "nonsense");
    expect(loadChatOpacity(s)).toBe(50);
    expect(clampChatOpacity(83)).toBe(85);
    expect(clampChatOpacity(140)).toBe(100);
  });

  it("survives a storage that throws (private mode, blocked site data)", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadChatOpacity(broken)).toBe(50);
    expect(() => saveChatOpacity(80, broken)).not.toThrow();
    expect(loadChatOpacity(undefined)).toBe(50);
  });

  it("puts it on the page as a fraction, and takes it off at the initial 50 %", () => {
    const props = new Map<string, string>();
    const root = {
      style: {
        setProperty: (k: string, v: string | null) => void props.set(k, v ?? ""),
        removeProperty: (k: string) => {
          props.delete(k);
          return "";
        },
      },
    };
    applyChatOpacity(root, 80);
    expect(Object.fromEntries(props)).toEqual({ "--chat-opacity": "0.8" });
    applyChatOpacity(root, 50);
    expect(props.size).toBe(0);
  });
});

describe("the name size (docs/17 UI-3)", () => {
  it("is large unless the player picked normal", () => {
    const st = memory();
    expect(loadNameSize(st)).toBe("large");
    expect(loadNameSize(undefined)).toBe("large");
    saveNameSize("normal", st);
    expect(loadNameSize(st)).toBe("normal");
    saveNameSize("large", st);
    expect(loadNameSize(st)).toBe("large");
  });

  it("ignores a value it does not know and storage that throws", () => {
    const st = memory();
    st.setItem("rpg.name-size", "huge");
    expect(loadNameSize(st)).toBe("large");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadNameSize(broken)).toBe("large");
    expect(() => saveNameSize("normal", broken)).not.toThrow();
  });
});
