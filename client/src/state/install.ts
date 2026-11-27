// Full screen and "install as an app" (owner, 2026-11-24; docs/15 "Pantalla completa e
// instalar como app"): what each platform can do, as pure rules, and the small state
// machine behind the two buttons. ui/AppMode.tsx feeds it the browser's events.
//
// | Platform                  | Fullscreen API | Install                               |
// | Chromium (Android, PC)    | yes            | beforeinstallprompt → prompt()        |
// | iPadOS Safari             | yes            | Share → "Add to Home Screen" (steps)  |
// | iPhone Safari and others  | no             | Share → "Add to Home Screen" (steps)  |
// | Firefox, others           | yes            | the browser's own menu (no button)    |
// | Installed (standalone)    | not needed     | already installed: no button          |
// | Tauri app                 | the window's   | it is the app: no button              |

export type Platform = "iphone" | "ipad" | "chromium" | "other";

/** The event pwa.ts sends on `window` when a new version of the app took over this page. */
export const UPDATE_EVENT = "rpg:app-update";

/**
 * Whether a service worker changing state means a new version: it activated on a page
 * another worker already controlled (the first install of a visit is not an update).
 */
export function isAppUpdate(workerState: string, hadController: boolean): boolean {
  return hadController && workerState === "activated";
}

/** What the page can read of where it runs. */
export interface PlatformEnv {
  userAgent: string;
  /** navigator.maxTouchPoints: iPadOS says it is a Mac, with touch points. */
  maxTouchPoints: number;
  /** navigator.standalone (iOS): launched from the home screen. */
  iosStandalone: boolean;
  /**
   * Launched as an installed app: display-mode standalone, or fullscreen on a touch device
   * (the manifest's display). A desktop browser in F11 also matches fullscreen and is not one.
   */
  displayStandalone: boolean;
  /** The document can go fullscreen (fullscreenEnabled, or WebKit's prefixed one). */
  fullscreenApi: boolean;
  /** Inside the Tauri app. */
  tauri: boolean;
}

export function detectPlatform(env: Pick<PlatformEnv, "userAgent" | "maxTouchPoints">): Platform {
  const ua = env.userAgent;
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1)) return "ipad";
  // Every browser on iOS is WebKit and matched above; Edge, Opera and Samsung say Chrome too.
  if (/Chrome\/|Chromium\//.test(ua)) return "chromium";
  return "other";
}

/**
 * Whether the display mode says "installed app". The manifest asks for fullscreen, which an
 * installed app gets on phones and tablets; a desktop one falls back to standalone, and a
 * desktop browser in F11 matches fullscreen too, so fullscreen counts only with a finger.
 */
export function displayStandalone(matches: (query: string) => boolean): boolean {
  return (
    matches("(display-mode: standalone)") ||
    (matches("(display-mode: fullscreen)") && matches("(pointer: coarse)"))
  );
}

/** Running as an installed app (or the desktop app): no browser chrome to lose. */
export function runsInstalled(
  env: Pick<PlatformEnv, "iosStandalone" | "displayStandalone" | "tauri">,
): boolean {
  return env.tauri || env.iosStandalone || env.displayStandalone;
}

/** What the page remembers between visits (state/touch-controls.ts). */
export interface AppModeMemory {
  /** The player closed the install offer: it stays in Options only. */
  installDismissed: boolean;
  /** The player asked for full screen: offered again after the browser leaves it. */
  fullscreenWanted: boolean;
}

export interface AppModeState {
  platform: Platform;
  /** The app is installed: launched as one, or installed from this tab a moment ago. */
  installed: boolean;
  /**
   * This page runs as the installed app (no browser chrome to lose). A tab that has just
   * installed the app is still a tab: it keeps its fullscreen button.
   */
  standalone: boolean;
  fullscreenApi: boolean;
  /** Chromium fired beforeinstallprompt and the event is kept: prompt() can be called. */
  promptReady: boolean;
  /** The document is fullscreen now. */
  fullscreen: boolean;
  memory: AppModeMemory;
}

export type AppModeEvent =
  | { kind: "beforeinstallprompt" }
  /** The prompt was shown: Chromium lets an event prompt once. */
  | { kind: "prompted"; accepted: boolean }
  | { kind: "appinstalled" }
  | { kind: "dismissInstall" }
  | { kind: "fullscreenchange"; active: boolean }
  /** The player pressed the fullscreen button (entering or leaving on purpose). */
  | { kind: "fullscreenAsked"; on: boolean };

export function initialAppMode(env: PlatformEnv, memory: AppModeMemory): AppModeState {
  const platform = detectPlatform(env);
  return {
    platform,
    installed: runsInstalled(env),
    standalone: runsInstalled(env),
    // The Tauri window is the desktop app's business. An iPhone has no fullscreen for
    // pages (only for video), whatever its WebKit answers: never a button that does nothing.
    fullscreenApi: env.fullscreenApi && !env.tauri && platform !== "iphone",
    promptReady: false,
    fullscreen: false,
    memory,
  };
}

export function appModeReduce(s: AppModeState, e: AppModeEvent): AppModeState {
  switch (e.kind) {
    case "beforeinstallprompt":
      return s.installed ? s : { ...s, promptReady: true };
    case "prompted":
      // Accepted: appinstalled follows. Refused: the player said no, so no nagging.
      return {
        ...s,
        promptReady: false,
        memory: e.accepted ? s.memory : { ...s.memory, installDismissed: true },
      };
    case "appinstalled":
      return { ...s, installed: true, promptReady: false };
    case "dismissInstall":
      return { ...s, memory: { ...s.memory, installDismissed: true } };
    case "fullscreenchange":
      return { ...s, fullscreen: e.active };
    case "fullscreenAsked":
      return { ...s, memory: { ...s.memory, fullscreenWanted: e.on } };
  }
}

/** How the install button works here: the browser's prompt, the iOS steps, or no button. */
export type InstallOffer = "prompt" | "ios-steps" | "none";

/**
 * The install button. `where`: the login and character screens only offer it until it is
 * dismissed; Options always has it while installing is possible.
 */
export function installOffer(s: AppModeState, where: "screen" | "options"): InstallOffer {
  if (s.installed) return "none";
  if (where === "screen" && s.memory.installDismissed) return "none";
  if (s.platform === "iphone" || s.platform === "ipad") return "ios-steps";
  return s.promptReady ? "prompt" : "none";
}

/**
 * The fullscreen button: enter, leave, or, where pages cannot go fullscreen (iPhone), the
 * hint that only the installed app loses the address bar. Nothing when running installed:
 * an installed app already has no browser chrome.
 */
export type FullscreenOffer = "enter" | "exit" | "install-hint" | "none";

export function fullscreenOffer(s: AppModeState): FullscreenOffer {
  if (s.fullscreen) return "exit";
  if (s.standalone) return "none";
  if (s.fullscreenApi) return "enter";
  return s.platform === "iphone" ? "install-hint" : "none";
}

/**
 * Whether to offer fullscreen again without being asked: the player wanted it and the
 * browser left it (a rotation, the back gesture, a reload). Entering needs a user
 * gesture, so the page can only offer.
 */
export function fullscreenReoffer(s: AppModeState): boolean {
  return s.memory.fullscreenWanted && fullscreenOffer(s) === "enter";
}
