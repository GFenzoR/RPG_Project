import { describe, expect, it } from "vitest";
import {
  displayStandalone,
  appModeReduce,
  detectPlatform,
  fullscreenOffer,
  fullscreenReoffer,
  initialAppMode,
  installOffer,
  isAppUpdate,
  runsInstalled,
} from "./install.ts";
import type { AppModeMemory, AppModeState, PlatformEnv } from "./install.ts";

const UA = {
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  desktopChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
};

const env = (over: Partial<PlatformEnv>): PlatformEnv => ({
  userAgent: UA.android,
  maxTouchPoints: 5,
  iosStandalone: false,
  displayStandalone: false,
  fullscreenApi: true,
  tauri: false,
  ...over,
});
const fresh: AppModeMemory = { installDismissed: false, fullscreenWanted: false };
const start = (over: Partial<PlatformEnv>, memory: AppModeMemory = fresh): AppModeState =>
  initialAppMode(env(over), memory);

describe("detectPlatform", () => {
  it("tells the platforms apart", () => {
    expect(detectPlatform({ userAgent: UA.android, maxTouchPoints: 5 })).toBe("chromium");
    expect(detectPlatform({ userAgent: UA.desktopChrome, maxTouchPoints: 0 })).toBe("chromium");
    expect(detectPlatform({ userAgent: UA.iphone, maxTouchPoints: 5 })).toBe("iphone");
    expect(detectPlatform({ userAgent: UA.iphoneChrome, maxTouchPoints: 5 })).toBe("iphone");
    // iPadOS says it is a Mac; a real Mac has no touch points.
    expect(detectPlatform({ userAgent: UA.ipad, maxTouchPoints: 5 })).toBe("ipad");
    expect(detectPlatform({ userAgent: UA.ipad, maxTouchPoints: 0 })).toBe("other");
    expect(detectPlatform({ userAgent: UA.firefox, maxTouchPoints: 0 })).toBe("other");
  });
});

describe("isAppUpdate", () => {
  it("is a new worker activating on a page that already had one", () => {
    expect(isAppUpdate("activated", true)).toBe(true);
    expect(isAppUpdate("activated", false)).toBe(false); // the first install of a visit
    expect(isAppUpdate("installed", true)).toBe(false);
    expect(isAppUpdate("redundant", true)).toBe(false);
  });
});

describe("runsInstalled", () => {
  it("is true from the home screen, as an installed app or in the desktop app", () => {
    const no = { iosStandalone: false, displayStandalone: false, tauri: false };
    expect(runsInstalled(no)).toBe(false);
    expect(runsInstalled({ ...no, iosStandalone: true })).toBe(true);
    expect(runsInstalled({ ...no, displayStandalone: true })).toBe(true);
    expect(runsInstalled({ ...no, tauri: true })).toBe(true);
  });
});

describe("the install button", () => {
  it("Chromium: only once beforeinstallprompt arrived, and gone after appinstalled", () => {
    let s = start({});
    expect(installOffer(s, "screen")).toBe("none");
    s = appModeReduce(s, { kind: "beforeinstallprompt" });
    expect(installOffer(s, "screen")).toBe("prompt");
    expect(installOffer(s, "options")).toBe("prompt");
    s = appModeReduce(s, { kind: "prompted", accepted: true });
    expect(installOffer(s, "options")).toBe("none"); // an event prompts once
    s = appModeReduce(s, { kind: "appinstalled" });
    expect(s.installed).toBe(true);
    expect(installOffer(s, "screen")).toBe("none");
    // The tab that installed it is still a tab: it keeps its fullscreen button.
    expect(fullscreenOffer(s)).toBe("enter");
    // A late beforeinstallprompt does not bring it back.
    s = appModeReduce(s, { kind: "beforeinstallprompt" });
    expect(installOffer(s, "options")).toBe("none");
  });

  it("refusing the browser's prompt counts as dismissing the offer", () => {
    let s = appModeReduce(start({}), { kind: "beforeinstallprompt" });
    s = appModeReduce(s, { kind: "prompted", accepted: false });
    expect(s.memory.installDismissed).toBe(true);
    // Chromium may fire the event again later: Options offers it, the screens do not nag.
    s = appModeReduce(s, { kind: "beforeinstallprompt" });
    expect(installOffer(s, "screen")).toBe("none");
    expect(installOffer(s, "options")).toBe("prompt");
  });

  it("iPhone and iPad: the illustrated steps, with no event to wait for", () => {
    expect(installOffer(start({ userAgent: UA.iphone, fullscreenApi: false }), "screen")).toBe(
      "ios-steps",
    );
    expect(installOffer(start({ userAgent: UA.ipad }), "options")).toBe("ios-steps");
  });

  it("dismissed: remembered on the screens, still in Options", () => {
    let s = start({ userAgent: UA.iphone, fullscreenApi: false });
    s = appModeReduce(s, { kind: "dismissInstall" });
    expect(installOffer(s, "screen")).toBe("none");
    expect(installOffer(s, "options")).toBe("ios-steps");
    const again = start(
      { userAgent: UA.iphone, fullscreenApi: false },
      { installDismissed: true, fullscreenWanted: false },
    );
    expect(installOffer(again, "screen")).toBe("none");
  });

  it("no button when already installed, in the desktop app, or where no install exists", () => {
    expect(installOffer(start({ userAgent: UA.iphone, iosStandalone: true }), "options")).toBe(
      "none",
    );
    expect(installOffer(start({ displayStandalone: true }), "options")).toBe("none");
    expect(installOffer(start({ userAgent: UA.desktopChrome, tauri: true }), "options")).toBe(
      "none",
    );
    expect(installOffer(start({ userAgent: UA.firefox }), "options")).toBe("none");
  });
});

describe("the fullscreen button", () => {
  it("enters and leaves where the API exists", () => {
    let s = start({});
    expect(fullscreenOffer(s)).toBe("enter");
    s = appModeReduce(s, { kind: "fullscreenchange", active: true });
    expect(fullscreenOffer(s)).toBe("exit");
    s = appModeReduce(s, { kind: "fullscreenchange", active: false });
    expect(fullscreenOffer(s)).toBe("enter");
    expect(fullscreenOffer(start({ userAgent: UA.ipad }))).toBe("enter");
    expect(fullscreenOffer(start({ userAgent: UA.desktopChrome, maxTouchPoints: 0 }))).toBe(
      "enter",
    );
  });

  it("iPhone has no fullscreen for pages: the install hint instead of a dead button", () => {
    expect(fullscreenOffer(start({ userAgent: UA.iphone, fullscreenApi: false }))).toBe(
      "install-hint",
    );
    // Even if its WebKit says the API is there (it is for video only).
    expect(fullscreenOffer(start({ userAgent: UA.iphone, fullscreenApi: true }))).toBe(
      "install-hint",
    );
  });

  it("shows nothing installed or in the desktop app, nor without an API elsewhere", () => {
    expect(fullscreenOffer(start({ displayStandalone: true }))).toBe("none");
    expect(fullscreenOffer(start({ userAgent: UA.iphone, iosStandalone: true }))).toBe("none");
    expect(fullscreenOffer(start({ userAgent: UA.desktopChrome, tauri: true }))).toBe("none");
    expect(fullscreenOffer(start({ userAgent: UA.firefox, fullscreenApi: false }))).toBe("none");
  });

  it("is remembered and offered again after the browser leaves it", () => {
    let s = start({});
    expect(fullscreenReoffer(s)).toBe(false);
    s = appModeReduce(s, { kind: "fullscreenAsked", on: true });
    s = appModeReduce(s, { kind: "fullscreenchange", active: true });
    expect(fullscreenReoffer(s)).toBe(false); // in it
    s = appModeReduce(s, { kind: "fullscreenchange", active: false }); // a rotation, back
    expect(fullscreenReoffer(s)).toBe(true);
    s = appModeReduce(s, { kind: "fullscreenAsked", on: false }); // left on purpose
    expect(fullscreenReoffer(s)).toBe(false);
    // The next visit starts out of fullscreen with the wish remembered.
    expect(fullscreenReoffer(start({}, { installDismissed: false, fullscreenWanted: true }))).toBe(
      true,
    );
    expect(
      fullscreenReoffer(
        start(
          { userAgent: UA.iphone, fullscreenApi: false },
          { installDismissed: false, fullscreenWanted: true },
        ),
      ),
    ).toBe(false);
  });
});

describe("the display mode of an installed app", () => {
  const media =
    (...on: string[]) =>
    (q: string) =>
      on.includes(q);

  it("standalone always; fullscreen only on a touch device (a desktop browser in F11 is a page)", () => {
    expect(displayStandalone(media("(display-mode: standalone)"))).toBe(true);
    expect(displayStandalone(media("(display-mode: fullscreen)", "(pointer: coarse)"))).toBe(true);
    expect(displayStandalone(media("(display-mode: fullscreen)"))).toBe(false);
    expect(displayStandalone(media("(pointer: coarse)"))).toBe(false);
  });
});
